/**
 * Step 17's devolução arm (#1525) through the Cloud Tasks hop, end to end,
 * against the real emulators (`ci-shopee.yml`) — the EIGHTH `*.tasks.test.ts`
 * of this codebase, the fourth to drive the NOTIFICATION queue, and the FIRST
 * to write business documents IN-PROCESS against the emulator's Firestore
 * (reconcile §4, RT-1 … RT-4).
 *
 * What runs for real here, with nothing mocked — three queue hops:
 *
 *   RT-1  POST /api/webhooks/shopee         the real route + the real push HMAC,
 *                                           a `push 32`-shaped body
 *     → createShopeeTaskScheduler().enqueue()  the real region-qualified queue
 *     → Cloud Tasks emulator → Functions emulator
 *     → processShopeeNotification           the real deployed onTaskDispatched
 *     → DISPATCH[29] === 'devolucao'        the EIGHTH DestinoPush
 *     → await import('../devolucoes/pushDevolucao')   the parser, BEFORE the conta
 *     → findIntegracaoByShopId → null       ⇒ `sem-conta` ⇒ a real `deferred` doc
 *
 *   RT-2  notificacaoSinteticaDeDevolucao(…, 'acao-vendedor')  the route's builder
 *     → the same queue → the same function → the parser, the seeded conta
 *     → defaultProcessDeps.importarDevolucao  the arm's lazy default:
 *         await import('../devolucoes/importarDevolucao')  resolves in the BUILT
 *                                           artifact before the handler runs
 *     → the cheap pedido read               the seeded pedido EXISTS
 *     → loadShopeeContext → createShopClient → getReturnDetail
 *     → signedCall awaits getAccessToken   no credential document
 *     → ShopeeSemCredencialError           BEFORE any fetch
 *     → disposicaoDaFalhaDeDevolucao        `defer`, prefix `devolucao:`
 *
 *   RT-3  notificacaoSinteticaDeDevolucao(…, 'reconciliacao')  the poller's
 *                                           builder, day-floored stamp
 *     → … the seeded conta, NO pedido      ⇒ ZERO Shopee calls
 *     → ONE notificacaoSinteticaDePedido(origem 'devolucao', carimboDoDiaUtcMs)
 *       enqueued FROM INSIDE the dispatched function onto the same queue
 *     → `devolucao-adiada` (a real `deferred` code-29 row naming the enqueue)
 *     → the code-3 arm → importarPedidoShopee → ShopeeSemCredencialError
 *     → `pedido-adiado` (a real `deferred` code-3 row at the DAY stamp)
 *
 * …and one in-process round trip that no queue hop can reach offline:
 *
 *   RT-4  importarDevolucaoShopee(…, { clientFor: a stub })  in THIS process,
 *         against the emulator's Firestore, real transaction, real
 *         `FieldValue.increment`, real `escreverAviso` / `resolverAviso`:
 *         `criado` → identical replay → the lost-aviso replay → older →
 *         equal-and-different → newer.
 *
 * ⚠️ NO new job, NO new check name, NO new row in the gate manifest: the
 * `.tasks.test.ts` suffix alone puts this file in the ONE `Shopee Cloud Tasks
 * round trip` job (`vitest.tasks.config.ts` includes it, `vitest.config.ts`
 * excludes it). Run it locally exactly as the lane does, from the REPO ROOT and
 * with the job's env (`.github/workflows/ci-shopee.yml`, job
 * `shopee-tasks-roundtrip`: `FUNCTIONS_REGION` equal to `SHOPEE_TASKS_REGION`,
 * the invented partner id/key, `SHOPEE_PUSH_CALLBACK_URL`,
 * `REQUIRE_EMULATOR=1`): `node apps/shopee/functions/scripts/prepare-deploy.mjs`
 * (the artifact the functions emulator loads — `predeploy` does not run under
 * `emulators:exec`), then `firebase emulators:exec --config
 * firebase.shopee.tasks.json --project demo-erp --only firestore,functions,tasks
 * "pnpm --fail-if-no-match --filter @delfrance/shopee-app run test:tasks"`.
 *
 * ⚠️ Why the queue hops stop at the token, and why RT-4 is IN-PROCESS. The
 * lane's non-localhost `fetch` kill-switch lives in the VITEST process and does
 * NOT cover the dispatched function, which runs in the emulator's own process
 * (`vitest.tasks.setup.ts` (4)), and `shopeeHosts()` has no stub override — so a
 * dispatched path that reached `get_return_detail` would really leave the
 * runner. The token is part of the signed query, so the package awaits
 * `getAccessToken()` before it builds a request, and with no
 * `credenciais/current` that read throws: zero Shopee calls by CALL ORDER,
 * never by a mock. Everything AFTER the pull — the mapping, the transaction,
 * the aviso — is what RT-4 drives, in this process, where the client is a stub
 * and the kill-switch does cover `fetch`.
 *
 * What this proves that no offline test can:
 *
 *   (a) the DISPATCHED BUNDLE carries `DISPATCH[29] = 'devolucao'`. Code 29 had
 *       a `MOTIVO_PARADO` row before step 17, so a stale artifact PARKS RT-1's
 *       delivery where a current one defers it — `parked` ≠ `deferred` is the
 *       whole assertion. And the parser chunk resolves: the arm imports it
 *       BEFORE `findIntegracaoByShopId`, so even the unmapped shop loads it.
 *   (b) BOTH dynamic imports of the arm resolve in the built artifact (RT-2): a
 *       chunk the bundler failed to carry THROWS, and a throw is the queue's
 *       retry ladder — nothing is persisted until the LAST attempt, after this
 *       poll's deadline. So that failure surfaces as the poll's timeout, or as
 *       `failed`, never as `deferred` with `tentativas: 0`.
 *   (c) both synthetic BUILDERS' bodies survive a JSON round trip across Cloud
 *       Tasks and are what the push reader accepts (a refused body PARKS), and
 *       `order_sn` keeps its underscore end to end.
 *   (d) the REASON is the discriminator (RT-2 vs RT-3): a missing pedido and a
 *       missing credential both defer, so `deferred` alone proves nothing. Each
 *       expected reason is computed by the SAME classifier the arm runs, or
 *       pinned by the fixed text only the "no pedido" branch writes.
 *   (e) the code-29 → code-3 bridge (RT-3): the dispatched function enqueues
 *       from INSIDE the emulator, onto the same queue, with the DAY stamp — so
 *       the code-3 row lands at `3:<shop>:<order_sn>:<UTC day start>`, the
 *       bound that keeps the deferred lane's daily re-drives at ONE code-3 row
 *       per order per day.
 *   (f) rule 7 tier 2 on a REAL engine (RT-4): the watermark
 *       `relogioProvedorUs`, the byte-identical replay (the document's
 *       `updateTime` does NOT move), the older delivery (zero writes), the
 *       equal-clock-different-content write (`revisao` 2), the watermark-only
 *       advance; `tx.update` + `parseMerge` leaving operator turf alone; and the
 *       aviso opened, left alone by the replay, RE-OPENED by the replay that
 *       follows a lost aviso write (the transaction committed, the effect did
 *       not), resolved by the close. Every aviso clock is pinned by VALUE
 *       (`relogioProvedorUs + revisao`), never through the function that
 *       builds it.
 *
 * ⚠️ NOT covered, and deliberately not asserted:
 *   - the overlay (`devolucaoAbertaEm`): its trigger is the `storage` codebase,
 *     which `firebase.shopee.tasks.json` does not load (RT-9 is offline);
 *   - the absence of a second code 3 in RT-3 — an absence cannot be polled
 *     honestly; the one-call-site bound is pinned in `importarDevolucao.test.ts`;
 *   - the poller and the action route — `devolucoesSweep.test.ts` (RT-6) and
 *     the route tests (RT-7) drive them on the fakeDb;
 *   - `retryConfig` / `rateLimits` — asserted off `__endpoint` in
 *     `../../../functions/src/processNotification.test.ts`.
 *
 * ⚠️ WHICH conta id, and why it is not `int-1`, `int-2` or `int-3`. The conta
 * read is a 15-minute read cache in the DISPATCHED process
 * (`../core/contaCache.ts`), and a Shopee conta WITH a `shop_id` is a fresh
 * entry. `int-1`/`int-2` are seeded by two later suites with the WRONG `tipo` or
 * NO `shop_id`, each relying on that refusal to stay offline — a cached Shopee
 * copy from here would lift exactly that barrier — and `int-3` is
 * `../pedidos/arranjoAutomatico.tasks.test.ts`'s. So this suite owns `int-4`,
 * and an `afterEach` removes everything it seeds: an ACTIVE Shopee conta left in
 * the emulator is one any later sweep suite would enumerate. RT-2 and RT-3 seed
 * it under DIFFERENT shops; `findIntegracaoByShopId`'s cross-check evicts the
 * cached copy whose `shop_id` disagrees, which is what keeps the second test
 * honest in a warm function process.
 *
 * ⚠️ The clock. This file reads the wall clock for TEST-LOCAL purposes only:
 * the envelope stamp it signs (RT-1), the synthesis moment it hands the
 * builders (RT-2/RT-3 — the route's and the poller's one read), the delivery
 * clock it hands the in-process importer (RT-4), and the poll's own deadline.
 * None is a production clock read: the arm takes its instant from the
 * pipeline's injectable clock, and `devolucoes/` reads none.
 *
 * ⚠️ Fixture ids only, and none of them is real: `int-4`, the step-5 fixture
 * order `260910KJBHUJDM`, the return_sns `260910ABCDE0001` (ALPHANUMERIC, like
 * every sample on Shopee's returns pages) and `2609100000000001`; the shop is a
 * random `7xxxxx` per test — disjoint from the arrange suite's `8xxxxx` and the
 * receiver/listing suites' `9xxxxx`, so no run of theirs can map to the conta
 * seeded here. The return detail is the redacted corpus body
 * (`../fixtures/__wire__/get_return_detail.doc.json`) through the package's
 * STRIP schema — no buyer field reaches this process, let alone the emulator.
 * No token, no credential and no real shop appears anywhere.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  avisoCollection,
  credenciaisIntegracaoCollection,
  incidenteCollection,
  integracaoCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import type {
  ShopeeReturnDetail,
  ShopeeReturnDetailEnvelope,
} from '@delfrance/integrations-shopee';
import {
  ESTADO_PEDIDO,
  INTEGRACAO_TIPO,
  ORIGEM_INCIDENTE,
  STATUS_CLAIM,
  TIPO_INCIDENTE,
} from '@delfrance/schemas';

import { POST, __resetContadorDeEntregasParaTestes } from '../../../app/api/webhooks/shopee/route';
import { getAdminFirestore } from '../../firebase/admin';
import { SHOPEE_CREDENCIAL_DOC_ID } from '../core/credentialStore';
import { ShopeeSemCredencialError } from '../core/tokenStore';
import { shopeeConfig, shopeePushCallbackUrl } from '../env';
import { FIXTURE_RETURN_DETAIL_DOC, lerDevolucaoDetalhe } from '../fixtures/wireCorpus';
import {
  dedupKeyOf,
  destinoDoCodigo,
  disposicaoDaFalhaDeDevolucao,
  disposicaoDaFalhaDeImportacao,
  docIdOf,
  type ShopeeNotificationPayload,
} from '../notificacoes/notificacao';
import {
  carimboDoDiaUtcMs,
  notificacaoSinteticaDeDevolucao,
  notificacaoSinteticaDePedido,
} from '../notificacoes/notificacaoSintetica';
import { expectedPushSignature } from '../notificacoes/pushSignature';
import { makePedidoIdShopee } from '../pedidos/orderIds';
import { microsDeSegundosShopee } from '../pedidos/orderMapping';
import { createShopeeTaskScheduler, shopeeTasksDesabilitado } from '../shopeeTasks';
import { RESOLUCAO_AVISO_DEVOLUCAO, chaveDoAvisoDeDevolucao } from './avisoDevolucao';
import { mapearDevolucaoShopee, pendenciaDoVendedor } from './devolucaoMapping';
import { idIncidenteDevolucaoShopee } from './idsDevolucao';
import {
  importarDevolucaoShopee,
  type AlvoDeImportacaoDevolucaoShopee,
  type ShopeeImportarDevolucaoDeps,
} from './importarDevolucao';
import { alvoDoPushDeDevolucao } from './pushDevolucao';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
/** The tasks emulator is the half this suite exists for — gate on it too. */
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

