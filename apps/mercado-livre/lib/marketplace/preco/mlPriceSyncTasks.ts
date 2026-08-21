/**
 * Task scheduler for the ML manual bulk price-sync job ("Atualizar preços",
 * Step 11 PR-C) — backed by a **Firebase Functions task queue**
 * (`onTaskDispatched`), exactly like `mlTasks.ts` (the notification pipeline),
 * `mlMassImportTasks.ts` and `mlStockTasks.ts`.
 *
 * The `/atualizar-precos` route enqueues the FIRST dispatch (`{ jobId,
 * integracaoId }`) after `startPriceSyncJob` creates the job doc;
 * `processPriceSyncJob` (the task handler's core, `./precoSync`) then
 * re-enqueues onto the SAME queue for every subsequent page/send batch until
 * the job is `completed`/`failed` — and with `scheduleDelaySeconds` when ML
 * 429s the conta — so this scheduler is also a dependency of the task handler
 * itself (self-continuation + the rate pause), not just the route.
 *
 * Transport: `firebase-admin`'s `getFunctions().taskQueue(...).enqueue(...)`,
 * identical to `mlTasks.ts` — region-qualified name, default admin app.
 *
 * Config — deliberately REUSES `mlTasks.ts`'s env vars (one valve, one region
 * knob, for every ML task queue in this app):
 *   - `MERCADO_LIVRE_TASKS_DISABLED=1` → `enqueue()` throws
 *     `MlTasksDisabledError` (the shared class from `mlTasks.ts` — same valve,
 *     same error). Like the mass import there is no sweep to fall back on —
 *     the caller (route or task handler) must surface this as a failed
 *     job/response, never a silent drop.
 *   - `MERCADO_LIVRE_TASKS_REGION` (default `FUNCTIONS_REGION` → `us-east5`) —
 *     see `mlTasks.ts` for why the region-qualified path is mandatory.
 */
import { getFunctions } from 'firebase-admin/functions';

import { getAdminApp } from '../../firebase/admin';
import { MlTasksDisabledError, type MlEnqueueOptions } from '../notificacoes/mlTasks';
import { MERCADO_LIVRE_PRICE_SYNC_QUEUE, type PriceSyncTaskPayload } from './precoSync';

/** Region the price-sync function/queue live in (shared knob with mlTasks.ts). */
function mlTasksRegion(): string {
  return (
    process.env.MERCADO_LIVRE_TASKS_REGION?.trim() || process.env.FUNCTIONS_REGION || 'us-east5'
  );
}

/**
 * The enqueue seam. `processPriceSyncJob` and the `/atualizar-precos` route
 * depend on this interface, not the transport, so unit tests pass a fake
 * recorder; the real one comes from `createMlPriceSyncScheduler()`.
 */
export interface MlPriceSyncScheduler {
  enqueue(payload: PriceSyncTaskPayload, opts?: MlEnqueueOptions): Promise<void>;
}

/** Real scheduler — enqueues onto the `processMercadoLivrePriceSync` queue. */
class FirebaseMlPriceSyncScheduler implements MlPriceSyncScheduler {
  // Region-qualified name so the queue resolves to the deployed function's
  // region (the Admin SDK otherwise defaults to us-central1).
  private queue() {
    return getFunctions(getAdminApp()).taskQueue<PriceSyncTaskPayload>(
      `locations/${mlTasksRegion()}/functions/${MERCADO_LIVRE_PRICE_SYNC_QUEUE}`,
    );
  }

  async enqueue(payload: PriceSyncTaskPayload, opts?: MlEnqueueOptions): Promise<void> {
    await this.queue().enqueue(payload, opts);
  }
}

/**
 * Build the scheduler from the environment:
 *   - `MERCADO_LIVRE_TASKS_DISABLED=1` → a scheduler whose `enqueue()` throws
 *     `MlTasksDisabledError` (shared with the notification pipeline);
 *   - otherwise → the real `FirebaseMlPriceSyncScheduler`.
 */
export function createMlPriceSyncScheduler(): MlPriceSyncScheduler {
  if (process.env.MERCADO_LIVRE_TASKS_DISABLED === '1') {
    return {
      async enqueue() {
        throw new MlTasksDisabledError();
      },
    };
  }
  return new FirebaseMlPriceSyncScheduler();
}
