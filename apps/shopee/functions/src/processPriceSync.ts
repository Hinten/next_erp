import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import { readCacheSummary } from '@delfrance/data/admin/cache';
import { camposInvalidos, resumirCampos } from '@delfrance/core/wire';

import {
  envioPrecoShopeeTaskSchema,
  processarEnvioPrecoShopee,
} from '../../lib/shopee/precos/atualizarPrecos';
import {
  ENVIO_PRECO_MAX_TENTATIVAS,
  SHOPEE_PRICE_SYNC_QUEUE,
} from '../../lib/shopee/precos/constantesPreco';
import { createShopeePriceSyncScheduler } from '../../lib/shopee/precos/shopeePriceSyncTasks';
import { getDb } from './lib/admin';
import { tasksInvokerOptions } from './tasksInvoker';

/**
 * Cloud Tasks dispatcher for the Shopee account-wide PRICE job ("Atualizar
 * preços", master plan step 13, #1521) — the FOURTH queue of this codebase.
 * Ports `apps/mercado-livre/functions/src/processPriceSync.ts` in role and
 * step 9's `./processMassImport.ts` in shape.
 *
 * The `/atualizar-precos` route creates the job document and enqueues the FIRST
 * `{ jobId, integracaoId }` task; `processarEnvioPrecoShopee` re-enqueues onto
 * this SAME queue for every plan/drain continuation, for a burst pause and for
 * the daily-quota park, so this dispatcher both starts and continues a job.
 * ⚠️ Like the mass import there is **no sweep behind this path** — nothing
 * re-drives a task this queue drops — which is why the job's own disposition
 * stamps it `failed` on the last attempt rather than letting a dispatch end
 * quietly; the orphan reclaim (six hours of silence) is the only other exit.
 *
 * ⚠️ **The clock is read HERE, once.** The job module reads none (its folder's
 * discipline grep bans a clock read under `precos/`): `nowMs` is this
 * dispatch's single clock read, reused by the job for every stamp it writes,
 * and the TTL stamps derive from the job's `startedAt`, never from it.
 *
 * ⚠️ **`jitterSec` is where the RANDOMNESS lives.** The job's default is a
 * deterministic `0` so a park's delay is testable; the real spread belongs to
 * the deployed dispatcher, because every job parked on the same daily quota
 * would otherwise come back on the same second after 00:00 UTC+8.
 *
 * ⚠️ **Every other seam is left to its default ON PURPOSE** — the context
 * loader, the conta verdict, the page reader, the drain-time price read, the
 * batched base reader and the sender. Each has a production default inside the
 * job module, and an injection here would be a second place deciding which
 * sender a live marketplace is written through.
 *
 * `retryConfig.maxAttempts` IS {@link ENVIO_PRECO_MAX_TENTATIVAS}: the job reads
 * the same constant to decide that an attempt is the LAST one and stamps
 * `failed` instead of rethrowing, so the two can only disagree if one of them
 * stops naming it. `processPriceSync.test.ts` pins the equality and the value.
 *
 * ⚠️ `secrets` — a drain builds a Shop-signed client (the verdict's shop read
 * and every `update_price`), whose HMAC uses the PARTNER key, and the context
 * resolution refreshes the shop token, so both partner credentials must be
 * bound. ⚠️ Even a plan-only dispatch needs them: the job loads the conta
 * context on EVERY dispatch, and that load reads the partner configuration
 * before anything else. Without them it throws `ShopeeConfigError`, which the
 * job treats as a first-attempt terminal failure: the job is stamped `failed`
 * on its very first dispatch rather than retried, so the symptom is a run that
 * dies at once, not a startup error that names the binding.
 *
 * ⚠️ The export name below IS the deployed function + queue name — it MUST equal
 * {@link SHOPEE_PRICE_SYNC_QUEUE} (the route and the self-continuation both
 * enqueue against that string; `index.ts` asserts the pair at module load).
 * Rename both together, or the continuation targets a queue that does not exist
 * and the job stays `running` while the caller saw success.
 */
