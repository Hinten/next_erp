/**
 * The step-13 account-wide PRICE JOB through the Cloud Tasks hop, end to end,
 * against the real emulators (`ci-shopee.yml`) — the FIFTH `*.tasks.test.ts` of
 * this codebase and the first to drive the FOURTH queue.
 *
 * What runs for real here, with nothing mocked:
 *
 *   iniciarEnvioPrecoShopee                the real start: the one-active query,
 *                                          the job document, its `expiraEm`
 *   createShopeePriceSyncScheduler().enqueue({ jobId, integracaoId })
 *     → the real region-qualified queue name (SHOPEE_PRICE_SYNC_QUEUE)
 *     → Cloud Tasks emulator → Functions emulator
 *     → processShopeePriceSync             the real deployed onTaskDispatched
 *     → processarEnvioPrecoShopee
 *     → loadShopeeContext                  Firestore + env only, no client
 *     → lerPaginaDeFamiliasDePreco         the CLASSIC keyset discovery
 *     → montarItensDePreco                 the pure planner
 *     → the per-page batch checkpoint      job patch + report shard, ONE batch
 *     → the self re-enqueue                onto the SAME queue
 *     → finalizarEnvioPrecoShopee          the ONE transaction (class B)
 *
 * Three cases, one per terminal path a dispatch can reach with NO Shopee call:
 *
 *   1. `completed` — four anchors that all skip at PLAN time, over at least two
 *      pages, so the job has to re-enqueue itself to finish.
 *   2. `noop` — a job the operator cancelled before its first dispatch.
 *   3. `failed` — a conta of the WRONG `tipo`, stamped on the FIRST attempt.
 *
 * ⚠️ Why these outcomes specifically, and why they are the only ones that may
 * live here. The lane's non-localhost `fetch` kill-switch lives in the VITEST
 * process and does NOT cover the dispatched function, which runs in the
 * emulator's own process (`vitest.tasks.setup.ts` (4)) — so any path that
 * reached a Shopee call would really leave the runner. None of these can, by
 * CALL ORDER and never by a mock:
 *   - the job's only Shopee calls are in the DRAIN (the conta verdict's shop
 *     read, the batched base read, `update_price`), and the drain runs only
 *     while `fila` holds a listing. Every family of case 1 is refused by the
 *     planner, so `fila` never fills, and the dispatch builds no client;
 *   - a SECOND barrier sits behind that one: the Shopee conta seeded here has NO
 *     `shop_id`, and the verdict's first rung refuses `sem-shop-id` before it
 *     builds a client. So a planner regression that let a listing through would
 *     end the job `failed` — which the `completed` assertion reports — and
 *     still make no call;
 *   - case 2's dispatch answers at the job read, before the context load;
 *   - case 3's `loadShopeeContext` refuses on `tipo` before `shopeeConfig()`,
 *     before the credential store and before a client exists, and the context
 *     load is the FIRST statement of the dispatch's `try` — the discipline
 *     `../produtos/importacaoMassa.tasks.test.ts` uses for the mass import.
 * And every outcome still PERSISTS, so each assertion is about a document the
 * dispatched function wrote (or, in case 2, provably did not rewrite).
 *
 * What this proves that no `fakeDb` unit test can:
 *
 *   (a) the dispatched BUNDLE carries an `onTaskDispatched` at the exact name
 *       the scheduler enqueues against, in the region it resolves. A
 *       half-rename (`processPriceSync.ts`' export vs `SHOPEE_PRICE_SYNC_QUEUE`)
 *       or a region drift is the silent drop of #1108 — the enqueue reports
 *       success and Cloud Tasks never delivers. ⚠️ And for THIS queue the
 *       self-continuation is where a half-rename bites (the start still lands):
 *       case 1 needs at least one re-enqueue to finish, so it catches it.
 *   (b) `envioPrecoShopeeTaskSchema` (`.strict()`) parses a payload
 *       ROUND-TRIPPED THROUGH CLOUD TASKS' JSON — the job's own re-enqueue
 *       included. A refused payload is dropped with one log line and writes
 *       NOTHING, so the poll would time out rather than find a wrong state.
 *   (c) the CLASSIC discovery on a real engine: `paiId == null` +
 *       `integracoesComProduto array-contains` + `orderBy(__name__)` +
 *       `startAfter(<id>)` + the `select()` masks, across page boundaries, and
 *       the per-anchor join (`prodshopee`, `produtos where paiId ==`,
 *       `variashopee`) with its PROJECTIONS — the family that skips as
 *       `forma-de-modelo-divergente` does so only if `produtoShopeeOuterRef` and
 *       `model_id` survived the projection (drop either and it plans as a
 *       listing, which the second barrier turns into a `failed` job).
 *   (d) the batch checkpoint's nested-map DEEP merge on a real Firestore:
 *       the four rows land in ONE shard from at least two separate checkpoints,
 *       so a `{ merge: true }` that replaced `linhas` instead of merging it
 *       would leave only the last page's rows — the property Mercado Livre
 *       needed a separate `precoRelatorio.firestore.test.ts` for. The same
 *       two PLAN checkpoints are where a real engine applies the job's
 *       counter transforms (`increment` / `maximum` — `relatorioLinhas` must
 *       come out at the four rows) and honours the plan checkpoint's
 *       `lastUpdateTime` precondition on its happy path: a precondition the
 *       engine refused would answer `noop` and leave the job `running`, and
 *       the poll would time out.
 *   (e) the class-B finalize (`completed`, the cancel, the first-attempt
 *       `failed`) through a REAL transaction, including the synthetic row and
 *       the `relatorioLinhas` / `relatorioShards` it derives from its own
 *       snapshot. (Not `filaRestante`: every finalize here meets an EMPTY
 *       `fila`, so the stored value is 0 before and after — its derivation is
 *       pinned offline, in `atualizarPrecos.test.ts`.)
 *   (f) the TTL stamps as REAL `Timestamp`s: the job's 180 days after
 *       `startedAt` and every shard's 187 — including the shards the DISPATCHED
 *       function wrote, which is the half of the TTL no offline test can read
 *       back through Firestore's own types.
 *
 * ⚠️ NOT covered, and deliberately not asserted:
 *   - the DRAIN (the verdict, the base read, the sender, the per-item
 *     checkpoint). Every one of them needs a Shopee call; they are pinned
 *     offline in `atualizarPrecos.test.ts` and `enviarPreco.test.ts` against
 *     `../testing/fakeDb.ts`.
 *   - the BURST pause and the daily-quota PARK. Both set
 *     `scheduleDelaySeconds`, which the tasks emulator IGNORES
 *     (firebase-tools#8254, open), so this lane can neither observe the delay
 *     nor be trusted about it; both are pinned offline.
 *   - `retryConfig` / `rateLimits` / the absence of a `region:` key — asserted
 *     off `__endpoint` in `../../../functions/src/processPriceSync.test.ts`.
 *   - the link TRIGGER. `onProdutoShopeeLinkChanged` fires once per seeded
 *     `prodshopee`: on a create it can only ADD a conta to the produto's array
 *     (never remove one), so it cannot take an anchor out from under the walk.
 *     Nothing here asserts it; it is named so a reader watching the emulator
 *     log knows four runs are expected per case-1 seed.
 *
 * ⚠️ THE LANE MUST SET `SHOPEE_PRICE_PAGE_LIMIT: '2'`. The page limit is read
 * in the EMULATOR's process, which inherits the job's env exactly as this vitest
 * process does. With the default (25) the four anchors fit in ONE page, the
 * first dispatch completes the job alone, and case 1 would prove neither the
 * re-enqueue (a) nor the deep merge (d). So case 1 checks the limit on BOTH
 * sides instead of passing on a weaker proof: here, it refuses to run unless
 * `pageLimitPreco()` answers exactly 2; and on the emulator's side, it asserts
 * that the dispatch which wrote the last rows is NOT the one that completed the
 * job (the shard's `timestamp` is older than `finishedAt`) — which is what a
 * limit of 2 produces over four anchors (pages [a b], [c d], then an empty one)
 * and what a single-page run cannot.
 *
 * ⚠️ TWO integrações, and which one is which is load-bearing:
 *   - `int-2` is the SHOPEE conta (cases 1 and 2), and
 *   - `int-1` is the WRONG-`tipo` one (case 3) — exactly as the mass-import
 *     suite seeds it.
 * The conta read is a 15-minute read cache in the dispatched process
 * (`../core/contaCache.ts`), so one id seeded with two `tipo`s inside one
 * emulator session could be served the stale one. Giving `int-1` the same
 * wrong `tipo` the mass-import suite gives it keeps the two suites agreeing
 * even if the emulator ever ran every function in one worker. And the stock
 * suite's leftover `prod-1` is an `int-1` anchor, so the `int-2` walk never
 * meets it.
 *
 * ⚠️ The clock. This file reads the wall clock for TEST-LOCAL purposes only:
 * the start instant it hands `iniciarEnvioPrecoShopee` (a route's one read), the
 * poll deadlines and the elapsed-time measurement. None of those is a
 * production clock read — every module under `precos/` takes its instant as a
 * parameter, and the folder's discipline greps skip every `*.test.ts`, which is
 * why the name may appear here and in no source beside it. Verbatim the
 * `../estoque/enviarEstoque.tasks.test.ts` precedent.
 *
 * ⚠️ Fixture ids only, and none of them is real: `int-1`, `int-2`; the anchors
 * carry a per-run prefix; `2500139861` is the step-11 fixture item id (and its
 * three successors) and `2000458802` the fixture model id (and its successor).
 * No token, no credential and no real shop appears anywhere.
 */
import { randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  envioPrecoShopeeCollection,
  integracaoCollection,
  produtoCollection,
  produtoShopeeLinkCollection,
  relatorioEnvioPrecoShopeeCollection,
  variacaoShopeeLinkCollection,
} from '@delfrance/data/admin/collections';
import {
  ENVIO_PRECO_FASE,
  ENVIO_PRECO_RESULTADO,
  ENVIO_PRECO_SHOPEE_STATUS,
  INTEGRACAO_TIPO,
  RELATORIO_ENVIO_PRECO_ERRO_MAX,
  SHOPEE_ITEM_STATUS,
  relatorioEnvioPrecoRowKey,
  relatorioEnvioPrecoShardId,
} from '@delfrance/schemas';

import { getAdminFirestore } from '../../firebase/admin';
import { cancelarEnvioPrecoShopee, iniciarEnvioPrecoShopee } from './atualizarPrecos';
import { pageLimitPreco } from './constantesPreco';
import { MOTIVO_PRECO_SHOPEE } from './errosPreco';
import type { ContextoContaPreco } from './regiaoPreco';
import { createShopeePriceSyncScheduler } from './shopeePriceSyncTasks';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
/** The tasks emulator is the half this suite exists for — gate on it too. */
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

/** The Shopee conta of cases 1 and 2. See the header for why it is not `int-1`. */
const CONTA_SHOPEE = 'int-2';
/** The WRONG-`tipo` conta of case 3 — and "another conta" in case 1's family C. */
const CONTA_OUTRO_TIPO = 'int-1';

