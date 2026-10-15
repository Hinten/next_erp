/**
 * The step-12 STOCK PUSH through the Cloud Tasks hop, end to end, against the
 * real emulators (`ci-shopee.yml`) — the FOURTH `*.tasks.test.ts` of this
 * codebase and the first to drive the THIRD queue.
 *
 * What runs for real here, with nothing mocked:
 *
 *   createShopeeStockTaskScheduler().enqueue(tarefa)   the real scheduler
 *     → the real region-qualified queue name (SHOPEE_STOCK_SEND_QUEUE)
 *     → Cloud Tasks emulator → Functions emulator
 *     → sendShopeeStock                    the real deployed onTaskDispatched
 *     → processShopeeStockSendTask
 *     → step 0   shopeeStockSendTaskSchema parses the JSON round trip
 *     → step 0.5 the master valve is OPEN (SHOPEE_STOCK_SYNC_ENABLED=1)
 *     → step 1   the chunker's cut: 51 > MAX_MODELOS_POR_TASK
 *     → registrarRecusaDeEstoque           a FLAT mergeIfExists on the link doc
 *
 * ⚠️ Why the 51-model task specifically, and why it is the only outcome that
 * can live here. The lane's non-localhost `fetch` kill-switch lives in the
 * VITEST process and does NOT cover the dispatched function, which runs in the
 * emulator's own process (`vitest.tasks.setup.ts` (4)) — so any path that
 * reached a Shopee call would really leave the runner. Rung 1 cannot: it sits
 * ABOVE the pause gate, above the context load and above the client, so there
 * is no token, no secret and no client when it answers. Zero Shopee calls by
 * CALL ORDER, not by a mock — the discipline
 * `../produtos/importacaoMassa.tasks.test.ts` uses for its wrong-`tipo` conta.
 * And the outcome still PERSISTS, so the assertion is about a document the
 * dispatched function wrote, not about the absence of one.
 *
 * ⚠️ There is deliberately NO `integracao` document. The guard is above the
 * context load, so seeding one would only invite a later reader to think the
 * conta mattered here.
 *
 * What this proves that no `fakeDb` unit test can, in four layers:
 *
 *   (a) the dispatched BUNDLE really carries an `onTaskDispatched` at the exact
 *       name the scheduler enqueues against, in the region it resolves. A
 *       half-rename (`sendStock.ts`'s export vs `SHOPEE_STOCK_SEND_QUEUE`) and
 *       a region drift are both the silent drop of #1108 — the enqueue reports
 *       success and Cloud Tasks never delivers. Here it surfaces in seconds.
 *   (b) `shopeeStockSendTaskSchema` parses a payload ROUND-TRIPPED THROUGH
 *       CLOUD TASKS' JSON. `itemId` and `modelId` have to survive as NUMBERS —
 *       a stringified id matches nothing, silently, and `modelId: 0` is a legal
 *       value this wire carries end to end. A schema that drifted from the
 *       planner's payload answers `payload-invalido` and writes NOTHING, so the
 *       poll would time out rather than find the wrong row.
 *   (c) the FLAT `mergeIfExists` write-back lands through the real admin handle
 *       against a real Firestore engine. `fakeDb` cannot show that `update()`
 *       is accepted on a document the write did not first read, nor that the
 *       eight stamped keys round-trip through Firestore's own types.
 *   (d) the lane's env really satisfies `SHOPEE_STOCK_SYNC_ENABLED=1`. With the
 *       flag unset the handler answers `pulado` at step 0.5 and writes NOTHING,
 *       so the poll times out — which makes the master valve a VERIFIED gate
 *       rather than a documented one.
 *
 * ⚠️ NOT covered, and deliberately not asserted:
 *   - every arm below rung 1. All of them need a Shopee call; they are pinned
 *     offline in `enviarEstoque.test.ts` against `../testing/fakeDb.ts`.
 *   - the PAUSE rung's re-enqueue and the burst arm. Both set
 *     `scheduleDelaySeconds`, which the tasks emulator IGNORES
 *     (firebase-tools#8254, open), so this lane can neither observe the delay
 *     nor be trusted about it.
 *   - `retryConfig` / `rateLimits` / the absence of a `region:` key. Emulated or
 *     baked at deploy time, and cheaper to assert off `__endpoint` —
 *     `../../../functions/src/sendStock.test.ts` does that.
 *   - the link TRIGGER. `onProdutoShopeeLinkChanged` does fire — once on the
 *     seed, where it plans a real `integracoesComProduto` addition, and once on
 *     the write-back, where the plan is EMPTY because neither `item_id` nor
 *     `estadoAnuncio` moved. Nothing here asserts either; it is named so that a
 *     reader watching the emulator log knows both are expected.
 *
 * ⚠️ The clock. This file reads the wall clock for exactly two TEST-LOCAL
 * purposes: the seeded millisecond stamp and the poll's own deadline. Neither
 * is a production clock read — every module under `estoque/` takes its instant
 * as a parameter (`deps.nowMs`), and the folder's discipline greps skip every
 * `*.test.ts`, which is why the name may appear here and in no source beside
 * it. Verbatim the `../notificacoes/pushAnuncio.tasks.test.ts` precedent.
 *
 * ⚠️ Fixture ids only, and none of them is real: `int-1`, `prod-1`, `link-1`,
 * `2500139861` is the step-11 fixture item id and `2000458802` the fixture
 * model id. No token, no credential and no real shop appears anywhere.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { produtoCollection, produtoShopeeLinkCollection } from '@delfrance/data/admin/collections';

import { getAdminFirestore } from '../../firebase/admin';
import { MAX_MODELOS_POR_TASK } from './constantesEstoque';
import { MOTIVO_ESTOQUE_SHOPEE } from './errosEstoque';
import type { TarefaDeEstoqueShopee } from './planoEstoque';
import { createShopeeStockTaskScheduler } from './shopeeStockTasks';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
/** The tasks emulator is the half this suite exists for — gate on it too. */
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