const NOTIF = 'notificacoesShopee';

/** This suite's OWN conta id — see the header for why it is not `int-1`…`int-3`. */
const INTEGRACAO_ID = 'int-4';
/** The step-5 fixture order number. Not a real order. */
const ORDER_SN = '260910KJBHUJDM';
/** The corpus detail's own return_sn — ALPHANUMERIC, the shape a digits guard breaks. */
const RETURN_SN_ALFA = '260910ABCDE0001';
/** RT-4's return_sn, the reconcile's literal (`shopee-devolucao-2609100000000001`). */
const RETURN_SN_RT4 = '2609100000000001';
/** The DIGEST id both the handler and the transaction recompute. */
const PEDIDO_ID = makePedidoIdShopee(INTEGRACAO_ID, ORDER_SN);

function db() {
  return getAdminFirestore();
}

/** A fresh `7xxxxx` shop per test — see the header for the disjoint ranges. */
function lojaDoTeste(): number {
  return 700_000 + Math.floor(Math.random() * 90_000);
}

/**
 * Poll for the FIRST of `docIds` the DISPATCHED function writes.
 *
 * Verbatim the precedents' shape (`../pedidos/arranjoAutomatico.tasks.test.ts`)
 * and for their reasons: there is no promise to await, only the effect, and
 * `emulators:exec` tears the suite down the moment the script exits. It takes a
 * LIST for exactly one caller — RT-3's code-3 row, whose day stamp comes from the
 * DISPATCHED process's clock, so a run that straddles 00:00 UTC may land on
 * either of two days.
 *
 * ⚠️ Returning at all is this suite's POSITIVE existence assertion on the
 * dispatched side (`vitest.tasks.setup.ts` (3)): in the emulator a mis-targeted
 * `(default)` database silently auto-creates.
 */