/** The step-11 fixture item id. Not a real listing. */
const ITEM_ID = 2500139861;
/** The fixture model id. Not a real model. */
const MODEL_ID = 2000458802;

/**
 * One day in MILLISECONDS, spelled out here on purpose: the TTL assertions
 * below compare against the RETENTION the policy promises, derived
 * independently of the job module's `expiraEm…` helpers — asserting a stamp
 * against the function that computed it would pass whatever the function did.
 */
const DIA_MS = 24 * 60 * 60 * 1000;
/** `RETENCAO_ENVIO_PRECO_SHOPEE_DIAS` — the run's promised life, restated. */
const RETENCAO_JOB_DIAS = 180;
/** The run's life plus the report margin (7) — each shard's promised life, restated. */
const RETENCAO_RELATORIO_DIAS = 187;

/**
 * The first retry's floor, from `processPriceSync.ts`'s
 * `retryConfig.minBackoffSeconds`. Nothing imports it — it lives on the deployed
 * function's options — so it is restated, and case 3's elapsed-time assertion is
 * what would notice if the two disagreed in the direction that matters.
 */
const BACKOFF_MINIMO_S = 30;

/** The anchors case 1 seeds — every one a plan-time skip, so also its row count. */
const ANCORAS_DO_CASO_1 = 4;

/**
 * The page limit case 1 needs the LANE to set (`ci-shopee.yml`'s job env): two
 * full pages of two, then an empty one — so the rows arrive from two
 * checkpoints and the job completes on a third dispatch.
 */
const PAGINA_DO_CASO_1 = 2;

function db() {
  return getAdminFirestore();
}

/**
 * The start's context, WITHOUT the verdict that normally brands it.
 *
 * ⚠️ A deliberate, test-only cast, and the one place this file lies to the
 * compiler. `ContextoContaPreco` is branded so production code can only start a
 * job for a conta the verdict ACCEPTED — and the verdict's accepted arm needs a
 * `get_shop_info` this lane may never make. `iniciarEnvioPrecoShopee` reads
 * exactly ONE field off it (`integracaoId`; the job carries nothing else of the
 * context), so that is the only field supplied. Should the start ever read
 * another, it reads `undefined` here and the job document says so.
 */
function contextoSemVeredito(integracaoId: string): ContextoContaPreco {
  return { integracaoId } as unknown as ContextoContaPreco;
}

/** `documents/<col>/<id>`, the outerRef format the link schemas' regex demands. */
function refDaConta(integracaoId: string): string {
  return `documents/integracao/${integracaoId}`;
}

/** The raw job document (no parse — the TTL stamp must be read as Firestore stored it). */
async function lerJobCru(jobId: string): Promise<FirebaseFirestore.DocumentData | undefined> {
  const snap = await envioPrecoShopeeCollection.docRef(db(), {}, jobId).get();
  return snap.exists ? snap.data() : undefined;
}

/** The shard ids a job's report holds, in key order. */
async function idsDosShards(jobId: string): Promise<string[]> {
  const refs = await relatorioEnvioPrecoShopeeCollection
    .ref(db(), { envioId: jobId })
    .listDocuments();
  return refs.map((r) => r.id).sort();
}

/** One raw shard document, or `undefined`. */
async function lerShardCru(
  jobId: string,
  indice: number,
): Promise<FirebaseFirestore.DocumentData | undefined> {
  const snap = await relatorioEnvioPrecoShopeeCollection
    .docRef(db(), { envioId: jobId }, relatorioEnvioPrecoShardId(indice))
    .get();
  return snap.exists ? snap.data() : undefined;
}

/**
 * A stored TTL stamp, checked as a REAL `Timestamp` exactly `dias` after
 * `startedAtMs`. A numeric epoch here would be the silent failure the policy
 * has: it IGNORES a number, so the document would never expire.
 */
function esperarExpiraEm(bruto: unknown, startedAtMs: number, dias: number): void {
  expect(bruto).toBeInstanceOf(Timestamp);
  expect((bruto as Timestamp).toMillis()).toBe(startedAtMs + dias * DIA_MS);
}

/**
 * Poll the job document until the DISPATCHED function moves it off `running`.
 *
 * The task travels enqueue → tasks emulator → functions emulator → handler, so
 * there is no promise to await, only the effect — and `emulators:exec` tears the
 * suite down the moment the script exits, so waiting on the effect is also what
 * keeps an in-flight dispatch from being killed. The document EXISTS from the
 * start (the start created it), so the wait is on the STATUS.
 */
