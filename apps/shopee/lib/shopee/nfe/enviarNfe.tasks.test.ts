/**
 * The step-14 NF-e UPLOAD through a Firestore trigger AND the Cloud Tasks hop,
 * end to end, against the real emulators (`ci-shopee.yml`) — the SIXTH
 * `*.tasks.test.ts` of this codebase, the first to drive the FIFTH queue, and
 * the first whose outcome depends on a Firestore TRIGGER firing at all.
 *
 * What runs for real here, with nothing mocked:
 *
 *   nfev4Collection.set(...)                an NF-e CREATED `aprovada` — the
 *                                           write the NF-e app makes, through
 *                                           the same schema-validating handle
 *     → onNfeAprovadaShopee                 the real deployed onDocumentWritten
 *     → T1 decideNfeUploadTransition        the edge from "no document"
 *     → T1b finalidadeDoProc                a tpAmb-1 SALE (tpNF 1, finNFe 1)
 *     → T2/T3 one pedido read + the ownership PROOF (the id recomputes)
 *     → T4 createShopeeNfeUploadScheduler().enqueue(…, { scheduleDelaySeconds })
 *     → the real region-qualified queue name (SHOPEE_NFE_UPLOAD_QUEUE)
 *     → Cloud Tasks emulator → Functions emulator
 *     → processShopeeNfeUpload              the real deployed onTaskDispatched
 *     → processarNfeShopee                  P1 NF-e → P2 level → P3 pedido +
 *                                           proof → P4 sale gate → P5 the KEY
 *     → P5 refuses `xml-invalido`           the proc carries no access key
 *     → avisarNfeShopee                     the aviso, through escreverAviso
 *     → carimbarFreteNfeShopee              the class-C stamp, a REAL transaction
 *
 * ⚠️ Why a proc WITHOUT A KEY, and why it is the only upload outcome that can
 * live here. The lane's non-localhost `fetch` kill-switch lives in the VITEST
 * process and does NOT cover the dispatched function, which runs in the
 * emulator's own process (`vitest.tasks.setup.ts` (4)) — so any path that
 * reached a Shopee call would really leave the runner. P5 cannot: it sits
 * ABOVE the conta read (P6), above the Shop client (P7) and above the one order
 * read (P8), so when it answers there is no conta, no token, no secret and no
 * client. Zero Shopee calls by CALL ORDER, never by a mock — the discipline of
 * `../estoque/enviarEstoque.tasks.test.ts` — and that order is not an accident:
 * the handler reads the pedido BEFORE it judges the XML (reconcile R-n)
 * precisely so a broken XML reaches an aviso AND a stamp with no Shopee call.
 * And the outcome PERSISTS twice, so every assertion below is about a document
 * the dispatched function wrote.
 *
 * ⚠️ There is deliberately NO `integracao` document. The refusal precedes the
 * conta read, so seeding one would only invite a later reader to think the
 * conta mattered here. (Another suite of this lane leaves an `int-1` of the
 * WRONG `tipo` behind; the handler never reads it on this path, and the
 * ownership proof is a digest, not a conta lookup.)
 *
 * What this proves that no in-memory unit test can, in five layers:
 *
 *   (a) the TRIGGER FIRES at all. `onNfeAprovadaShopee` binds the NAMED
 *       `default` database (inlined at build time) and a path derived from
 *       `nfeMeta`; a trigger bound to `(default)` or to a guessed path DEPLOYS
 *       and never fires, and `index.test.ts` can only read its `__endpoint`.
 *       Nothing else in this lane asserts on a trigger's effect — the stock
 *       suite names the link trigger and asserts nothing about it.
 *   (b) the transition edge on a REAL create (`before` absent), the sale gate,
 *       and the ownership proof on a real pedido document — the trigger
 *       enqueues only when all three pass, and a refusal at any of them is one
 *       log line and NO document, so the poll would time out.
 *   (c) the dispatched BUNDLE carries an `onTaskDispatched` at the exact name
 *       the scheduler enqueues against, in the region it resolves, and the
 *       trigger's enqueue reaches it: a half-rename or a region drift is the
 *       silent drop of #1108. And `tarefaNfeShopeeSchema` (`.strict()`) parses
 *       the payload ROUND-TRIPPED THROUGH CLOUD TASKS' JSON — a refused payload
 *       is dropped with one log line and writes nothing.
 *   (d) the aviso seam on a real engine: the deterministic chave (one row per
 *       `(tipo, conta, pedido)`, no NF-e id), the structured params (the
 *       display number and the motivo's FIXED sentence, never Shopee text),
 *       and `ocorrencias` through a real `FieldValue.increment`.
 *   (e) the class-C stamp through a REAL transaction and the real admin handle:
 *       `tx.update` masks at the top-level key, so the block is rebuilt WHOLE —
 *       the step-7 diary (`pacotes`), `freteInicial.ultimaModificacao` and every
 *       other field of the frete must come back unchanged beside `estado:
 *       error`, and the top-level `ultimaModificacao` must move in MICROSECONDS
 *       while `lastMarketplaceUpdate` (step 5's order clock) does not move.
 *
 * ⚠️ THE DELAY — read this before touching the poll. The trigger enqueues with
 * `scheduleDelaySeconds: ATRASO_SERPRO_S` (the SERPRO window, six minutes), and
 * the tasks emulator IGNORES `scheduleDelaySeconds` — dispatch is pure FIFO
 * (firebase-tools#8254, open). This suite finishes inside its poll ONLY because
 * of that. It therefore proves NOTHING about the delay: that the enqueue
 * carries it is pinned offline in `../../../functions/src/onNfeAprovadaShopee.test.ts`.
 * If a firebase-tools bump ever honours the delay, every run here waits six
 * minutes and times out — the fix is then to split the hop (assert the
 * trigger's enqueue, and drive the handler with a direct undelayed enqueue),
 * never to lengthen the poll past the job's budget.
 *
 * ⚠️ NOT covered, and deliberately not asserted:
 *   - the UPLOAD itself, the pre-read, the read-back and every classification
 *     of a Shopee answer. All of them need a Shopee call; they are pinned
 *     offline in `processarNfe.test.ts` and `reverificacaoNfe.test.ts`.
 *   - every other DELAY: the SERPRO re-enqueues, the burst pause, the daily
 *     park and the ~15-min recheck — the emulator ignores all of them, so a test
 *     here would pass for the wrong reason (reconcile R-y dropped the recheck
 *     case for exactly that: both phases reach the same outcome).
 *   - the transition NEGATIVE (a rewrite of an already-approved NF-e enqueues
 *     nothing). An absence cannot be polled honestly; it is pinned offline in
 *     `onNfeAprovadaShopee.test.ts`, with the valve and the ownership refusals.
 *   - `retryConfig` / `rateLimits` / the two secrets / the absence of a
 *     `region:` key — asserted off `__endpoint` in `processNfeUpload.test.ts`
 *     and `index.test.ts`.
 *   - the `/enviar-nfe` route (no auth emulator in this config) and the
 *     `enviar:nfe` CLI (in-process, it never enqueues).
 *   - Mercado Livre's `onNfeAprovada` on the same path: only the `shopee`
 *     codebase artifact is loaded here, so the cross-fire cannot be observed.
 *
 * ⚠️ The clock. This file reads the wall clock for TEST-LOCAL purposes only:
 * the seeded stamps and the poll's own deadline. None is a production clock
 * read — every module under `nfe/` takes its instant as a parameter, and the
 * folder's discipline greps skip every `*.test.ts`, which is why the name may
 * appear here and in no source beside it.
 *
 * ⚠️ Fixture ids only, and none of them is real: `int-1`, the step-5 fixture
 * order number, `PKG-TESTE-1`. The proc is SYNTHETIC — cUF 99 (no such UF), no
 * access key anywhere (no `Id` on `infNFe`, no `chNFe`), no CNPJ, no party. No
 * token, no credential and no real shop appears anywhere.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  avisoCollection,
  nfev4Collection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import { shopeeOrderDetailRowSchema } from '@delfrance/integrations-shopee';
import {
  CANAL_AVISO,
  ESTADO_FRETE,
  ESTADO_NFE,
  ESTADO_PEDIDO,
  INTEGRACAO_FRETE,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  decideNfeUploadTransition,
  extractTpAmb,
} from '@delfrance/schemas';

import { getAdminFirestore } from '../../firebase/admin';
import { FONTE_PACOTE_SHOPEE } from '../pedidos/freteShopeeMapping';
import { mapearFreteInicialShopee } from '../pedidos/orderFreteMapping';
import { makePedidoIdShopee } from '../pedidos/orderIds';
import { chaveAvisoNfeShopee } from './avisoNfe';
import { preverCarimboNfeShopee } from './carimboFreteNfe';
import {
  MOTIVO_NFE_SHOPEE,
  MOTIVOS_QUE_AVISAM,
  MOTIVOS_QUE_CARIMBAM,
  fraseDoErroDoAviso,
} from './errosNfe';
import { chaveDoProc, finalidadeDoProc } from './notaNaShopee';
import { avaliarPedidoParaNfeShopee } from './pedidoNfe';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
/** The tasks emulator is the half this suite exists for — gate on it too. */
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

