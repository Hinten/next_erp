/**
 * Step 15b's automatic-arrange WIRING through the Cloud Tasks hop, end to end,
 * against the real emulators (`ci-shopee.yml`) — the SEVENTH `*.tasks.test.ts`
 * of this codebase, the third to drive the NOTIFICATION queue, and the first to
 * reach a shipment handler with a pedido that EXISTS (reconcile RT10).
 *
 * What runs for real here, with nothing mocked:
 *
 *   notificacaoSinteticaDePacote(…)        the code-30 builder PR 3b's sweep uses
 *   createShopeeTaskScheduler().enqueue()  the real region-qualified queue
 *     → Cloud Tasks emulator → Functions emulator
 *     → processShopeeNotification          the real deployed onTaskDispatched
 *     → handleNotificationTask → processNotificationPayload
 *     → DISPATCH[30] === 'frete'
 *     → await import('../pedidos/fretePushShopee')   the push reader parses the
 *                                           SYNTHETIC body (a mis-keyed one PARKS)
 *     → findIntegracaoByShopId → the seeded conta
 *     → defaultProcessDeps.rastrearPedido  the arm's lazy default, whose TWO
 *         await import('../pedidos/rastrearPedido')     sequential imports both
 *         await import('../pedidos/arranjoAutomatico')  resolve in the BUILT
 *                                           artifact BEFORE the handler runs
 *     → rastrearPedidoShopee(…, { arranjar })
 *     → the cheap pedido read              the seeded pedido EXISTS
 *     → loadShopeeContext → createShopClient → getPackageDetail
 *     → signedCall awaits getAccessToken   no credential document
 *     → ShopeeSemCredencialError           BEFORE any fetch
 *     → disposicaoDaFalhaDeRastreio        `defer`, prefix `rastreio:`
 *     → a real `deferred` doc in notificacoesShopee
 *
 * ⚠️ NO new job, NO new check name, NO new row in the gate manifest: the
 * `.tasks.test.ts` suffix alone puts this file in the ONE `Shopee Cloud Tasks
 * round trip` job (`vitest.tasks.config.ts` includes it, `vitest.config.ts`
 * excludes it).
 *
 * ⚠️ Why a conta WITHOUT A CREDENTIAL, and why the hook BODY is out of reach.
 * The lane's non-localhost `fetch` kill-switch lives in the VITEST process and
 * does NOT cover the dispatched function, which runs in the emulator's own
 * process (`vitest.tasks.setup.ts` (4)), and `shopeeHosts()` has no stub
 * override — so any path that reached a Shopee call would really leave the
 * runner. The arrange sits AFTER `get_package_detail` (it needs the fresh row),
 * so no emulator test can reach it offline. What CAN be reached is everything
 * up to the first Shopee call, and that is exactly the part no unit test can
 * prove: the token is part of the signed query, so the package awaits
 * `getAccessToken()` before it builds a request (`signedCall` in
 * `packages/integrations/shopee/src/api.ts`), and with no `credenciais/current`
 * document that read throws. Zero Shopee calls by CALL ORDER, never by a mock.
 * The hook's own ladder is pinned offline in `arranjoAutomatico.test.ts`, the
 * arm's copy of its desfecho in `../notificacoes/notificacao.test.ts`.
 *
 * What this proves that no offline test can, in four layers:
 *
 *   (a) BOTH dynamic imports of the arm's lazy default RESOLVE inside the built
 *       artifact. They run before `rastrearPedidoShopee` is even called, so a
 *       chunk the bundler failed to carry (or a module that pulled something
 *       Next-bound into the functions graph) THROWS — and a throw is the queue's
 *       retry ladder: nothing is persisted until the LAST attempt, which lands
 *       after this poll's deadline (`TASK_MAX_ATTEMPTS` with a 30 s backoff
 *       floor). So that failure surfaces as the poll's timeout, or as `failed`
 *       on a slow run — never as `deferred` with `tentativas: 0`.
 *   (b) the code-30 BUILDER's body is what the push reader accepts, through a
 *       JSON round trip across Cloud Tasks: a body the reader refused would
 *       PARK (`rastreio: …`) instead of reaching the conta.
 *   (c) the handler really reached the package read with the pedido PRESENT.
 *       A missing pedido is a defer TOO (`frete-adiado`, "ainda não existe"),
 *       so `deferred` alone proves nothing: the REASON is the discriminator, and
 *       it is computed below by the same classifier the arm runs.
 *   (d) the delivery's identity: the stored row sits at the id `docIdOf`
 *       derives for a synthetic code 30 — `30:<shop>:<package>:<nowMs>`, the
 *       envelope stamp as carimbo because the builder writes no `update_time`.
 *
 * ⚠️ NOT covered, and deliberately not asserted:
 *   - the hook itself, the two aviso resolvers and the frete transaction —
 *     all three sit after the package read (see above);
 *   - the absence of a synthetic code 3. The "pedido missing" branch would
 *     enqueue one, but an absence cannot be polled honestly; (c)'s reason
 *     assertion is what rules that branch out;
 *   - `retryConfig` / `rateLimits` — asserted off `__endpoint` in
 *     `../../../functions/src/processNotification.test.ts`.
 *
 * ⚠️ WHICH conta id, and why it is not `int-1` or `int-2`. The conta read is a
 * 15-minute read cache in the DISPATCHED process (`../core/contaCache.ts`), and
 * a Shopee conta WITH a `shop_id` is a fresh entry. Two later suites of this
 * lane own those ids: `../produtos/importacaoMassa.tasks.test.ts` and
 * `../precos/atualizarPrecos.tasks.test.ts` seed `int-1` with the WRONG `tipo`
 * and `int-2` with NO `shop_id`, and each relies on that refusal to stay
 * offline. A cached Shopee `int-1`/`int-2` from this suite would be served to
 * them and lift exactly the barrier that keeps them from calling Shopee. So
 * this suite owns `int-3`, and an `afterEach` removes the ACTIVE conta it seeds
 * — an active Shopee conta left in the emulator is one any later sweep suite
 * would enumerate.
 *
 * ⚠️ The clock. This file reads the wall clock for TEST-LOCAL purposes only:
 * the synthesis moment it hands the builder (the sweep's one read per tick) and
 * the poll's own deadline. Neither is a production clock read — the arm takes
 * its instant from the pipeline's injectable clock, and `pedidos/` reads none.
 *
 * ⚠️ Fixture ids only, and none of them is real: `int-3`, the step-5 fixture
 * order number `260910KJBHUJDM`, the fixture package `OFG000000000001`; the
 * shop is a random `8xxxxx` per run (disjoint from the `9xxxxx` range the
 * receiver and listing suites draw from, so no run of theirs can map to the
 * conta seeded here). No token, no credential and no real shop appears
 * anywhere.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  credenciaisIntegracaoCollection,
  integracaoCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import { ESTADO_PEDIDO, INTEGRACAO_TIPO } from '@delfrance/schemas';

import { getAdminFirestore } from '../../firebase/admin';
import { SHOPEE_CREDENCIAL_DOC_ID } from '../core/credentialStore';
import { ShopeeSemCredencialError } from '../core/tokenStore';
import {
  dedupKeyOf,
  destinoDoCodigo,
  disposicaoDaFalhaDeRastreio,
  docIdOf,
} from '../notificacoes/notificacao';
import { notificacaoSinteticaDePacote } from '../notificacoes/notificacaoSintetica';
import { createShopeeTaskScheduler, shopeeTasksDesabilitado } from '../shopeeTasks';
import { alvoDoPushDeFrete } from './fretePushShopee';
import { makePedidoIdShopee } from './orderIds';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
/** The tasks emulator is the half this suite exists for — gate on it too. */
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