/** The family anchor — the produto that owns the `prodshopee` link. */
const PRODUTO_ID = 'prod-1';
/** The `prodshopee` document id: the write-back target, never re-resolved. */
const LINK_DOC_ID = 'link-1';
const INTEGRACAO_ID = 'int-1';
/** The step-11 fixture item id. Not a real listing. */
const ITEM_ID = 2500139861;
/** The fixture model id; the task's 51 models run from here upward. */
const MODEL_ID_BASE = 2000458802;

/**
 * One MORE than the chunker's cut, which is what rung 1 refuses.
 *
 * ⚠️ Derived, never typed as 51: `MAX_MODELOS_POR_TASK` is Shopee's own
 * `update_stock` ceiling re-exported through `constantesEstoque.ts`, and a test
 * that hardcoded the number would keep passing — against the WRONG arm — the
 * day the provider moves it.
 */
const MODELOS_ACIMA_DO_LIMITE = MAX_MODELOS_POR_TASK + 1;

function db() {
  return getAdminFirestore();
}

/** The seeded link doc — the minimum `produtoShopeeLinkSchema` accepts. */
function linkAtivo() {
  return {
    // ⚠️ `documents/<col>/<id>`, the outerRef format the schema's regex demands.
    contaProdutoShopeeOuterRef: `documents/integracao/${INTEGRACAO_ID}`,
    item_name: 'Anúncio de teste — não é um anúncio real',
    item_id: ITEM_ID,
    // The fingerprint half rung 1 stamps back. `item_status` stays absent, so
    // the other half must land as a PRESENT null.
    estadoAnuncio: 'ativo',
  };
}