const INTEGRACAO_ID = 'int-1';
/** The step-5 fixture order number. Not a real order. */
const ORDER_SN = '260910KJBHUJDM';
/** The DIGEST id — the ownership proof both the trigger and the handler recompute. */
const PEDIDO_ID = makePedidoIdShopee(INTEGRACAO_ID, ORDER_SN);
const NFE_ID = 's1';
/** One row per (tipo, conta, pedido) — no NF-e id in it. */
const CHAVE_AVISO = chaveAvisoNfeShopee(INTEGRACAO_ID, PEDIDO_ID);
/** A visibly fake package number, the step-7 diary's key. */
const PACOTE = 'PKG-TESTE-1';

/**
 * A synthetic tpAmb-1 SALE proc that carries NO access key: `infNFe` has no
 * `Id` and `infProt` no `chNFe`. Legible to the sale gate (`tpNF` 1, `finNFe`
 * 1), `tpAmb` 1 in both places, and unreadable to the key reader — which is
 * the ONE thing the handler refuses on here.
 */
const PROC_SEM_CHAVE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">',
  '<NFe><infNFe versao="4.00"><ide><cUF>99</cUF><mod>55</mod>',
  '<tpNF>1</tpNF><tpAmb>1</tpAmb><finNFe>1</finNFe>',
  '</ide><emit><xNome>TESTE SINTETICO SEM VALOR FISCAL</xNome></emit>',
  '</infNFe></NFe>',
  '<protNFe versao="4.00"><infProt><tpAmb>1</tpAmb><cStat>100</cStat></infProt></protNFe>',
  '</nfeProc>',
].join('');