export const processShopeePriceSync = onTaskDispatched(
  {
    // roles/run.invoker on this service + roles/cloudtasks.enqueuer on its
    // queue, applied at deploy time from TASKS_INVOKER_SA. Absent when unset.
    //
    // ⚠️ TWO identities dispatch this one: the App Hosting runtime SA (the
    // /atualizar-precos route's first enqueue) and the functions runtime SA
    // (every self-continuation, the burst pause and the daily park). The list
    // is AUTHORITATIVE — a deploy REPLACES both bindings' members — so dropping
    // either name breaks one of the two legs invisibly.
    ...tasksInvokerOptions(),
    secrets: ['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY'],
    // ⚠️ 300 — the mass import's number, and NOT the 540 of Mercado Livre's
    // price queue. The drain is sized to it rather than the other way round:
    // `itensPorDespachoPreco()` listings (default 10) at ≈ 20 s each is ≈ 200 s
    // of 300, and the job document is checkpointed after EVERY listing, so a
    // dispatch that runs out of budget loses at most the listing in flight —
    // which the sender's skip-if-equal then replays as `preco-igual`.
    //
    // ⚠️ It is also what keeps the ladder inside the invariant `index.test.ts`
    // pins for every queue in this codebase — `tentativas × timeout +
    // (tentativas − 1) × maxBackoff ≤ 1800`: 3 × 300 + 2 × 300 = 1500 ✅, while
    // Mercado Livre's 3 × 540 + 2 × 300 = 2220 ✗. Raising this number is
    // therefore not a local decision.
    timeoutSeconds: 300,
    retryConfig: {
      maxAttempts: ENVIO_PRECO_MAX_TENTATIVAS,
      minBackoffSeconds: 30,
      maxBackoffSeconds: 300,
      maxDoublings: 2,
    },
    // ⚠️ ONE dispatch at a time, and LITERAL — not the stock queue's
    // deploy-shell reads. The job document IS the checkpoint (`fila`, the
    // cursor, the counters and the report-shard index are read, advanced and
    // written back by the dispatch), so two concurrent dispatches of one job
    // would race it and replay a drained listing. A literal is also why
    // `tools/deploy-env/preflight.mjs` needs no edit: there is no env knob to
    // print or drift-check.
    //
    // ⚠️ And note this is PER FUNCTION, not per job: it also serialises two
    // contas' runs — and bounds the duplicate spend of the ACCEPTED start race
    // (two `running` jobs for one conta drain one after the other, and the
    // second's skip-if-equal turns the first's landed writes into
    // `preco-igual`).
    rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },
    // ⚠️ No `region:` key: `options.ts` sets it globally for this codebase from
    // the build-time inlined `FUNCTIONS_REGION`, and the enqueuer defaults to
    // the same value. A local override here would let the two drift, and a
    // queue path pointing at the wrong region drops every task while the
    // enqueue still returns success (#1108).
  },
  async (req) => {
    const parsed = envioPrecoShopeeTaskSchema.safeParse(req.data);
    if (!parsed.success) {
      // A coding/enqueue bug — this queue only ever receives our own
      // `{ jobId, integracaoId }` body. There is nothing to retry (three more
      // attempts would parse the same bytes the same way) and nothing to stamp
      // (without a `jobId` there is no document to mark `failed`), so the task
      // is DROPPED, loudly, on one line.
      //
      // ⚠️ The schema is `.strict()`, unlike the mass import's passthrough: an
      // EXTRA key is refused too, and it is reported as `(raiz)` — the issue
      // carries the offending key names, and they are body content nobody has
      // validated, so they stay out of the line.
      //
      // ⚠️ Field PATHS only, never a value from the body (#1015).
      logger.error('[shopee] payload de envio de preços inválido — task descartada', {
        queue: SHOPEE_PRICE_SYNC_QUEUE,
        campos: resumirCampos(camposInvalidos(parsed.error.issues)),
      });
      return;
    }

    const retryCount = req.retryCount ?? 0;
    const outcome = await processarEnvioPrecoShopee(
      {
        db: getDb(),
        scheduler: createShopeePriceSyncScheduler(),
        // The dispatch's ONE clock read — see the module doc.
        nowMs: Date.now(),
        // The park's spread, an integer in [0, maxS] — see the module doc.
        jitterSec: (maxS: number) => Math.floor(Math.random() * (maxS + 1)),
        // ⚠️ Every other seam is DELIBERATELY absent. See the module doc.
      },
      parsed.data,
      retryCount,
    );

    // ONE line on purpose — the fields land in `jsonPayload` and are filterable
    // (`jsonPayload.outcome="pausado"`), so more fields beat more lines.
    //
    // `outcome` is the dispatch's own verdict and the five values are not
    // interchangeable: `done` finished the job, `continued` re-enqueued (a plan
    // page, a drained lote, or a burst pause), `pausado` PARKED it on the daily
    // quota until the next 00:00 UTC+8, `noop` found nothing to do (the job was
    // already terminal — a cancel mid-drain lands here) and `failed` stamped a
    // terminal state. A line that said only "processed" would report a parked
    // job and a finished one identically (#1087).
    //
    // Never a listing, a price, a body, a URL or a credential: the counters and
    // the report live on the job document, which is the operator's view, and
    // this line only says which dispatch produced them.
    logger.info('[shopee] envio de preços', {
      queue: SHOPEE_PRICE_SYNC_QUEUE,
      outcome,
      jobId: parsed.data.jobId,
      integracaoId: parsed.data.integracaoId,
      retryCount,
      // CUMULATIVE for this instance — a dispatch has no tick to bracket (the
      // sweeps in `index.ts` bracket their own with mark/delta instead).
      readCache: readCacheSummary(),
    });
  },
);
