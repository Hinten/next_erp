import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import { readCacheSummary } from '@delfrance/data/admin/cache';
import { camposInvalidos, resumirCampos } from '@delfrance/core/wire';

import {
  MAX_TENTATIVAS,
  SHOPEE_MASS_IMPORT_QUEUE,
  importacaoShopeeTaskSchema,
  processarImportacaoShopee,
} from '../../lib/shopee/produtos/importacaoMassa';
import { importarAnuncioShopee } from '../../lib/shopee/produtos/importarAnuncio';
import { createShopeeMassImportScheduler } from '../../lib/shopee/produtos/shopeeMassImportTasks';
import { getDb } from './lib/admin';
import { tasksInvokerOptions } from './tasksInvoker';

/**
 * Cloud Tasks dispatcher for the Shopee MASS PRODUCT IMPORT ("Importar todos os
 * anúncios", master plan step 9, #1517). Ports
 * `apps/mercado-livre/functions/src/processMassImport.ts`.
 *
 * The `/importar-todos` route creates the job document and enqueues the FIRST
 * `{ jobId, integracaoId }` task; `processarImportacaoShopee` re-enqueues onto
 * this SAME queue for every scan/drain continuation AND for the rate-limit
 * pause, so this dispatcher both starts and continues a job. ⚠️ Unlike the push
 * pipeline there is **no sweep behind this path** — nothing re-drives a job this
 * queue drops, which is why the handler's disposition table stamps the job
 * `failed` rather than letting a dispatch end quietly.
 *
 * `retryConfig.maxAttempts` mirrors {@link MAX_TENTATIVAS}: a transient failure
 * retries with backoff and the FINAL attempt stamps the job `failed` instead of
 * throwing. That disposition lives in `importacaoMassa.ts` so it stays
 * unit-testable; what lives HERE is only the wiring and the one log line.
 *
 * ⚠️ `secrets` — every scan and every drain signs a Shop-signed Shopee call
 * whose HMAC uses the PARTNER key, and the context resolution refreshes the
 * shop token, so both partner credentials must be bound. Without them the first
 * signed call throws `ShopeeConfigError`, which the job treats as a
 * first-attempt terminal failure: the job is stamped `failed` naming a missing
 * configuration rather than retried, so the symptom is a job that dies
 * immediately, not a startup error that names the binding.
 *
 * ⚠️ The export name below IS the deployed function + queue name — it MUST equal
 * {@link SHOPEE_MASS_IMPORT_QUEUE} (the route and the self-continuation both
 * enqueue against that string; `index.ts` asserts the pair at module load).
 * Rename both together, or the enqueue targets a queue that does not exist and
 * the task is silently dropped while the caller sees success.
 *
 * ⚠️ `importarKit` is deliberately NOT injected in this wave: the kit importer
 * (`lib/shopee/produtos/kitShopee.ts`, arm K1) lands with master plan step 9's
 * kit wave, which adds the `importarKit: importarKitShopee` line here and the
 * test beside it. Until then a job whose queue reaches a kit ends with the job
 * module's missing-dependency `Error` — loud, on the ladder, never a silent
 * skip and never a simple produto minted from a kit.
 */