function db() {
  return getAdminFirestore();
}

/**
 * The pedido as step 5 CREATES it — `salvarPedidoShopee`'s create body, through
 * the same `pedidoCollection.parse` — with the `freteInicial` produced by step
 * 5's OWN mapper (never a hand-written copy of its shape), plus one step-7
 * diary row, so the stamp has a `pacotes` array to lose.
 */
function pedidoDoPasso5(agoraUs: number): Record<string, unknown> {
  const watermarkUs = agoraUs - 120_000_000;
  const detalhe = shopeeOrderDetailRowSchema.parse({
    order_sn: ORDER_SN,
    region: 'BR',
    order_status: 'READY_TO_SHIP',
    estimated_shipping_fee: 1.99,
    // EXACTLY one package, so step 5 writes its number as `externalId`.
    package_list: [{ package_number: PACOTE, logistics_status: 'LOGISTICS_NOT_START' }],
  });
  const { frete } = mapearFreteInicialShopee({ detalhe, escrow: null, watermarkUs });
  return {
    ehSaida: true,
    estado: ESTADO_PEDIDO.pago,
    numero: ORDER_SN,
    // The proof reads the conta off this ref and recomputes the id from it.
    integracaoPedidoOuterRef: `documents/integracao/${INTEGRACAO_ID}`,
    itens: {},
    itensIds: [],
    freteInicial: {
      ...frete,
      // A diary row as step 7 writes it. The block's `estado` stays step 5's
      // seed (`iniciado`), which is inside the stampable set.
      pacotes: [
        {
          numero: PACOTE,
          estado: ESTADO_FRETE.iniciado,
          estadoMarketplace: 'LOGISTICS_NOT_START',
          codRastreio: null,
          canalId: null,
          prazoDespacho: null,
          atualizadoEm: agoraUs - 30_000_000,
          fonte: FONTE_PACOTE_SHOPEE.packageDetail,
        },
      ],
    },
    bloquearEmissaoNFe: false,
    timestamp: watermarkUs,
    ultimaModificacao: agoraUs - 60_000_000,
    lastMarketplaceUpdate: watermarkUs,
  };
}