/** The 51-model payload, exactly §2.8's eleven keys and nothing else. */
function tarefaAcimaDoLimite(nowMs: number): TarefaDeEstoqueShopee {
  return {
    integracaoId: INTEGRACAO_ID,
    produtoId: PRODUTO_ID,
    linkDocId: LINK_DOC_ID,
    itemId: ITEM_ID,
    categoryId: null,
    sweepId: 'sweep-1',
    sweepComputadoEmMs: nowMs,
    reenfileiramentos: 0,
    parte: 1,
    totalDePartes: 1,
    modelos: Array.from({ length: MODELOS_ACIMA_DO_LIMITE }, (_, i) => ({
      // DISTINCT and ascending — a duplicate would be a different refusal.
      modelId: MODEL_ID_BASE + i,
      produtoId: PRODUTO_ID,
      varLinkDocId: null,
      quantidade: 1,
    })),
  };
}

/**
 * Poll the LINK document until the DISPATCHED function stamps the refusal.
 *
 * The task travels enqueue → tasks emulator → functions emulator → handler, so
 * there is no promise to await, only the effect — and `emulators:exec` tears the
 * suite down the moment the script exits, so waiting on the effect is also what
 * keeps an in-flight dispatch from being killed.
 *
 * ⚠️ Like the mass import's `esperarSairDeRunning`, the document EXISTS from the
 * start (this suite seeds it), so the wait is on a FIELD, not on arrival — and
 * the diagnostic has to say which of the two shapes it found.
 */