async function esperarDoc(
  docIds: readonly string[],
  timeoutMs = 45_000,
): Promise<{ id: string; data: FirebaseFirestore.DocumentData }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const id of docIds) {
      const snap = await db().collection(NOTIF).doc(id).get();
      if (snap.exists) return { id, data: snap.data()! };
    }
    if (Date.now() > deadline) {
      const all = await db().collection(NOTIF).get();
      throw new Error(
        `nenhuma das notificações [${docIds.join(', ')}] chegou em ${String(timeoutMs)}ms. ` +
          `A coleção tem ${String(all.size)} doc(s): ${all.docs.map((d) => d.id).join(', ') || '<vazia>'}. ` +
          'As causas usuais, nesta ordem: (1) a função despachada LANÇOU e a fila está ' +
          're-tentando com backoff — nada é gravado antes da ÚLTIMA tentativa. Neste braço ' +
          'o lançamento esperável é um dos DOIS imports dinâmicos (`../devolucoes/pushDevolucao`, ' +
          '`../devolucoes/importarDevolucao`) que não resolveu no artefato, ou um ' +
          'ShopeeConfigError (SHOPEE_PARTNER_ID/KEY ausentes no processo do emulador) — leia o ' +
          'log do emulador; (2) DERIVA DE REGIÃO — SHOPEE_TASKS_REGION diferente do ' +
          'FUNCTIONS_REGION embutido no bundle (#1108): o Cloud Tasks aceitou e nunca entregou; ' +
          '(3) prepare-deploy.mjs NÃO rodou antes do emulators:exec, então ' +
          '.deploy/shopee-functions está velho — um artefato de antes do step 17 ESTACIONA o ' +
          'code 29 (`parked`). ⚠️ Se um id ACIMA aparece na lista, o problema é outro: leia o ' +
          '`status` e o `erro` do documento.',
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Every credential document of the seeded conta — there must be none. */
async function apagarCredenciais(): Promise<void> {
  const refs = await credenciaisIntegracaoCollection
    .ref(db(), { integracaoId: INTEGRACAO_ID })
    .listDocuments();
  await Promise.all(refs.map((r) => r.delete()));
}

/**
 * Everything this file seeds or makes the importer write. ⚠️ The incidentes go
 * FIRST and by name: deleting a pedido does not delete its subcollection, and a
 * leftover incidente would turn RT-4's `criado` into an update.
 */
async function limpar(): Promise<void> {
  __resetContadorDeEntregasParaTestes();
  const notificacoes = await db().collection(NOTIF).listDocuments();
  await Promise.all(notificacoes.map((r) => r.delete()));
  const incidentes = await incidenteCollection.ref(db(), { pedidoId: PEDIDO_ID }).listDocuments();
  await Promise.all(incidentes.map((r) => r.delete()));
  await Promise.all(
    [RETURN_SN_ALFA, RETURN_SN_RT4].map((sn) =>
      avisoCollection.docRef(db(), {}, chaveDoAvisoDeDevolucao(INTEGRACAO_ID, sn)).delete(),
    ),
  );
  await apagarCredenciais();
  await pedidoCollection.docRef(db(), {}, PEDIDO_ID).delete();
  await integracaoCollection.docRef(db(), {}, INTEGRACAO_ID).delete();
}

beforeEach(limpar);
// ⚠️ AFTER too, like the arrange suite: the conta seeded here is an ACTIVE
// Shopee conta with a `shop_id`, the one shape every per-conta sweep enumerates.
afterEach(limpar);

/** An ACTIVE Shopee conta naming `shopId`, WITHOUT a credential — and proof of both. */
async function semearConta(shopId: number): Promise<void> {
  // `tipo` is an INT on disk, so the named member is the only honest spelling
  // (`prefer-schema-enum`).
  await integracaoCollection.set(db(), {}, INTEGRACAO_ID, {
    nome: 'Conta de teste — devoluções, SEM credencial',
    tipo: INTEGRACAO_TIPO.shopee,
    ativo: true,
    shop_id: shopId,
  });
  // POSITIVE existence assertion BEFORE any enqueue (`vitest.tasks.setup.ts`
  // (3)): reading the seed back proves the test and the dispatched function look
  // at the same database — which is what makes the credential ABSENCE mean
  // something.
  const conta = await integracaoCollection.docRef(db(), {}, INTEGRACAO_ID).get();
  expect(conta.exists).toBe(true);
  expect(conta.data()).toMatchObject({
    tipo: INTEGRACAO_TIPO.shopee,
    ativo: true,
    shop_id: shopId,
  });
  // ⚠️ The SAFETY precondition, not a formality: with a usable credential the
  // package would sign and SEND `get_return_detail` / `get_order_detail` from the
  // emulator's process, which the kill-switch does not cover.
  const credencial = await credenciaisIntegracaoCollection
    .docRef(db(), { integracaoId: INTEGRACAO_ID }, SHOPEE_CREDENCIAL_DOC_ID)
    .get();
  expect(credencial.exists).toBe(false);
}

/**
 * The pedido at the digest id. Only EXISTENCE is read on these paths (the
 * handler's cheap skip and the transaction's own `tx.get`), so it is the
 * smallest document the schema accepts.
 */
async function semearPedido(): Promise<void> {
  await pedidoCollection.set(db(), {}, PEDIDO_ID, {
    ehSaida: true,
    estado: ESTADO_PEDIDO.pago,
    numero: ORDER_SN,
    integracaoPedidoOuterRef: `documents/integracao/${INTEGRACAO_ID}`,
  });
  expect((await pedidoCollection.docRef(db(), {}, PEDIDO_ID).get()).exists).toBe(true);
}

describe.skipIf(!EMULATED || !TASKS)(
  'code 29 Shopee (devolução) → Cloud Tasks → braço de devolução',
  () => {
    it('RT-1: um push 32 assinado de loja não mapeada ADIA (`sem-conta`) — um artefato de antes do step 17 ESTACIONARIA', async () => {
      const shopId = lojaDoTeste();
      // SECONDS on the wire — the receiver normalises to ms, which is what lands
      // in the doc id and in the stored `timestamp`.
      const timestampSegundos = Math.floor(Date.now() / 1000);
      // `push 32`'s own sample shape, ids swapped for fixtures: `order_sn` WITH
      // the underscore and NO top-level `update_time` — the clocks live per field.
      const data = {
        order_sn: ORDER_SN,
        return_sn: RETURN_SN_ALFA,
        updated_values: [
          {
            update_field: 'return_status',
            old_value: 'JUDGING',
            new_value: 'PROCESSING',
            update_time: timestampSegundos,
          },
        ],
      };
      const raw = JSON.stringify({ code: 29, shop_id: shopId, timestamp: timestampSegundos, data });

      // ---- Preconditions: the pure halves this delivery crosses.
      expect(destinoDoCodigo(29)).toBe('devolucao');
      expect(alvoDoPushDeDevolucao(data)).toMatchObject({
        ok: true,
        orderSn: ORDER_SN,
        returnSn: RETURN_SN_ALFA,
        origem: 'push',
      });

      // Signed with the SAME configuration the route reads, so a lane that forgot
      // SHOPEE_PUSH_CALLBACK_URL or SHOPEE_PARTNER_KEY fails at the 204 below
      // instead of looking like a queue problem.
      const assinatura = expectedPushSignature(raw, {
        partnerKey: shopeeConfig().partnerKey,
        callbackUrl: shopeePushCallbackUrl(),
      });
      const res = await POST(
        new Request('http://localhost:3009/api/webhooks/shopee', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: assinatura },
          body: raw,
        }),
      );
      // ⚠️ BEFORE any polling: a 503/401 enqueues NOTHING, and the poll would
      // then spend 45 seconds blaming the region.
      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');

      // Code 29's identity: the ENVELOPE stamp, never a `data.update_time`.
      const docId = `29:${String(shopId)}:${RETURN_SN_ALFA}:${String(timestampSegundos * 1000)}`;
      const { data: doc } = await esperarDoc([docId]);

      expect(doc).toMatchObject({
        code: 29,
        shop_id: shopId,
        timestamp: timestampSegundos * 1000,
        // ⚠️ `deferred`, not `parked` and not `failed`. `parked` would mean the
        // dispatched bundle still routes code 29 to the unbuilt-handler arm (a
        // stale artifact), or the parser refused the push-32 body; `failed`
        // would mean the receiver took its own enqueue fallback (a region
        // mismatch, #1108) and the queue hop never happened at all.
        status: 'deferred',
        tentativas: 0,
      });
      // The SHARED `sem-conta` template — unprefixed by design (the defer table
      // in apps/shopee/CLAUDE.md): it names the shop, which is what an operator
      // acts on, and it is NOT the `devolucao:` prefix of the arm's own reasons.
      expect(String(doc.erro)).toContain(String(shopId));
      expect(String(doc.erro).startsWith('devolucao:')).toBe(false);
      // `data` survived the queue hop byte for byte.
      expect(doc.data).toEqual(data);
      expect(doc.processedAt).toBeGreaterThan(0);
    });

    it('RT-2: com conta SEM credencial e pedido presente, os dois imports do braço resolvem e a entrega ADIA em `ShopeeSemCredencialError` (prefixo `devolucao:`) — sem chamar a Shopee', async () => {
      const shopId = lojaDoTeste();
      // The SYNTHESIS moment in MILLISECONDS — what the action route hands the
      // builder (the operator's click), never floored.
      const nowMs = Date.now();
      const payload = notificacaoSinteticaDeDevolucao({
        shopId,
        orderSn: ORDER_SN,
        returnSn: RETURN_SN_ALFA,
        nowMs,
        origem: 'acao-vendedor',
      });

      // ---- Preconditions: the pure halves the chain crosses, on THIS payload —
      // a drifted builder or reader fails HERE, naming itself.
      expect(destinoDoCodigo(payload.code)).toBe('devolucao');
      expect(alvoDoPushDeDevolucao(payload.data ?? {})).toMatchObject({
        ok: true,
        orderSn: ORDER_SN,
        returnSn: RETURN_SN_ALFA,
        origem: 'acao-vendedor',
      });
      const docId = `29:${String(shopId)}:${RETURN_SN_ALFA}:${String(nowMs)}`;
      expect(docIdOf(payload)).toBe(docId);
      expect(dedupKeyOf(payload)).toBe(`29:${String(shopId)}:${RETURN_SN_ALFA}`);
      // The reason the arm will write, from the SAME classifier it runs.
      const esperado = disposicaoDaFalhaDeDevolucao(new ShopeeSemCredencialError('sonda'));
      expect(esperado.tipo).toBe('defer');
      const razao = esperado.tipo === 'defer' ? esperado.reason : '';
      expect(razao.startsWith('devolucao: ')).toBe(true);
      expect(razao).toContain('ShopeeSemCredencialError');
      // The valve would make the enqueue THROW (sweep-only mode): name it here.
      expect(shopeeTasksDesabilitado()).toBe(false);

      await semearConta(shopId);
      await semearPedido();

      // The REAL scheduler against the REAL emulated queue — the producer the
      // action route uses. A 404 here is a finding, not a flake.
      await createShopeeTaskScheduler().enqueue(payload);

      const { data: doc } = await esperarDoc([docId]);

      expect(doc).toMatchObject({
        code: 29,
        shop_id: shopId,
        // MILLISECONDS end to end: the builder writes ms and the task schema
        // passes it through.
        timestamp: nowMs,
        // ⚠️ `deferred` with `tentativas: 0` — `failed` would mean the dispatch
        // THREW through every attempt (an import of the arm that did not
        // resolve, layer (b)); `parked` a stale artifact or a refused body.
        status: 'deferred',
        tentativas: 0,
      });
      // ⚠️ The DISCRIMINATOR (layer (d)): exactly the classifier's reason for a
      // missing credential — so the handler got PAST the pedido gate (a missing
      // pedido defers too, with "ainda não existe").
      expect(doc.erro).toBe(razao);
      expect(String(doc.erro)).not.toContain('ainda não existe');
      // EXACTLY the builder's three keys, `order_sn` WITH the underscore.
      expect(doc.data).toEqual({
        order_sn: ORDER_SN,
        return_sn: RETURN_SN_ALFA,
        origem: 'acao-vendedor',
      });
      expect(doc.processedAt).toBeGreaterThan(0);
      // Nothing reached the transaction: the token read threw first.
      const incidente = await incidenteCollection
        .docRef(db(), { pedidoId: PEDIDO_ID }, idIncidenteDevolucaoShopee(RETURN_SN_ALFA))
        .get();
      expect(incidente.exists).toBe(false);
    });

    it('RT-3: com conta e SEM pedido, o code 29 ADIA nomeando o code 3 sintético, e o code 3 chega ao braço de pedido no carimbo do DIA UTC', async () => {
      const shopId = lojaDoTeste();
      const antesMs = Date.now();
      // The poller's stamp: the START of the UTC day — one failure row per return
      // per day, whatever the tick.
      const carimbo29 = carimboDoDiaUtcMs(antesMs);
      const payload = notificacaoSinteticaDeDevolucao({
        shopId,
        orderSn: ORDER_SN,
        returnSn: RETURN_SN_ALFA,
        nowMs: carimbo29,
        origem: 'reconciliacao',
      });
      const docId29 = docIdOf(payload);
      expect(docId29).toBe(`29:${String(shopId)}:${RETURN_SN_ALFA}:${String(carimbo29)}`);

      // The code-3 reason, from the SAME classifier the code-3 arm runs.
      const esperado3 = disposicaoDaFalhaDeImportacao(new ShopeeSemCredencialError('sonda'));
      expect(esperado3.tipo).toBe('defer');
      const razao3 = esperado3.tipo === 'defer' ? esperado3.reason : '';
      expect(destinoDoCodigo(3)).toBe('pedido');
      expect(shopeeTasksDesabilitado()).toBe(false);

      // The conta, and deliberately NO pedido — the case.
      await semearConta(shopId);
      expect((await pedidoCollection.docRef(db(), {}, PEDIDO_ID).get()).exists).toBe(false);

      await createShopeeTaskScheduler().enqueue(payload);

      const { data: doc29 } = await esperarDoc([docId29!]);
      expect(doc29).toMatchObject({
        code: 29,
        shop_id: shopId,
        timestamp: carimbo29,
        status: 'deferred',
        tentativas: 0,
      });
      // ⚠️ The arm's OWN "no pedido" reason, and it says the code 3 REALLY
      // reached the queue — `NÃO enfileirado (válvula)` would mean the valve
      // swallowed it, and a throw from the enqueue would have been `failed`.
      const erro29 = String(doc29.erro);
      expect(erro29.startsWith('devolucao: ')).toBe(true);
      expect(erro29).toContain(`pedido ${ORDER_SN} ainda não existe`);
      expect(erro29).toContain('code 3 sintético enfileirado');
      expect(erro29).not.toContain('ShopeeSemCredencialError');
      expect(doc29.data).toEqual({
        order_sn: ORDER_SN,
        return_sn: RETURN_SN_ALFA,
        origem: 'reconciliacao',
      });

      // ---- The bridge (layer (e)): the code 3 the DISPATCHED function enqueued.
      // Its stamp is the dispatch clock's UTC day — either side of a midnight.
      const depoisMs = Date.now();
      const candidatos = [...new Set([carimboDoDiaUtcMs(antesMs), carimboDoDiaUtcMs(depoisMs)])];
      const ids3 = candidatos.map(
        (dia) =>
          docIdOf(
            notificacaoSinteticaDePedido({
              shopId,
              orderSn: ORDER_SN,
              nowMs: dia,
              origem: 'devolucao',
            }),
          )!,
      );
      for (const [i, dia] of candidatos.entries()) {
        expect(ids3[i]).toBe(`3:${String(shopId)}:${ORDER_SN}:${String(dia)}`);
      }
      const { id: id3, data: doc3 } = await esperarDoc(ids3);
      const dia3 = candidatos[ids3.indexOf(id3)]!;

      expect(doc3).toMatchObject({
        code: 3,
        shop_id: shopId,
        // ⚠️ The DAY stamp, never the dispatch's raw ms (M67): that is what
        // bounds the deferred lane's daily re-drives to ONE code-3 row per day.
        timestamp: dia3,
        // `deferred`: the code-3 arm found the conta and its importer stopped at
        // the token — `pedido-adiado`, not `sem-conta`, not a park.
        status: 'deferred',
        tentativas: 0,
      });
      expect(doc3.timestamp % 86_400_000).toBe(0);
      expect(doc3.erro).toBe(razao3);
      // EXACTLY the code-3 builder's keys: `ordersn` WITHOUT the underscore
      // there, and the producer named.
      expect(doc3.data).toEqual({ ordersn: ORDER_SN, origem: 'devolucao' });
      expect(doc3.processedAt).toBeGreaterThan(0);
    });

    /**
     * RT-4 — in THIS process, so the client is a stub and the kill-switch covers
     * `fetch`. Everything else is the production path against a real engine:
     * the cheap pedido read, `salvarIncidenteDevolucaoShopee`'s transaction,
     * `aplicarAvisoDeDevolucao` with the DEFAULT aviso deps (a real
     * `FieldValue.increment`, the delivery's own `nowMs`).
     */
    it('RT-4: o importador em processo contra o Firestore do emulador — criado, réplica idêntica sem escrita, réplica após aviso perdido o reabre, mais velha ignorada, relógio igual com conteúdo diferente atualiza (revisao 2), mais nova só avança o relógio', async () => {
      const nowMs = Date.now();
      const corpus = lerDevolucaoDetalhe(FIXTURE_RETURN_DETAIL_DOC);
      const t0 = corpus.response.update_time;
      /** The corpus detail, at `t0 + segundos`, under RT-4's return_sn. */
      function detalhe(
        segundos: number,
        over: Partial<ShopeeReturnDetail> = {},
      ): ShopeeReturnDetailEnvelope {
        return {
          ...corpus,
          response: {
            ...corpus.response,
            return_sn: RETURN_SN_RT4,
            order_sn: ORDER_SN,
            update_time: t0 + segundos,
            ...over,
          },
        };
      }

      let resposta = detalhe(0);
      const pulls: string[] = [];
      const enfileirados: ShopeeNotificationPayload[] = [];
      const deps: ShopeeImportarDevolucaoDeps = {
        clientFor: (_db, integracaoId) => {
          expect(integracaoId).toBe(INTEGRACAO_ID);
          return Promise.resolve({
            getReturnDetail: (p) => {
              pulls.push(p.returnSn);
              return Promise.resolve(resposta);
            },
          });
        },
        // The pedido exists on every step below, so the synthetic code 3 must
        // never be built — a call lands here and fails the last assertion.
        scheduler: {
          enqueue: (p) => {
            enfileirados.push(p);
            return Promise.resolve();
          },
        },
      };
      // A push with no diary: the diary is LOG-only, and the pulled detail is
      // the whole input. `shopId` is read only by the synthetic code 3, which
      // this test never reaches.
      const alvo: AlvoDeImportacaoDevolucaoShopee = {
        integracaoId: INTEGRACAO_ID,
        shopId: 987654,
        orderSn: ORDER_SN,
        returnSn: RETURN_SN_RT4,
        nowMs,
        origem: 'push',
        diario: null,
      };
      const importar = () => importarDevolucaoShopee(db(), alvo, deps);

      const incidenteId = idIncidenteDevolucaoShopee(RETURN_SN_RT4);
      expect(incidenteId).toBe('shopee-devolucao-2609100000000001');
      const incidenteRef = incidenteCollection.docRef(db(), { pedidoId: PEDIDO_ID }, incidenteId);
      const avisoRef = avisoCollection.docRef(
        db(),
        {},
        chaveDoAvisoDeDevolucao(INTEGRACAO_ID, RETURN_SN_RT4),
      );
      const usT0 = microsDeSegundosShopee(t0);

      await semearPedido();

      // ---- 1. `criado`: the first delivery creates the incidente at the
      // derived id, watermark = the detail's `update_time` in µs (site 3).
      const r1 = await importar();
      expect(r1).toMatchObject({
        acao: 'criado',
        pedidoId: PEDIDO_ID,
        statusDevolucao: 'ACCEPTED',
      });
      const s1 = await incidenteRef.get();
      expect(s1.exists).toBe(true);
      const d1 = s1.data()!;
      expect(d1).toMatchObject({
        origem: ORIGEM_INCIDENTE.pedidoShopee,
        tipo: TIPO_INCIDENTE.devolucao,
        externalId: RETURN_SN_RT4,
        claimStatus: STATUS_CLAIM.aberta,
        claimStage: null,
        entregue: null,
        relogioProvedorUs: usT0,
        ultimaModificacao: usT0,
        devolucaoShopee: {
          revisao: 1,
          returnSn: RETURN_SN_RT4,
          orderSn: ORDER_SN,
          status: 'ACCEPTED',
        },
      });
      // The stored block is EXACTLY the mapped allow-list plus `revisao`, through
      // a real engine — no field dropped, none invented (no buyer key can be).
      const mapeada = mapearDevolucaoShopee(resposta.response);
      expect(Object.keys(d1.devolucaoShopee as Record<string, unknown>).sort()).toEqual(
        [...Object.keys(mapeada.bloco), 'revisao'].sort(),
      );
      // The aviso, OPEN, with the pendência the ONE rule picks and the clock it builds.
      expect(r1.aviso).toBe('aberto');
      const pendencia = pendenciaDoVendedor(mapeada.claimStatus, mapeada.bloco);
      expect(pendencia).not.toBeNull();
      const a1 = await avisoRef.get();
      expect(a1.exists).toBe(true);
      expect(a1.data()).toMatchObject({
        resolvidoEm: null,
        motivo: 'ACCEPTED',
        ocorrencias: 1,
        // `relogioProvedorUs + min(revisao, 999 999)`, pinned by VALUE: an
        // expectation computed through `relogioDoAvisoDeDevolucao` would move
        // WITH a broken clock and pass (M75 — measured alive that way).
        relogioEvento: usT0 + 1,
        params: { pedido: ORDER_SN, devolucao: RETURN_SN_RT4, pendencia: pendencia!.pendencia },
      });

      // ---- 2. The identical replay: ZERO writes — the document's `updateTime`
      // does not move (M47), and the aviso's equal clock is dropped.
      const r2 = await importar();
      expect(r2.acao).toBe('ignorado-sem-mudanca');
      expect(r2.aviso).toBe('inalterado');
      const s2 = await incidenteRef.get();
      expect(s2.updateTime!.isEqual(s1.updateTime!)).toBe(true);
      const a2 = await avisoRef.get();
      expect(a2.updateTime!.isEqual(a1.updateTime!)).toBe(true);
      expect(a2.data()?.ocorrencias).toBe(1);

      // ---- 2b. The LOST effect: the transaction committed and the aviso write
      // did not (a crash, a transient) — the state a redelivery finds after a
      // FIRST delivery, reproduced by removing the row. The replay reads
      // `ignorado-sem-mudanca` and still re-applies the effect at the SAME
      // clock (the W2 → W3 hand-off): the row comes back, and the incidente is
      // not written.
      await avisoRef.delete();
      const r2b = await importar();
      expect(r2b).toMatchObject({ acao: 'ignorado-sem-mudanca', aviso: 'aberto' });
      expect((await incidenteRef.get()).updateTime!.isEqual(s1.updateTime!)).toBe(true);
      const a2b = await avisoRef.get();
      expect(a2b.exists).toBe(true);
      expect(a2b.data()).toMatchObject({
        resolvidoEm: null,
        motivo: 'ACCEPTED',
        ocorrencias: 1,
        relogioEvento: usT0 + 1,
        params: { pedido: ORDER_SN, devolucao: RETURN_SN_RT4, pendencia: pendencia!.pendencia },
      });

      // ---- 3. An OLDER detail: zero writes, and it neither raises nor resolves.
      resposta = detalhe(-60, { status: 'CLOSED' });
      const r3 = await importar();
      expect(r3.acao).toBe('ignorado-obsoleto');
      expect(r3.aviso).toBe('inalterado');
      expect((await incidenteRef.get()).updateTime!.isEqual(s1.updateTime!)).toBe(true);
      expect((await avisoRef.get()).updateTime!.isEqual(a2b.updateTime!)).toBe(true);

      // ---- An operator edit in between, the web editor's shape: its own text
      // and a WALL-CLOCK `ultimaModificacao` far newer than Shopee's clock. Neither
      // may block the next import (M50) nor be overwritten by it (M55).
      const textoDoOperador = 'Anotação do operador (teste)';
      await incidenteRef.update({
        motivoDoIncidente: textoDoOperador,
        ultimaModificacao: usT0 + 10_000_000_000,
      });
      const sOperador = await incidenteRef.get();

      // ---- 4. EQUAL clock, DIFFERENT content: written (Shopee's 1-second
      // resolution), `revisao` 2, the incidente closes and so does the aviso.
      resposta = detalhe(0, { status: 'CLOSED' });
      const r4 = await importar();
      expect(r4).toMatchObject({
        acao: 'atualizado',
        statusDevolucao: 'CLOSED',
        aviso: 'resolvido',
      });
      const s4 = await incidenteRef.get();
      expect(s4.updateTime!.isEqual(sOperador.updateTime!)).toBe(false);
      const d4 = s4.data()!;
      expect(d4).toMatchObject({
        claimStatus: STATUS_CLAIM.fechada,
        relogioProvedorUs: usT0,
        // Display only, re-stamped from the PROVIDER clock on every applied write.
        ultimaModificacao: usT0,
        devolucaoShopee: { revisao: 2, status: 'CLOSED' },
        // ⚠️ Operator turf survives a real `tx.update` + `parseMerge` patch.
        motivoDoIncidente: textoDoOperador,
      });
      // `timestamp` is create-only: still the creation's value.
      expect(d4.timestamp).toBe(d1.timestamp);
      const a4 = await avisoRef.get();
      expect(a4.data()).toMatchObject({
        resolucaoMotivo: RESOLUCAO_AVISO_DEVOLUCAO.devolucaoEncerrada,
        // By VALUE again: the same watermark, `revisao` 2.
        relogioEvento: usT0 + 2,
      });
      expect(a4.data()?.resolvidoEm).toBeGreaterThan(0);

      // ---- 5. A NEWER detail with the SAME content: only the watermark moves
      // (M49) — `revisao` stays 2, and the aviso is not touched.
      resposta = detalhe(60, { status: 'CLOSED' });
      const r5 = await importar();
      expect(r5.acao).toBe('relogio-avancado');
      expect(r5.aviso).toBe('inalterado');
      const d5 = (await incidenteRef.get()).data()!;
      expect(d5).toMatchObject({
        relogioProvedorUs: microsDeSegundosShopee(t0 + 60),
        ultimaModificacao: microsDeSegundosShopee(t0 + 60),
        devolucaoShopee: { revisao: 2, status: 'CLOSED' },
        motivoDoIncidente: textoDoOperador,
      });
      expect((await avisoRef.get()).updateTime!.isEqual(a4.updateTime!)).toBe(true);

      // ONE pull per delivery (six deliveries), never a second; and the pedido
      // existed throughout, so not one synthetic code 3 was built.
      expect(pulls).toEqual(Array.from({ length: 6 }, () => RETURN_SN_RT4));
      expect(enfileirados).toEqual([]);
    });
  },
);