/** The NF-e document, every field the strict schema requires, and NO key. */
function nfeAprovadaSemChave(agoraMs: number): Record<string, unknown> {
  return {
    numeracao: 1,
    serie: 1,
    estado: ESTADO_NFE.aprovada,
    chave: null,
    idLote: null,
    infNFe: null,
    xml_nfe_proc: PROC_SEM_CHAVE,
    xml_epec_proc: null,
    xml_assinado: null,
    nRec: null,
    retries: null,
    cStat: '100',
    xMotivo: 'Autorizado o uso da NF-e',
    justificativaContingencia: null,
    error: null,
    data_autorizacao: agoraMs,
  };
}

/**
 * Poll until the DISPATCHED function has done BOTH of its writes: the aviso
 * (first) and the frete stamp (second, `aplicar`'s order).
 *
 * The chain is create → trigger → enqueue → tasks emulator → functions emulator
 * → handler, so there is no promise to await, only the effects — and
 * `emulators:exec` tears the suite down the moment the script exits, so waiting
 * on the effect is also what keeps an in-flight dispatch from being killed.
 *
 * ⚠️ Like the stock suite's `esperarRecusa`, the pedido EXISTS from the start,
 * so the wait is on a FIELD, and the diagnostic says which half it found. It
 * prints SLUGS only (the aviso's motivo, the frete's estado), never a document:
 * the aviso's params carry the order number.
 */