const NOTIF = 'notificacoesShopee';

/** This suite's OWN conta id — see the header for why it is not `int-1`/`int-2`. */
const INTEGRACAO_ID = 'int-3';
/** The step-5 fixture order number. Not a real order. */
const ORDER_SN = '260910KJBHUJDM';
/** The fixture package number. Not a real parcel. */
const PACOTE = 'OFG000000000001';
/** The DIGEST id the handler recomputes for its cheap existence read. */
const PEDIDO_ID = makePedidoIdShopee(INTEGRACAO_ID, ORDER_SN);

function db() {
  return getAdminFirestore();
}

/** Every credential document of the seeded conta — there must be none. */
async function apagarCredenciais(): Promise<void> {
  const refs = await credenciaisIntegracaoCollection
    .ref(db(), { integracaoId: INTEGRACAO_ID })
    .listDocuments();
  await Promise.all(refs.map((r) => r.delete()));
}

/**
 * Poll for the document the DISPATCHED function writes.
 *
 * Verbatim the precedent's shape (`../../../app/api/webhooks/shopee/route.tasks.test.ts`)
 * and for its reasons: the task travels enqueue → tasks emulator → functions
 * emulator → handler, so there is no promise to await, only the effect — and
 * `emulators:exec` tears the suite down the moment the script exits, so waiting
 * on the effect is also what keeps an in-flight dispatch from being killed.
 *
 * ⚠️ Returning at all is this suite's POSITIVE existence assertion on the
 * dispatched side, which `vitest.tasks.setup.ts` (3) requires: in the emulator a
 * mis-targeted `(default)` database silently auto-creates.
 */