async function esperarSairDeRunning(
  jobId: string,
  timeoutMs: number,
): Promise<FirebaseFirestore.DocumentData> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const data = await lerJobCru(jobId);
    if (data && data.status !== ENVIO_PRECO_SHOPEE_STATUS.running) return data;
    if (Date.now() > deadline) {
      throw new Error(
        `o envio de preços ${jobId} continuou '${String(data?.status ?? '<documento sumiu>')}' ` +
          `por ${String(timeoutMs)}ms — a função despachada nunca o encerrou. As quatro causas ` +
          'usuais, nesta ordem: (1) DERIVA DE REGIÃO — SHOPEE_TASKS_REGION (o enqueue) ' +
          'diferente do FUNCTIONS_REGION embutido no bundle, o descarte silencioso que ' +
          'shopeePriceSyncTasks.ts descreve (#1108); (2) prepare-deploy.mjs NÃO rodou antes do ' +
          'emulators:exec, então .deploy/shopee-functions está velho ou ausente ' +
          '(emulators:exec não executa hooks predeploy); (3) a FILA não foi registrada — o ' +
          'emulador de functions é quem a cria a partir da definição do trigger, então sem ' +
          'ele, ou com o export processShopeePriceSync renomeado de um lado só, o enqueue dá ' +
          '404 — e, neste job, um meio-renome quebra só a CONTINUAÇÃO: o primeiro despacho ' +
          'roda, o reenfileiramento nunca é entregue e o job fica `running`; (4) o payload ' +
          'foi recusado pelo schema `.strict()` e descartado com uma linha de log. ' +
          '⚠️ Se o enqueue tivesse falhado, o erro teria vindo dele, não daqui: chegar neste ' +
          'ponto significa que o Cloud Tasks ACEITOU a tarefa e ela nunca terminou o job. ' +
          `Estado atual do documento: ${JSON.stringify(data ?? null)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** A conta that parses as a valid `integracao`: `nome`, `tipo`, `ativo`, nothing else. */
async function semearConta(integracaoId: string, tipo: number, nome: string): Promise<void> {
  await integracaoCollection.set(db(), {}, integracaoId, { nome, tipo, ativo: true });
}

/** An anchor the `int-2` walk discovers: `paiId` defaults to `null`, the conta is in the array. */
async function semearAncora(produtoId: string): Promise<void> {
  await produtoCollection.set(db(), {}, produtoId, {
    nome: `Produto de teste — preços (${produtoId})`,
    integracoesComProduto: [CONTA_SHOPEE],
  });
}

/** One `prodshopee` under an anchor — the minimum the schema accepts, plus `extra`. */
async function semearVinculo(
  produtoId: string,
  linkDocId: string,
  integracaoId: string,
  itemId: number,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await produtoShopeeLinkCollection.set(db(), { produtoId }, linkDocId, {
    contaProdutoShopeeOuterRef: refDaConta(integracaoId),
    item_name: 'Anúncio de teste — não é um anúncio real',
    item_id: itemId,
    ...extra,
  });
}

beforeEach(async () => {
  // Every job this suite ever wrote, WITH its report shards: a stale `running`
  // job of this conta would otherwise answer the next start's one-active guard.
  const jobs = await envioPrecoShopeeCollection.ref(db(), {}).listDocuments();
  await Promise.all(jobs.map((r) => db().recursiveDelete(r)));

  // Every ANCHOR the `int-2` walk would discover — this suite's earlier runs.
  // ⚠️ The produto documents ONLY, never their `prodshopee`: deleting a link
  // fires the link trigger's removal path, whose guarded transaction could land
  // on a produto the next case is seeding. A produto delete fires nothing, and
  // an orphaned subcollection is read by nobody (the walk joins only the
  // anchors it found). The children left behind carry a `paiId`, so they are
  // never anchors, and each run's anchor ids are fresh.
  const ancoras = await produtoCollection
    .ref(db(), {})
    .where('integracoesComProduto', 'array-contains', CONTA_SHOPEE)
    .get();
  await Promise.all(ancoras.docs.map((d) => d.ref.delete()));

  await integracaoCollection.docRef(db(), {}, CONTA_SHOPEE).delete();
  await integracaoCollection.docRef(db(), {}, CONTA_OUTRO_TIPO).delete();
});

describe.skipIf(!EMULATED || !TASKS)(
  'atualizar preços Shopee → Cloud Tasks → onTaskDispatched',
  () => {
    it('quatro anúncios pulados no PLANO, em duas páginas, levam o job a `completed` pela fila real, com as quatro linhas num só shard e sem chamar a Shopee', async () => {
      // ⚠️ The precondition that makes this case a proof of the re-enqueue and
      // of the deep merge rather than of one dispatch. See the header.
      const limite = pageLimitPreco();
      if (limite !== PAGINA_DO_CASO_1) {
        throw new Error(
          `SHOPEE_PRICE_PAGE_LIMIT resolve para ${String(limite)} neste processo, e este caso ` +
            `precisa de exatamente ${String(PAGINA_DO_CASO_1)}: com ` +
            `${String(ANCORAS_DO_CASO_1)} âncoras, um limite maior cabe em UMA página, o ` +
            'primeiro despacho conclui o job sozinho e o caso não prova nem o ' +
            'reenfileiramento nem o merge profundo do shard. Defina ' +
            `SHOPEE_PRICE_PAGE_LIMIT: '${String(PAGINA_DO_CASO_1)}' no env do job ` +
            '`shopee-tasks-roundtrip` em .github/workflows/ci-shopee.yml (o emulador de ' +
            'functions herda o mesmo env que este processo).',
        );
      }

      const agoraMs = Date.now();
      // A per-run prefix: the walk orders by document id, so a common prefix
      // keeps a < b < c < d, and a fresh one keeps an earlier run's anchors
      // (and their orphaned subcollections) out of this run's families.
      const prefixo = `preco-${randomUUID().slice(0, 8)}`;
      const ancora = {
        a: `${prefixo}-a`,
        b: `${prefixo}-b`,
        c: `${prefixo}-c`,
        d: `${prefixo}-d`,
      } as const;
      const filhoDeD = `${prefixo}-d-filho`;

      // The Shopee conta: NO `shop_id`, on purpose — the second barrier the
      // header describes. The walk only needs the `tipo` and the partner env.
      await semearConta(CONTA_SHOPEE, INTEGRACAO_TIPO.shopee, 'Conta Shopee de teste');

      // (A) a NATIVE Shopee kit ⇒ `kit-derivado` (rung 3 reads the LINK).
      await semearAncora(ancora.a);
      await semearVinculo(ancora.a, 'link-a', CONTA_SHOPEE, ITEM_ID, { kitNativo: true });

      // (B) a listing the stored RAW status calls deleted ⇒ `anuncio-removido`
      // (rung 4). `estadoAnuncio` stays absent, so the trigger still counts it.
      await semearAncora(ancora.b);
      await semearVinculo(ancora.b, 'link-b', CONTA_SHOPEE, ITEM_ID + 1, {
        item_status: SHOPEE_ITEM_STATUS.sellerDelete,
      });

      // (C) an anchor in the `int-2` array whose ONLY listing is another
      // conta's ⇒ ONE `sem-link` line (rung 0b). Proves the conta is compared
      // in memory over an UNFILTERED link read.
      await semearAncora(ancora.c);
      await semearVinculo(ancora.c, 'link-c', CONTA_OUTRO_TIPO, ITEM_ID + 2);

      // (D) a child carrying TWO usable models of one listing ⇒
      // `forma-de-modelo-divergente` (rung 5). Reached only through the
      // children query and both `variashopee` projections.
      await semearAncora(ancora.d);
      await semearVinculo(ancora.d, 'link-d', CONTA_SHOPEE, ITEM_ID + 3);
      await produtoCollection.set(db(), {}, filhoDeD, {
        nome: `Variação de teste — preços (${filhoDeD})`,
        paiId: ancora.d,
      });
      for (const [varLinkDocId, modelId] of [
        ['var-d-1', MODEL_ID],
        ['var-d-2', MODEL_ID + 1],
      ] as const) {
        await variacaoShopeeLinkCollection.set(db(), { produtoId: filhoDeD }, varLinkDocId, {
          contaVariacaoShopeeOuterRef: refDaConta(CONTA_SHOPEE),
          produtoShopeeOuterRef: `documents/produtos/${ancora.d}/prodshopee/link-d`,
          model_id: modelId,
        });
      }

      // POSITIVE existence assertion, BEFORE the enqueue and before any
      // polling. `vitest.tasks.setup.ts` (3): in the emulator a mis-targeted
      // database silently auto-creates, so every "empty" assertion would pass
      // against a blank namespace. Reading the seeds back — as the walk will
      // select them — proves the test and the dispatch share one database.
      for (const id of Object.values(ancora)) {
        const semeada = await produtoCollection.docRef(db(), {}, id).get();
        expect(semeada.exists).toBe(true);
        expect(semeada.data()).toMatchObject({ paiId: null });
        expect(semeada.data()?.integracoesComProduto).toContain(CONTA_SHOPEE);
      }

      const jobId = await iniciarEnvioPrecoShopee(db(), {
        contexto: contextoSemVeredito(CONTA_SHOPEE),
        baixarPreco: false,
        startedBy: null,
        nowMs: agoraMs,
      });

      // The start's own document, BEFORE any dispatch: `running`, and the
      // run's TTL stamped as a real Timestamp 180 days after `startedAt`.
      const inicial = await lerJobCru(jobId);
      expect(inicial).toMatchObject({
        integracaoId: CONTA_SHOPEE,
        status: ENVIO_PRECO_SHOPEE_STATUS.running,
        startedAt: agoraMs,
      });
      esperarExpiraEm(inicial?.expiraEm, agoraMs, RETENCAO_JOB_DIAS);

      // The REAL scheduler against the REAL emulated queue. A 404 here is a
      // finding, not a flake — see the causes in `esperarSairDeRunning`.
      await createShopeePriceSyncScheduler().enqueue({ jobId, integracaoId: CONTA_SHOPEE });

      const job = await esperarSairDeRunning(jobId, 90_000);

      expect(job).toMatchObject({
        integracaoId: CONTA_SHOPEE,
        // ⚠️ `completed`, not `failed`: a planner or projection regression that
        // let a listing into `fila` would reach the verdict, which refuses
        // this shop-less conta and stamps `failed` — the diff shows its erro.
        status: ENVIO_PRECO_SHOPEE_STATUS.completed,
        erro: null,
        relatorioCompleto: true,
        planejamentoConcluido: true,
        // The walk ran off its last page: the cursor is `null`, not an id.
        afterAnchorId: null,
        planejados: 0,
        enviados: 0,
        falhas: 0,
        pulados: ANCORAS_DO_CASO_1,
        pausas: 0,
        parques: 0,
        retomarEm: null,
        fila: [],
        filaRestante: 0,
        relatorioLinhas: ANCORAS_DO_CASO_1,
        relatorioShards: 1,
        startedAt: agoraMs,
      });
      expect(typeof job.finishedAt).toBe('number');
      expect(job.finishedAt).toBeGreaterThan(0);
      // No dispatch rewrites the run's TTL — it is the start's alone.
      esperarExpiraEm(job.expiraEm, agoraMs, RETENCAO_JOB_DIAS);

      // The sample: ONE entry per skipped listing, each naming its motivo.
      expect((job.skips as { code: string }[]).map((s) => s.code).sort()).toEqual(
        [
          MOTIVO_PRECO_SHOPEE.kitDerivado,
          MOTIVO_PRECO_SHOPEE.anuncioRemovido,
          MOTIVO_PRECO_SHOPEE.semLink,
          MOTIVO_PRECO_SHOPEE.formaDeModeloDivergente,
        ].sort(),
      );

      // ONE shard, and exactly the four identities the planner's lines name.
      expect(await idsDosShards(jobId)).toEqual([relatorioEnvioPrecoShardId(0)]);
      const shard = await lerShardCru(jobId, 0);
      expect(shard).toBeDefined();
      const esperadas: Record<string, { motivo: string; produtoId: string }> = {
        [relatorioEnvioPrecoRowKey({
          produtoId: ancora.a,
          linkDocId: 'link-a',
          anuncioId: String(ITEM_ID),
          fase: ENVIO_PRECO_FASE.plano,
        })]: { motivo: MOTIVO_PRECO_SHOPEE.kitDerivado, produtoId: ancora.a },
        [relatorioEnvioPrecoRowKey({
          produtoId: ancora.b,
          linkDocId: 'link-b',
          anuncioId: String(ITEM_ID + 1),
          fase: ENVIO_PRECO_FASE.plano,
        })]: { motivo: MOTIVO_PRECO_SHOPEE.anuncioRemovido, produtoId: ancora.b },
        // Rung 0b decides before any link is chosen: no link, no listing id.
        [relatorioEnvioPrecoRowKey({
          produtoId: ancora.c,
          fase: ENVIO_PRECO_FASE.plano,
        })]: { motivo: MOTIVO_PRECO_SHOPEE.semLink, produtoId: ancora.c },
        // ⚠️ ONE row at the anchor, no model list — the child would repeat.
        [relatorioEnvioPrecoRowKey({
          produtoId: ancora.d,
          linkDocId: 'link-d',
          anuncioId: String(ITEM_ID + 3),
          fase: ENVIO_PRECO_FASE.plano,
        })]: { motivo: MOTIVO_PRECO_SHOPEE.formaDeModeloDivergente, produtoId: ancora.d },
      };
      const linhas = (shard?.linhas ?? {}) as Record<string, Record<string, unknown>>;
      // ⚠️ THIS is the deep-merge proof, and the re-enqueue proof with it: at a
      // page limit of two, rows (a, b) and rows (c, d) were written by TWO
      // dispatches' checkpoints into the same shard document. A replacing merge
      // would have left only the last page's rows; a continuation that never
      // arrived would have left the job `running`.
      expect(Object.keys(linhas).sort()).toEqual(Object.keys(esperadas).sort());
      // …and the EMULATOR side of the page limit, which the precondition above
      // cannot see (it reads this process's env, not the dispatch's). The shard's
      // `timestamp` is the clock of the LAST checkpoint that wrote rows; the
      // job's `finishedAt` is the clock of the dispatch that completed it. At a
      // limit of two they are different dispatches (the rows end on page two,
      // the walk ends on an empty page three), so the first is strictly older.
      // A dispatch that read the default (25) — or any limit of 3, or of 5 and
      // above — writes its last rows in the very dispatch that completes, and
      // the two clocks are then EQUAL. (Exactly 4 would slip past — one full
      // page, then an empty one — which is one reason the precondition pins this
      // process's reading to exactly 2: the two processes share the job env.)
      expect(typeof shard?.timestamp).toBe('number');
      expect(job.finishedAt).toBeGreaterThan(shard?.timestamp as number);
      for (const [chave, { motivo, produtoId }] of Object.entries(esperadas)) {
        expect(linhas[chave]).toMatchObject({
          produtoId,
          variacaoProdutoId: null,
          resultado: ENVIO_PRECO_RESULTADO.pulado,
          fase: ENVIO_PRECO_FASE.plano,
          motivo,
          erro: null,
          preco: null,
          precoAnterior: null,
        });
      }
      // The shard's TTL, written by the DISPATCHED function: 187 days after the
      // run's `startedAt`, never after the dispatch's own clock.
      esperarExpiraEm(shard?.expiraEm, agoraMs, RETENCAO_RELATORIO_DIAS);
    }, 150_000);

    it('um job cancelado ANTES do primeiro despacho responde `noop`: o documento e a linha `job-cancelado` saem da fila intactos', async () => {
      const agoraMs = Date.now();
      // The conta exists and IS Shopee, so a dispatch that ignored the cancel
      // would get past the context load and PLAN — and a plan checkpoint
      // rewrites `updatedAt`. That is the fingerprint the final assertion
      // looks for.
      await semearConta(CONTA_SHOPEE, INTEGRACAO_TIPO.shopee, 'Conta Shopee de teste');

      const cancelado = await iniciarEnvioPrecoShopee(db(), {
        contexto: contextoSemVeredito(CONTA_SHOPEE),
        baixarPreco: false,
        startedBy: null,
        nowMs: agoraMs,
      });
      const semeado = await lerJobCru(cancelado);
      expect(semeado).toMatchObject({ status: ENVIO_PRECO_SHOPEE_STATUS.running });

      // The operator's cancel, through the real transaction on a real engine.
      const resultado = await cancelarEnvioPrecoShopee(db(), {
        jobId: cancelado,
        integracaoId: CONTA_SHOPEE,
        nowMs: agoraMs + 1,
      });
      expect(resultado).toBe('stamped');

      const antes = await lerJobCru(cancelado);
      expect(antes).toMatchObject({
        status: ENVIO_PRECO_SHOPEE_STATUS.cancelled,
        // A cancel is not a failure: no erro, so no error chip on the card.
        erro: null,
        relatorioCompleto: false,
        finishedAt: agoraMs + 1,
        updatedAt: agoraMs + 1,
        // The report counters are derived INSIDE the transaction from its own
        // snapshot (0 → 1). `filaRestante` was 0 before the cancel too, so it
        // proves nothing here; the offline suite pins its derivation.
        filaRestante: 0,
        relatorioLinhas: 1,
        relatorioShards: 1,
      });

      // ONE synthetic row, keyed on the conta, saying the rest never ran.
      expect(await idsDosShards(cancelado)).toEqual([relatorioEnvioPrecoShardId(0)]);
      const shardAntes = await lerShardCru(cancelado, 0);
      const chaveCancelada = relatorioEnvioPrecoRowKey({
        produtoId: CONTA_SHOPEE,
        fase: ENVIO_PRECO_FASE.envio,
      });
      expect(Object.keys((shardAntes?.linhas ?? {}) as object)).toEqual([chaveCancelada]);
      expect(
        (shardAntes?.linhas as Record<string, unknown> | undefined)?.[chaveCancelada],
      ).toMatchObject({
        produtoId: CONTA_SHOPEE,
        variacaoProdutoId: null,
        anuncioId: null,
        linkDocId: null,
        resultado: ENVIO_PRECO_RESULTADO.naoTentado,
        fase: ENVIO_PRECO_FASE.envio,
        motivo: MOTIVO_PRECO_SHOPEE.jobCancelado,
        erro: null,
      });
      esperarExpiraEm(shardAntes?.expiraEm, agoraMs, RETENCAO_RELATORIO_DIAS);

      // The cancelled job's task, THEN a sentinel job's task behind it.
      //
      // ⚠️ Why a sentinel: a `noop` writes nothing, and "nothing changed" is
      // also what an undelivered task looks like. The queue runs ONE dispatch
      // at a time, in order (`maxConcurrentDispatches: 1`; the emulator is
      // FIFO), so once the sentinel's own effect lands, the cancelled job's
      // dispatch has run. Should the emulator ever stop honouring that order,
      // this weakens to "nothing changed by then" — never to a false red.
      const agenda = createShopeePriceSyncScheduler();
      await agenda.enqueue({ jobId: cancelado, integracaoId: CONTA_SHOPEE });

      // The sentinel is a second run of the SAME conta — which the one-active
      // guard allows only because the first is no longer `running`: the guard's
      // status predicate, answered by a real engine.
      const sentinela = await iniciarEnvioPrecoShopee(db(), {
        contexto: contextoSemVeredito(CONTA_SHOPEE),
        baixarPreco: false,
        startedBy: null,
        nowMs: agoraMs + 2,
      });
      expect(sentinela).not.toBe(cancelado);
      await agenda.enqueue({ jobId: sentinela, integracaoId: CONTA_SHOPEE });

      // The conta holds no anchor (the wipe removed them all), so the sentinel
      // walks one empty page and completes — "nothing was planned" reads as
      // 0 shards and a COMPLETE report.
      const concluido = await esperarSairDeRunning(sentinela, 60_000);
      expect(concluido).toMatchObject({
        status: ENVIO_PRECO_SHOPEE_STATUS.completed,
        relatorioCompleto: true,
        planejamentoConcluido: true,
        planejados: 0,
        pulados: 0,
        relatorioLinhas: 0,
        relatorioShards: 0,
      });

      // ⛔ The noop itself: the cancelled job came out of the queue EXACTLY as
      // the cancel left it — same `updatedAt` (no checkpoint ran), same status
      // (`completed` did not bury the cancel), same one row (no second
      // synthetic row, no plan rows).
      expect(await lerJobCru(cancelado)).toEqual(antes);
      expect(await idsDosShards(cancelado)).toEqual([relatorioEnvioPrecoShardId(0)]);
      expect(await lerShardCru(cancelado, 0)).toEqual(shardAntes);
    }, 150_000);

    it('uma conta do tipo ERRADO carimba `failed` na PRIMEIRA tentativa, com uma linha `job-interrompido`, sem chamar a Shopee', async () => {
      const agoraMs = Date.now();

      // A conta that parses as a perfectly valid `integracao` and is simply not
      // Shopee — the mass-import suite's exact seed. ⚠️ `tipo` is an INT on
      // disk, so the named member is the only honest spelling.
      await semearConta(
        CONTA_OUTRO_TIPO,
        INTEGRACAO_TIPO.mercadoLivre,
        'Conta de teste — NÃO é Shopee',
      );

      const jobId = await iniciarEnvioPrecoShopee(db(), {
        contexto: contextoSemVeredito(CONTA_OUTRO_TIPO),
        baixarPreco: false,
        startedBy: null,
        nowMs: agoraMs,
      });

      // POSITIVE existence assertion before the enqueue (see case 1).
      const semeado = await lerJobCru(jobId);
      expect(semeado).toMatchObject({
        status: ENVIO_PRECO_SHOPEE_STATUS.running,
        integracaoId: CONTA_OUTRO_TIPO,
      });

      const comecou = Date.now();
      await createShopeePriceSyncScheduler().enqueue({ jobId, integracaoId: CONTA_OUTRO_TIPO });
      const job = await esperarSairDeRunning(jobId, 45_000);
      const decorridoMs = Date.now() - comecou;

      expect(job).toMatchObject({
        integracaoId: CONTA_OUTRO_TIPO,
        // ⚠️ `failed`, not `completed`: `completed` would mean the dispatch
        // resolved a context it had no business resolving.
        status: ENVIO_PRECO_SHOPEE_STATUS.failed,
        relatorioCompleto: false,
        // Nothing was planned: the dispatch died at the context load, before
        // the page read — a non-zero counter would mean the failure came from
        // further down.
        planejamentoConcluido: false,
        planejados: 0,
        enviados: 0,
        pulados: 0,
        falhas: 0,
        fila: [],
        afterAnchorId: null,
        // The class-B finalize's report counters, derived from its snapshot
        // (0 → 1). `filaRestante` is 0 on both sides of this stamp (nothing
        // was planned), so the offline suite is what pins its derivation.
        filaRestante: 0,
        relatorioLinhas: 1,
        relatorioShards: 1,
      });
      expect(typeof job.finishedAt).toBe('number');
      expect(job.finishedAt).toBeGreaterThan(0);

      // The MECHANISM is named in the stamp — that sentence is the whole of
      // what an operator sees on the card. `loadShopeeContext`'s `tipo` check
      // raises `Integração <id> não é do tipo Shopee.`, so this proves WHICH
      // arm fired, not merely that something failed. (That message reaches the
      // stamp because its class is one of this app's OWN conta classes, whose
      // text the app composes from its own ids — `erroDaFalha`; a Shopee
      // error's message never does.)
      expect(typeof job.erro).toBe('string');
      expect(String(job.erro)).toContain('não é do tipo Shopee');
      expect(String(job.erro)).toContain(CONTA_OUTRO_TIPO);

      // ONE synthetic `job-interrompido` row, written in the SAME transaction,
      // carrying the stamp's own erro (cut to what a row may hold).
      expect(await idsDosShards(jobId)).toEqual([relatorioEnvioPrecoShardId(0)]);
      const shard = await lerShardCru(jobId, 0);
      const chave = relatorioEnvioPrecoRowKey({
        produtoId: CONTA_OUTRO_TIPO,
        fase: ENVIO_PRECO_FASE.envio,
      });
      expect(Object.keys((shard?.linhas ?? {}) as object)).toEqual([chave]);
      expect((shard?.linhas as Record<string, unknown> | undefined)?.[chave]).toMatchObject({
        produtoId: CONTA_OUTRO_TIPO,
        resultado: ENVIO_PRECO_RESULTADO.naoTentado,
        fase: ENVIO_PRECO_FASE.envio,
        motivo: MOTIVO_PRECO_SHOPEE.jobInterrompido,
        erro: String(job.erro).slice(0, RELATORIO_ENVIO_PRECO_ERRO_MAX),
        preco: null,
      });
      esperarExpiraEm(shard?.expiraEm, agoraMs, RETENCAO_RELATORIO_DIAS);

      // ⚠️ THIS is the proof that no Shopee call happened, and the only one
      // available: the kill-switch lives in THIS process. The argument is the
      // ladder's arithmetic. A first-attempt class stamps on attempt 0, so the
      // job reaches `failed` inside ONE dispatch. A network or HTTP error —
      // what an escaped call would produce with invented partner credentials —
      // is NOT in that set: it is rethrown into the queue's ladder, and the
      // earliest a stamp could then land is after `minBackoffSeconds` (30 s)
      // plus two more dispatches. An elapsed time comfortably under that floor
      // is incompatible with any path that reached the network.
      expect(decorridoMs).toBeLessThan(BACKOFF_MINIMO_S * 1000 - 5_000);
    }, 120_000);
  },
);
