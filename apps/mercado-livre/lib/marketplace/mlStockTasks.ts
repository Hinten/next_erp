/**
 * Task scheduler for the ML **stock send queue** (Step 10 PR B) — backed by a
 * **Firebase Functions task queue** (`onTaskDispatched`), exactly like
 * `mlTasks.ts` (the notification pipeline) and `mlMassImportTasks.ts`.
 *
 * The stock sweeps (PR C) enqueue one task per ML API call onto the
 * `sendMercadoLivreStock` queue (auto-provisioned by the function on deploy);
 * the queue dispatches to `functions/src/sendStock.ts`, which transmits the
 * SWEEP-COMPUTED quantities carried in the payload verbatim (zero per-task
 * produto/estoque reads — see estoqueSend.ts for the staleness contract). The
 * task handler is ALSO a consumer of this scheduler: a task landing on a
 * 429-paused conta re-enqueues itself with `scheduleDelaySeconds`, so the
 * pause never burns queue retries.
 *
 * Transport: `firebase-admin`'s `getFunctions().taskQueue(...).enqueue(...)`,
 * identical to `mlTasks.ts` — region-qualified name, default admin app.
 *
 * Config — deliberately REUSES `mlTasks.ts`'s env vars (one valve, one region
 * knob, for every ML task queue in this app):
 *   - `MERCADO_LIVRE_TASKS_DISABLED=1` → `enqueue()` throws
 *     `MlTasksDisabledError` (the shared class from `mlTasks.ts` — same valve,
 *     same error). There is no persist-for-the-sweep fallback here: the sweep
 *     surfaces it as a per-conta failure, and the next sweep re-covers the
 *     window (never a silent drop).
 *   - `MERCADO_LIVRE_TASKS_REGION` (default `FUNCTIONS_REGION` → `us-east5`) —
 *     see `mlTasks.ts` for why the region-qualified path is mandatory.
 */
import { getFunctions } from 'firebase-admin/functions';

import { getAdminApp } from '../firebase/admin';
import { MERCADO_LIVRE_STOCK_SEND_QUEUE } from './bulkEstoquePlan';
import { MlTasksDisabledError, type MlEnqueueOptions } from './mlTasks';

/** Region the stock send function/queue live in (shared knob with mlTasks.ts). */
function mlTasksRegion(): string {
  return (
    process.env.MERCADO_LIVRE_TASKS_REGION?.trim() || process.env.FUNCTIONS_REGION || 'us-east5'
  );
}

/**
 * The enqueue seam. The sweeps and the task handler's pause-gate re-enqueue
 * depend on this interface, not the transport, so unit tests pass a fake
 * recorder; the real one comes from `createMlStockTaskScheduler()`. The
 * payload stays `unknown` here — its schema lives in `estoqueSend.ts`, and the
 * handler zod-parses every dispatch anyway (Cloud Tasks payloads are wire
 * data, not trusted types).
 */
export interface MlStockTaskScheduler {
  enqueue(payload: unknown, opts?: MlEnqueueOptions): Promise<void>;
}

/** Real scheduler — enqueues onto the `sendMercadoLivreStock` queue. */
class FirebaseMlStockTaskScheduler implements MlStockTaskScheduler {
  // Region-qualified name so the queue resolves to the deployed function's
  // region (the Admin SDK otherwise defaults to us-central1).
  private queue() {
    return getFunctions(getAdminApp()).taskQueue<unknown>(
      `locations/${mlTasksRegion()}/functions/${MERCADO_LIVRE_STOCK_SEND_QUEUE}`,
    );
  }

  async enqueue(payload: unknown, opts?: MlEnqueueOptions): Promise<void> {
    await this.queue().enqueue(payload, opts);
  }
}

/**
 * Build the scheduler from the environment:
 *   - `MERCADO_LIVRE_TASKS_DISABLED=1` → a scheduler whose `enqueue()` throws
 *     `MlTasksDisabledError` (shared with the notification pipeline);
 *   - otherwise → the real `FirebaseMlStockTaskScheduler`.
 */
export function createMlStockTaskScheduler(): MlStockTaskScheduler {
  if (process.env.MERCADO_LIVRE_TASKS_DISABLED === '1') {
    return {
      async enqueue() {
        throw new MlTasksDisabledError();
      },
    };
  }
  return new FirebaseMlStockTaskScheduler();
}