async function esperarRecusa(
  timeoutMs = 45_000,
): Promise<FirebaseFirestore.DocumentData | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await produtoShopeeLinkCollection
      .docRef(db(), { produtoId: PRODUTO_ID }, LINK_DOC_ID)
      .get();
    const data = snap.data();
    if (data && typeof data.estoqueRecusaEm === 'number') return data;
    if (Date.now() > deadline) {
      throw new Error(
        `o vínculo ${PRODUTO_ID}/${LINK_DOC_ID} continuou sem estoqueRecusaEm por ` +
          `${String(timeoutMs)}ms — a função despachada nunca o carimbou. As quatro ` +
          'causas usuais, nesta ordem: (1) DERIVA DE REGIÃO — SHOPEE_TASKS_REGION (o ' +
          'enqueue) diferente do FUNCTIONS_REGION embutido no bundle, o descarte ' +
          'silencioso que shopeeStockTasks.ts descreve (#1108); (2) prepare-deploy.mjs ' +
          'NÃO rodou antes do emulators:exec, então .deploy/shopee-functions está velho ' +
          'ou ausente (emulators:exec não executa hooks predeploy); (3) a FILA não foi ' +
          'registrada — o emulador de functions é quem a cria a partir das definições de ' +
          'trigger, então sem ele, ou com o export sendShopeeStock renomeado de um lado ' +
          'só, o enqueue dá 404; (4) SHOPEE_STOCK_SYNC_ENABLED não chegou ao processo do ' +
          'emulador, e aí o passo 0.5 responde `pulado` e NÃO escreve nada. ' +
          '⚠️ Se o enqueue tivesse falhado, o erro teria vindo dele, não daqui: chegar ' +
          'neste ponto significa que o Cloud Tasks ACEITOU a tarefa e nunca a entregou. ' +
          `Estado atual do documento: ${JSON.stringify(data ?? null)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeEach(async () => {
  const antigos = await produtoShopeeLinkCollection
    .ref(db(), { produtoId: PRODUTO_ID })
    .listDocuments();
  await Promise.all(antigos.map((r) => r.delete()));
  await produtoCollection.docRef(db(), {}, PRODUTO_ID).delete();
});

describe.skipIf(!EMULATED || !TASKS)(
  'envio de estoque Shopee → Cloud Tasks → onTaskDispatched',
  () => {
    it('uma tarefa com modelos ACIMA do corte carimba `task-excede-limite` no vínculo, sem chamar a Shopee', async () => {
      const agoraMs = Date.now();

      // The parent produto. It is not read by rung 1 — it is seeded because the
      // link trigger writes `integracoesComProduto` onto it, and because a
      // subcollection under a missing parent is legal but confusing to inspect.
      await produtoCollection.set(db(), {}, PRODUTO_ID, {
        nome: 'Produto de teste — envio de estoque',
      });
      await produtoShopeeLinkCollection.set(
        db(),
        { produtoId: PRODUTO_ID },
        LINK_DOC_ID,
        linkAtivo(),
      );

      // POSITIVE existence assertion, BEFORE the enqueue and before any polling.
      // `vitest.tasks.setup.ts` (3) spells out why this suite owes one: in the
      // emulator a mis-targeted database (`(default)` instead of `default`)
      // silently auto-creates, so every "not found" / "still null" assertion
      // would pass against an empty namespace. Reading the seed back proves the
      // test and the dispatched function look at the same database.
      const semeado = await produtoShopeeLinkCollection
        .docRef(db(), { produtoId: PRODUTO_ID }, LINK_DOC_ID)
        .get();
      expect(semeado.exists).toBe(true);
      expect(semeado.data()).toMatchObject({ item_id: ITEM_ID, estadoAnuncio: 'ativo' });
      // …and that it starts CLEAN, so the refusal below cannot be a leftover.
      expect(semeado.data()?.estoqueRecusaEm ?? null).toBeNull();

      const tarefa = tarefaAcimaDoLimite(agoraMs);
      expect(tarefa.modelos).toHaveLength(MODELOS_ACIMA_DO_LIMITE);
      expect(new Set(tarefa.modelos.map((m) => m.modelId)).size).toBe(MODELOS_ACIMA_DO_LIMITE);

      // The REAL scheduler against the REAL emulated queue. A 404 here is a
      // finding, not a flake — see the four causes in `esperarRecusa`.
      await createShopeeStockTaskScheduler().enqueue(tarefa);

      const link = await esperarRecusa();

      expect(link).toMatchObject({
        // ⚠️ `erp:` and the slug, VERBATIM — `codigoDoErp`'s one spelling. The
        // field is a loose string no reader parses today, which is exactly why
        // a second spelling (`erp-`, `erp/`) would sit in the corpus for ever
        // with nothing failing.
        estoqueRecusaCodigo: `erp:${MOTIVO_ESTOQUE_SHOPEE.taskExcedeLimite}`,
        estoqueRecusaMotivo: MOTIVO_ESTOQUE_SHOPEE.taskExcedeLimite,
        // ⚠️ BOTH fingerprint halves, exactly as READ. `estadoAnuncio` was
        // seeded; `item_status` was not, and a PRESENT null is what lets the
        // skip set compare two recorded readings instead of guessing one.
        estoqueRecusaEstado: 'ativo',
        estoqueRecusaItemStatus: null,
        // ⚠️ `null`, not a number: `ate` is the PROMOTION arm's alone. A stamp
        // here would latch a time-based skip on a refusal a re-chunk fixes.
        estoqueRecusaAte: null,
      });
      expect(typeof link?.estoqueRecusaEm).toBe('number');
      expect(link?.estoqueRecusaEm).toBeGreaterThan(0);
      expect(typeof link?.estoqueRecusaMensagem).toBe('string');
      expect(String(link?.estoqueRecusaMensagem).length).toBeGreaterThan(0);

      // ⚠️ The listing was never declared in sync, and this is the assertion
      // that says the CLEARER did not run: `registrarEnvioLimpo` is the only
      // writer of `estoqueEnviadoEm`, and a refusal that stamped it would make
      // every child row read as stale the instant it landed.
      expect(link?.estoqueEnviadoEm ?? null).toBeNull();
      expect(link?.estoqueEnviado ?? null).toBeNull();
      expect(link?.estoqueModelosEnviados ?? null).toBeNull();

      // The seeded identity survived the patch — `mergeIfExists` is an
      // `update()`, so a patch that had been flattened wrongly (a dotted key, a
      // nested map) would have thrown rather than written a subtly different
      // document, and a patch that had been a `merge()` upsert could have
      // resurrected a ghost holding only the eight refusal keys.
      expect(link).toMatchObject({
        item_id: ITEM_ID,
        contaProdutoShopeeOuterRef: `documents/integracao/${INTEGRACAO_ID}`,
      });
    });
  },
);
