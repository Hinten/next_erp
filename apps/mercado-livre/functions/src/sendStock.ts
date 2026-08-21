import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import {
  MERCADO_LIVRE_STOCK_SEND_QUEUE,
  STOCK_SEND_MAX_ATTEMPTS,
  concurrentDispatches,
  dispatchesPerSecond,
} from '../../lib/marketplace/estoque/bulkEstoquePlan';
import { processStockSendTask } from '../../lib/marketplace/estoque/estoqueSend';
import { createMlStockTaskScheduler } from '../../lib/marketplace/estoque/mlStockTasks';
import { getDb } from './lib/admin';
import { readCacheSummary } from '@delfrance/data/admin/cache';
import { TASKS_SCHEDULER_REGION } from './options';
import { tasksInvokerOptions } from './tasksInvoker';

/**
 * Cloud Tasks dispatcher for ML stock sends (Step 10 PR B). The sweeps (PR C)
 * enqueue **one task = one ML API call** onto this function's auto-provisioned
 * queue — the whole point of the rebuild: the legacy queue throttled tasks
 * while a task burst N per-variation calls, so its per-second limit never
 * limited actual ML calls (429 storms). Payloads carry the SWEEP-COMPUTED
 * quantities: `processStockSendTask` transmits them VERBATIM (owner-locked
 * legacy parity — zero produto/estoque reads at send time), so a Cloud Tasks
 * retry or a pause-parked task can send numbers up to `now − sweepComputedAtMs`
 * old — the handler logs `ageMs` on every send and the next sweep converges
 * any staleness. A task landing on a 429-paused conta re-enqueues itself
 * via the scheduler (delay + jitter) instead of burning queue retries; a 429
 * itself pauses the conta and RETHROWS so the retry rides the queue backoff
 * into that pause gate.
 *
 * `retryConfig.maxAttempts` is `STOCK_SEND_MAX_ATTEMPTS` and `req.retryCount` is
 * threaded into the handler: ML answers 4xx for transient reasons too, so the
 * handler rethrows a 4xx until the LAST attempt and only then asks ML for the
 * listing's real state and records it (mirrors processMassImport/processPriceSync).
 *
 * `rateLimits` is evaluated at DEPLOY time (Firebase bakes it into the queue
 * config), so the two knobs are deploy-time env reads with code defaults 2/2
 * (`MERCADO_LIVRE_STOCK_{CONCURRENT_DISPATCHES,DISPATCHES_PER_SECOND}`) — the
 * same env-with-default pattern options.ts uses for the region. Changing them
 * needs a redeploy, never a code edit.
 *
 * ⚠️ The export name below IS the deployed function + queue name — it MUST equal
 * `MERCADO_LIVRE_STOCK_SEND_QUEUE` (the sweeps and the pause re-enqueue target
 * that string). Rename both together, or the enqueue targets a non-existent
 * queue (silent drop). Asserted at load time in index.ts.
 *
 * Secrets: `MERCADO_LIVRE_CLIENT_ID` / `MERCADO_LIVRE_CLIENT_SECRET` are bound
 * on THIS function (mirrors `processNotification.ts`) because the handler
 * resolves the conta's channel context, which refreshes the ML access token
 * via `mercadoLivreOAuthConfig()` (reads both env vars) whenever it's near
 * expiry.
 */
export const sendMercadoLivreStock = onTaskDispatched(
  {
    // Cloud Tasks does not exist in us-east5 — see TASKS_SCHEDULER_REGION.
    region: TASKS_SCHEDULER_REGION,
    // roles/run.invoker on this service + roles/cloudtasks.enqueuer on its
    // queue, applied at deploy time from TASKS_INVOKER_SA. Absent when unset.
    ...tasksInvokerOptions(),
    retryConfig: {
      maxAttempts: STOCK_SEND_MAX_ATTEMPTS,
      minBackoffSeconds: 30,
      maxBackoffSeconds: 300,
      maxDoublings: 2,
    },
    rateLimits: {
      maxConcurrentDispatches: concurrentDispatches(),
      maxDispatchesPerSecond: dispatchesPerSecond(),
    },
    secrets: ['MERCADO_LIVRE_CLIENT_ID', 'MERCADO_LIVRE_CLIENT_SECRET'],
  },
  async (req) => {
    const result = await processStockSendTask(getDb(), req.data, {
      scheduler: createMlStockTaskScheduler(),
      nowMs: Date.now(),
      // The 4xx branch never trusts one sample: it rethrows (queue retries with
      // backoff) until this is the LAST attempt, and only then records the
      // terminal state. Mirrors processPriceSync/processMassImport.
      retryCount: req.retryCount ?? 0,
    });
    logger.info('[mercado-livre] processed stock send task', {
      queue: MERCADO_LIVRE_STOCK_SEND_QUEUE,
      outcome: result.outcome,
      retryCount: req.retryCount ?? 0,
      // CUMULATIVE for this instance — a task has no tick to bracket. This is the
      // fan-out the sweep drives (up to `maxTasksPerSweep()` per conta), so
      // consecutive lines from one warm instance are where the win shows up.
      readCache: readCacheSummary(),
    });
  },
);
