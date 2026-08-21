/**
 * Task scheduler for the ML NF-e invoice upload (Step 12, #739) — backed by a
 * **Firebase Functions task queue** (`onTaskDispatched`), exactly like
 * `mlTasks.ts` (the notification pipeline), `mlMassImportTasks.ts`,
 * `mlStockTasks.ts` and `mlPriceSyncTasks.ts`.
 *
 * The `onNfeAprovada` Firestore trigger (functions/src/onNfeAprovada.ts)
 * enqueues one `{ pedidoId, nfeId }` task when a production NF-e reaches
 * `aprovada` with its signed `xml_nfe_proc`; `processNfeUploadTask` (the task
 * handler's core, `./nfeUpload`) uploads the raw nfeProc XML to the pedido's ML
 * shipment. One task = one NF-e — no self-continuation and no per-enqueue
 * options (`MlEnqueueOptions`), so the seam is the minimal `enqueue(payload)`.
 *
 * Transport: `firebase-admin`'s `getFunctions().taskQueue(...).enqueue(...)`,
 * identical to `mlTasks.ts` — region-qualified name, default admin app.
 *
 * Config — deliberately REUSES `mlTasks.ts`'s env vars (one valve, one region
 * knob, for every ML task queue in this app):
 *   - `MERCADO_LIVRE_TASKS_DISABLED=1` → `enqueue()` throws
 *     `MlTasksDisabledError` (the shared class from `mlTasks.ts` — same valve,
 *     same error). There is no sweep to fall back on — the trigger logs + skips
 *     while the valve is on, and the poke/route re-drive is the recovery path
 *     once it lifts — so the valve must stay a deliberate, short-lived state.
 *   - `MERCADO_LIVRE_TASKS_REGION` (falls back to `FUNCTIONS_REGION`; no
 *     default — an unset value THROWS on the first enqueue) —
 *     see `mlTasks.ts` for why the region-qualified path is mandatory.
 */
import { requireRegion } from '@delfrance/core/region';
import { getFunctions } from 'firebase-admin/functions';

import { getAdminApp } from '../firebase/admin';
import { MlTasksDisabledError } from './mlTasks';
import {
  MERCADO_LIVRE_NFE_UPLOAD_QUEUE,
  type MlNfeUploadScheduler,
  type NfeUploadTaskPayload,
} from './nfeUpload';

/** Region the NF-e upload function/queue live in (shared knob with mlTasks.ts). */
function mlTasksRegion(): string {
  return requireRegion({
    MERCADO_LIVRE_TASKS_REGION: process.env.MERCADO_LIVRE_TASKS_REGION,
    FUNCTIONS_REGION: process.env.FUNCTIONS_REGION,
  });
}

/**
 * Real scheduler — enqueues onto the `processMercadoLivreNfeUpload` queue.
 * Unlike the price-sync pair, the `MlNfeUploadScheduler` interface it
 * implements lives in `./nfeUpload` (next to the dispatch helpers its
 * consumers pair it with) rather than here: the core module owns the seam so
 * it never depends on this transport.
 */
class FirebaseMlNfeUploadScheduler implements MlNfeUploadScheduler {
  // Region-qualified name so the queue resolves to the deployed function's
  // region (the Admin SDK otherwise defaults to us-central1).
  private queue() {
    return getFunctions(getAdminApp()).taskQueue<NfeUploadTaskPayload>(
      `locations/${mlTasksRegion()}/functions/${MERCADO_LIVRE_NFE_UPLOAD_QUEUE}`,
    );
  }

  async enqueue(payload: NfeUploadTaskPayload): Promise<void> {
    await this.queue().enqueue(payload);
  }
}

/**
 * Build the scheduler from the environment:
 *   - `MERCADO_LIVRE_TASKS_DISABLED=1` → a scheduler whose `enqueue()` throws
 *     `MlTasksDisabledError` (shared with the notification pipeline);
 *   - otherwise → the real `FirebaseMlNfeUploadScheduler`.
 */
export function createMlNfeUploadScheduler(): MlNfeUploadScheduler {
  if (process.env.MERCADO_LIVRE_TASKS_DISABLED === '1') {
    return {
      async enqueue() {
        throw new MlTasksDisabledError();
      },
    };
  }
  return new FirebaseMlNfeUploadScheduler();
}