async function waitForDoc(
  docId: string,
  timeoutMs = 45_000,
): Promise<FirebaseFirestore.DocumentData> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await db().collection(NOTIF).doc(docId).get();
    if (snap.exists) return snap.data()!;
    if (Date.now() > deadline) {
      const all = await db().collection(NOTIF).get();
      throw new Error(
        `a notificação ${docId} não chegou em ${String(timeoutMs)}ms. ` +
          `A coleção tem ${String(all.size)} doc(s): ${all.docs.map((d) => d.id).join(', ') || '<vazia>'}. ` +
          'As causas usuais, nesta ordem: (1) a função despachada LANÇOU e a fila está ' +
          're-tentando com backoff — nada é gravado antes da ÚLTIMA tentativa. Neste caminho ' +
          'o lançamento esperável é um dos DOIS imports dinâmicos do default do braço ' +
          '(`../pedidos/rastrearPedido`, `../pedidos/arranjoAutomatico`) que não resolveu no ' +
          'artefato, ou um ShopeeConfigError (SHOPEE_PARTNER_ID/KEY ausentes no processo do ' +
          'emulador) — leia o log do emulador; (2) DERIVA DE REGIÃO — SHOPEE_TASKS_REGION ' +
          'diferente do FUNCTIONS_REGION embutido no bundle (#1108): o Cloud Tasks aceitou ' +
          'e nunca entregou; (3) prepare-deploy.mjs NÃO rodou antes do emulators:exec, então ' +
          '.deploy/shopee-functions está velho. ⚠️ Se o id ACIMA aparece na lista, o ' +
          'problema é outro: leia o `status` e o `erro` do documento.',
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function limpar(): Promise<void> {
  const refs = await db().collection(NOTIF).listDocuments();
  await Promise.all(refs.map((r) => r.delete()));
  await apagarCredenciais();
  await pedidoCollection.docRef(db(), {}, PEDIDO_ID).delete();
  await integracaoCollection.docRef(db(), {}, INTEGRACAO_ID).delete();
}

beforeEach(limpar);
// ⚠️ AFTER too, unlike the precedents: the conta seeded here is an ACTIVE
// Shopee conta with a `shop_id`, the one shape every per-conta sweep enumerates.
afterEach(limpar);

describe.skipIf(!EMULATED || !TASKS)(
  'code 30 sintético Shopee → Cloud Tasks → braço de frete → arranjo automático armado',
  () => {
    it('com pedido presente e conta SEM credencial, os dois imports do braço resolvem e a entrega ADIA em `ShopeeSemCredencialError` — sem chamar a Shopee', async () => {
      // Unique per run: the doc id is derived from the payload, so a fresh shop
      // keeps two runs inside one emulator session apart. `8xxxxx`, disjoint
      // from the receiver and listing suites' `9xxxxx` — see the header.
      const shopId = 800_000 + Math.floor(Math.random() * 90_000);
      // The SYNTHESIS moment, MILLISECONDS — what the sweep hands the builder.
      const nowMs = Date.now();

      const payload = notificacaoSinteticaDePacote({
        shopId,
        orderSn: ORDER_SN,
        packageNumber: PACOTE,
        nowMs,
        origem: 'arranjo-automatico',
      });

      // ---- Preconditions: the pure halves the chain crosses, on THIS payload.
      // A drifted builder or reader then fails HERE, naming itself, instead of
      // spending the 45-second poll and blaming the queue.
      expect(destinoDoCodigo(payload.code)).toBe('frete');
      const alvo = alvoDoPushDeFrete(payload.code, payload.data);
      expect(alvo).toMatchObject({ ok: true, orderSn: ORDER_SN, packageNumber: PACOTE });
      const docId = `30:${String(shopId)}:${PACOTE}:${String(nowMs)}`;
      expect(docIdOf(payload)).toBe(docId);
      expect(dedupKeyOf(payload)).toBe(`30:${String(shopId)}:${PACOTE}`);
      // The reason the arm will write, from the SAME classifier it runs — never
      // a hand-copied sentence that could drift from it.
      const esperado = disposicaoDaFalhaDeRastreio(new ShopeeSemCredencialError('sonda'));
      expect(esperado.tipo).toBe('defer');
      const razao = esperado.tipo === 'defer' ? esperado.reason : '';
      expect(razao.startsWith('rastreio: ')).toBe(true);
      expect(razao).toContain('ShopeeSemCredencialError');
      // The valve would make the enqueue THROW (sweep-only mode): name it here.
      expect(shopeeTasksDesabilitado()).toBe(false);

      // ---- The seeds: an ACTIVE Shopee conta that names this shop, and the
      // pedido at the digest id. `tipo` is an INT on disk, so the named member is
      // the only honest spelling (`prefer-schema-enum`).
      await integracaoCollection.set(db(), {}, INTEGRACAO_ID, {
        nome: 'Conta de teste — arranjo automático, SEM credencial',
        tipo: INTEGRACAO_TIPO.shopee,
        ativo: true,
        shop_id: shopId,
      });
      // Only EXISTENCE is read on this path (the handler's cheap skip), so the
      // pedido is the smallest document the schema accepts.
      await pedidoCollection.set(db(), {}, PEDIDO_ID, {
        ehSaida: true,
        estado: ESTADO_PEDIDO.pago,
        numero: ORDER_SN,
        integracaoPedidoOuterRef: `documents/integracao/${INTEGRACAO_ID}`,
      });

      // POSITIVE existence assertions, BEFORE the enqueue and before any
      // polling (`vitest.tasks.setup.ts` (3)): reading both seeds back proves
      // the test and the dispatched function look at the same database — which
      // is also what makes the credential ABSENCE below mean something.
      const conta = await integracaoCollection.docRef(db(), {}, INTEGRACAO_ID).get();
      expect(conta.exists).toBe(true);
      expect(conta.data()).toMatchObject({
        tipo: INTEGRACAO_TIPO.shopee,
        ativo: true,
        shop_id: shopId,
      });
      expect((await pedidoCollection.docRef(db(), {}, PEDIDO_ID).get()).exists).toBe(true);
      // ⚠️ The SAFETY precondition, not a formality: with a usable credential
      // the package would sign and SEND `get_package_detail` from the emulator's
      // process, which the kill-switch does not cover.
      const credencial = await credenciaisIntegracaoCollection
        .docRef(db(), { integracaoId: INTEGRACAO_ID }, SHOPEE_CREDENCIAL_DOC_ID)
        .get();
      expect(credencial.exists).toBe(false);

      // The REAL scheduler against the REAL emulated queue — the producer PR 3b's
      // sweep uses. A 404 here is a finding, not a flake.
      await createShopeeTaskScheduler().enqueue(payload);

      const doc = await waitForDoc(docId);

      expect(doc).toMatchObject({
        code: 30,
        shop_id: shopId,
        // MILLISECONDS end to end: the builder writes ms and the task schema
        // passes it through, so no `* 1000` may appear anywhere on this hop.
        timestamp: nowMs,
        // ⚠️ `deferred` with `tentativas: 0` — and the shapes it is NOT:
        // `parked` would mean the reader refused the synthetic body (layer (b))
        // or a stale artifact without the frete arm; `failed` would mean the
        // dispatch THREW through every attempt — on this path, an import of the
        // arm's default that did not resolve (layer (a)).
        status: 'deferred',
        tentativas: 0,
      });
      // ⚠️ The DISCRIMINATOR (layer (c)): exactly the classifier's reason for
      // a missing credential. A missing pedido also defers, with "ainda não
      // existe" — so the status alone could not tell the two apart.
      expect(doc.erro).toBe(razao);
      expect(String(doc.erro)).not.toContain('ainda não existe');
      // `data` survived the queue hop byte for byte: EXACTLY the builder's three
      // keys, so a reader can still tell a synthetic package push by `origem`.
      expect(doc.data).toEqual({
        ordersn: ORDER_SN,
        package_number: PACOTE,
        origem: 'arranjo-automatico',
      });
      // Stamped by the handler inside the emulator, not by this process.
      expect(doc.processedAt).toBeGreaterThan(0);
    });
  },
);