export const processShopeeMassImport = onTaskDispatched(
  {
    // roles/run.invoker on this service + roles/cloudtasks.enqueuer on its
    // queue, applied at deploy time from TASKS_INVOKER_SA. Absent when unset.
    //
    // ⚠️ TWO identities dispatch this one: the App Hosting runtime SA (the
    // /importar-todos route's first enqueue) and the functions runtime SA
    // (every self-continuation and the rate-limit pause). The list is
    // AUTHORITATIVE — a deploy REPLACES both bindings' members — so dropping
    // either name breaks one of the two legs invisibly.
    ...tasksInvokerOptions(),
    secrets: ['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY'],
    // ⚠️ 300, and NOT the 540 every `onSchedule` in this codebase carries — a
    // budget far above the work's real ceiling does not make a slow dispatch
    // succeed, it makes a HUNG one invisible for that much longer. The drain is
    // sized to it rather than the other way round: `ITENS_POR_DESPACHO` items
    // at ≈ 20 s each is ≈ 205 s of 300, about 30 % headroom, and the job
    // document is checkpointed after EVERY item, so a dispatch that runs out of
    // budget loses at most the item in flight.
    //
    // ⚠️ It is also what keeps the ladder inside the invariant `index.test.ts`
    // pins for every queue in this codebase — `tentativas × timeout +
    // (tentativas − 1) × maxBackoff ≤ 1800`: 3 × 300 + 2 × 300 = 1500 ✅, while
    // ML's own 3 × 540 + 2 × 300 = 2220 ✗. Raising this number is therefore not
    // a local decision.
    timeoutSeconds: 300,
    retryConfig: {
      maxAttempts: MAX_TENTATIVAS,
      minBackoffSeconds: 30,
      maxBackoffSeconds: 300,
      maxDoublings: 2,
    },
    // ⚠️ ONE dispatch at a time. The job document IS the checkpoint — `fila`,
    // `nextOffset` and the counters are read, advanced and merged back by the
    // dispatch — so two concurrent dispatches of the same job would race that
    // document and replay a drained page.
    //
    // ⚠️ And note this is PER FUNCTION, not per job: it also serialises two
    // different contas' imports. That is the intended reading while Shopee
    // publishes no rate limit at all (`rate_limit` is an empty string on the
    // product pages) — one product-read stream per partner — and it is the
    // first knob to raise once a rehearsal measures a real throughput number.
    rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },
    // ⚠️ No `region:` key: `options.ts` sets it globally for this codebase from
    // the build-time inlined `FUNCTIONS_REGION`, and the enqueuer defaults to
    // the same value. A local override here would let the two drift, and a
    // queue path pointing at the wrong region drops every task while the
    // enqueue still returns success (#1108).
  },
  async (req) => {
    const parsed = importacaoShopeeTaskSchema.safeParse(req.data);
    if (!parsed.success) {
      // A coding/enqueue bug — this queue only ever receives our own
      // `{ jobId, integracaoId }` body. There is nothing to retry (three more
      // attempts would parse the same bytes the same way) and nothing to stamp
      // (without a `jobId` there is no document to mark `failed`), so the task
      // is DROPPED, loudly, on one line.
      //
      // ⚠️ Field PATHS only, never a value from the body (#1015): the drop is
      // the one delivery whose ids an operator most needs named, and it is also
      // the one whose body nobody has validated.
      logger.error('[shopee] payload de importação em massa inválido — task descartada', {
        queue: SHOPEE_MASS_IMPORT_QUEUE,
        campos: resumirCampos(camposInvalidos(parsed.error.issues)),
      });
      return;
    }

    const outcome = await processarImportacaoShopee(
      {
        db: getDb(),
        scheduler: createShopeeMassImportScheduler(),
        importarAnuncio: importarAnuncioShopee,
      },
      parsed.data,
      req.retryCount ?? 0,
    );

    // ONE line on purpose — the fields land in `jsonPayload` and are filterable
    // (`jsonPayload.outcome="continued"`), so more fields beat more lines.
    //
    // `outcome` is the dispatch's own verdict and the four values are not
    // interchangeable: `done` finished the job, `continued` re-enqueued (a scan
    // page, a drained batch, or a rate-limit pause), `noop` found nothing to do
    // (the job was already terminal — a cancel mid-drain lands here) and
    // `failed` stamped a terminal state. A line that said only "processed"
    // would report a paused job and a finished one identically, which is the
    // #1087 shape this repo pays to avoid.
    //
    // Never a listing, a body, a URL or a credential: the counters live on the
    // job document, which is the operator's view, and this line only says which
    // dispatch produced them.
    logger.info('[shopee] importação em massa', {
      queue: SHOPEE_MASS_IMPORT_QUEUE,
      outcome,
      jobId: parsed.data.jobId,
      integracaoId: parsed.data.integracaoId,
      retryCount: req.retryCount ?? 0,
      // CUMULATIVE for this instance — a dispatch has no tick to bracket (the
      // sweeps in `index.ts` bracket their own with mark/delta instead).
      readCache: readCacheSummary(),
    });
  },
);