async function esperarAvisoECarimbo(timeoutMs = 45_000): Promise<{
  aviso: FirebaseFirestore.DocumentData;
  pedido: FirebaseFirestore.DocumentData;
}> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [avisoSnap, pedidoSnap] = await Promise.all([
      avisoCollection.docRef(db(), {}, CHAVE_AVISO).get(),
      pedidoCollection.docRef(db(), {}, PEDIDO_ID).get(),
    ]);
    const aviso = avisoSnap.data();
    const pedido = pedidoSnap.data();
    const frete = pedido?.freteInicial as Record<string, unknown> | undefined;
    if (aviso && pedido && frete?.estado === ESTADO_FRETE.error) return { aviso, pedido };
    if (Date.now() > deadline) {
      throw new Error(
        `em ${String(timeoutMs)}ms a função despachada não fez as DUAS escritas: aviso ` +
          `${aviso ? `presente (motivo ${String(aviso.motivo)})` : 'AUSENTE'}, frete ` +
          `${frete ? `em ${String(frete.estado)}` : 'AUSENTE'}. As causas usuais, nesta ordem: ` +
          '(1) NADA escrito ⇒ o GATILHO não disparou ou não enfileirou — o banco (o bundle ' +
          'fixa FIREBASE_DATABASE_ID=`default` no build; um gatilho em `(default)` faz deploy ' +
          'e NUNCA dispara), um artefato velho (prepare-deploy.mjs não rodou antes do ' +
          'emulators:exec, então .deploy/shopee-functions não tem onNfeAprovadaShopee), ou a ' +
          'fila não registrada (export processShopeeNfeUpload renomeado de um lado só — aí o ' +
          'enqueue do gatilho LANÇA e o log do emulador mostra); (2) NADA escrito e o gatilho ' +
          'logou `enfileirado` ⇒ DERIVA DE REGIÃO, SHOPEE_TASKS_REGION diferente do ' +
          'FUNCTIONS_REGION embutido no bundle (#1108): o Cloud Tasks aceitou e nunca entregou; ' +
          '(3) NADA escrito e a tarefa aparece agendada ⇒ o emulador passou a HONRAR ' +
          'scheduleDelaySeconds (firebase-tools#8254 corrigido): o gatilho atrasa ' +
          'ATRASO_SERPRO_S — leia a nota THE DELAY no topo deste arquivo; (4) aviso com motivo ' +
          '`tasks-desabilitadas` e frete intacto ⇒ SHOPEE_TASKS_DISABLED chegou ao processo do ' +
          'emulador e o gatilho avisou em vez de enfileirar; (5) aviso `xml-invalido` e frete ' +
          'fora de `error` ⇒ a transação do carimbo recusou (leia o `carimbo` na linha de ' +
          'conclusão do handler no log do emulador).',
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeEach(async () => {
  // Children first: deleting a pedido does not delete its subcollection. Each
  // NF-e delete fires the trigger, which answers `apagada` at T1 — silently.
  const nfes = await nfev4Collection.ref(db(), { pedidoId: PEDIDO_ID }).listDocuments();
  await Promise.all(nfes.map((r) => r.delete()));
  await pedidoCollection.docRef(db(), {}, PEDIDO_ID).delete();
  await avisoCollection.docRef(db(), {}, CHAVE_AVISO).delete();
});

describe.skipIf(!EMULATED || !TASKS)(
  'NF-e aprovada Shopee → gatilho → Cloud Tasks → onTaskDispatched',
  () => {
    it('uma NF-e de VENDA tpAmb 1 criada `aprovada` SEM chave ⇒ aviso `xml-invalido` + frete em `error` com `pacotes` preservados, sem chamar a Shopee', async () => {
      const agoraMs = Date.now();
      const agoraUs = agoraMs * 1000;
      const pedidoSemente = pedidoDoPasso5(agoraUs);
      const nfeSemente = nfeAprovadaSemChave(agoraMs);

      // ---- Preconditions: the pure halves the chain crosses, on THIS fixture.
      // A drifted fixture then fails HERE, naming itself, instead of spending
      // the 45-second poll and blaming the queue.
      expect(extractTpAmb(PROC_SEM_CHAVE)).toBe('1');
      expect(finalidadeDoProc(PROC_SEM_CHAVE)).toBe('venda');
      expect(chaveDoProc(PROC_SEM_CHAVE)).toEqual({ erro: 'sem-chave' });
      expect(decideNfeUploadTransition(undefined, nfeSemente)).toEqual({ action: 'enqueue' });
      expect(avaliarPedidoParaNfeShopee(PEDIDO_ID, pedidoSemente)).toEqual({
        acao: 'enfileirar',
        contaId: INTEGRACAO_ID,
        orderSn: ORDER_SN,
      });
      expect(MOTIVOS_QUE_AVISAM.has(MOTIVO_NFE_SHOPEE.xmlInvalido)).toBe(true);
      expect(MOTIVOS_QUE_CARIMBAM.has(MOTIVO_NFE_SHOPEE.xmlInvalido)).toBe(true);

      // ---- The pedido FIRST: the trigger reads it at T2, on the NF-e create.
      await pedidoCollection.set(db(), {}, PEDIDO_ID, pedidoSemente);

      // POSITIVE existence assertion, BEFORE the NF-e exists and before any
      // polling. `vitest.tasks.setup.ts` (3) spells out why this suite owes one:
      // in the emulator a mis-targeted database (`(default)` instead of
      // `default`) silently auto-creates, so a "not found" would pass against an
      // empty namespace. Reading the seed back proves the test and the
      // dispatched function look at the same database.
      const semeado = await pedidoCollection.docRef(db(), {}, PEDIDO_ID).get();
      expect(semeado.exists).toBe(true);
      const antes = semeado.data() ?? {};
      const freteAntes = antes.freteInicial as Record<string, unknown>;
      expect(freteAntes).toMatchObject({
        externalOptionIntegracao: INTEGRACAO_FRETE.shopee,
        estado: ESTADO_FRETE.iniciado,
        externalId: PACOTE,
      });
      expect(freteAntes.pacotes).toHaveLength(1);
      // The stored block really is stampable — so a timeout below cannot be a
      // fixture the stamp's guards refuse.
      expect(preverCarimboNfeShopee(antes, agoraUs).motivo).toBe('carimbado');
      // …and the inbox starts CLEAN, so the aviso below cannot be a leftover.
      expect((await avisoCollection.docRef(db(), {}, CHAVE_AVISO).get()).exists).toBe(false);

      // ---- The NF-e CREATED `aprovada`: the edge the trigger exists for.
      await nfev4Collection.set(db(), { pedidoId: PEDIDO_ID }, NFE_ID, nfeSemente);
      const nfeGravada = (
        await nfev4Collection.docRef(db(), { pedidoId: PEDIDO_ID }, NFE_ID).get()
      ).data();
      expect(nfeGravada).toMatchObject({ estado: ESTADO_NFE.aprovada, chave: null });

      const { aviso, pedido } = await esperarAvisoECarimbo();

      // ---- The aviso: one row per (tipo, conta, pedido), open, our words only.
      expect(aviso).toMatchObject({
        tipo: TIPO_AVISO.nfeUploadRejeitado,
        severidade: SEVERIDADE_AVISO.atencao,
        canal: CANAL_AVISO.shopee,
        motivo: MOTIVO_NFE_SHOPEE.xmlInvalido,
        // Exactly the two params the web wording interpolates: the DISPLAY
        // number the proof recovered, and the motivo's FIXED sentence.
        params: {
          pedido: ORDER_SN,
          erro: fraseDoErroDoAviso(MOTIVO_NFE_SHOPEE.xmlInvalido, null),
        },
        urlInterna: { rota: ROTAS_AVISO.pedido.build(PEDIDO_ID), campo: null },
        // ONE fire, ONE task, ONE aviso — the increment ran on a real engine.
        ocorrencias: 1,
        resolvidoEm: null,
      });
      expect(Object.keys(aviso.params as Record<string, unknown>).sort()).toEqual([
        'erro',
        'pedido',
      ]);
      expect(typeof aviso.criadoEm).toBe('number');

      // ---- The stamp: the WHOLE block rebuilt from the transaction's own read.
      // `pacotes`, `externalId`, `valorCobrado`, `freteInicial.ultimaModificacao`
      // and every default the create filled in come back unchanged; only the
      // estado moved. A patch that dropped the spread would erase them.
      expect(pedido.freteInicial).toEqual({ ...freteAntes, estado: ESTADO_FRETE.error });

      // The top-level clock moved FORWARD, in MICROSECONDS: a millisecond stamp
      // (~1.7e12) would lose `maiorUs` to the seeded µs value and leave it equal.
      const depoisUs = Date.now() * 1000;
      expect(pedido.ultimaModificacao).toBeGreaterThan(antes.ultimaModificacao as number);
      expect(pedido.ultimaModificacao).toBeLessThanOrEqual(depoisUs + 60_000_000);

      // Step 5's ORDER clock is never the stamp's to write, and nothing else of
      // the pedido moved.
      expect(pedido.lastMarketplaceUpdate).toBe(antes.lastMarketplaceUpdate);
      expect(pedido).toMatchObject({
        estado: antes.estado,
        numero: ORDER_SN,
        integracaoPedidoOuterRef: antes.integracaoPedidoOuterRef,
        bloquearEmissaoNFe: false,
      });

      // The NF-e document itself is never written by this path — the aviso and
      // the stamp are its only two writes.
      expect(
        (await nfev4Collection.docRef(db(), { pedidoId: PEDIDO_ID }, NFE_ID).get()).data(),
      ).toEqual(nfeGravada);
    });
  },
);
