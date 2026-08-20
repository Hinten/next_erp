/**
 * Task scheduler for the ML mass-import job ("Importar todos os anúncios",
 * Step 8, #621) — backed by a **Firebase Functions task queue**
 * (`onTaskDispatched`), exactly like `mlTasks.ts` (the notification pipeline).
 *
 * The `/importar-todos` route enqueues the FIRST dispatch (`{ jobId,
 * integracaoId }`) after `startMassImportJob` creates the job doc;
 * `processMassImportJob` (the task handler's core, `./massImport`) then
 * re-enqueues onto the SAME queue for every subsequent page/drain batch until
 * the job is `completed`/`failed` — so this scheduler is also a dependency of
 * the task handler itself (self-continuation), not just the route.
 *
 * Transport: `firebase-admin`'s `getFunctions().taskQueue(...).enqueue(...)`,
 * identical to `mlTasks.ts` — region-qualified name, default admin app.
 *
 * Config — deliberately REUSES `mlTasks.ts`'s env vars rather than minting
 * mass-import-specific ones (one valve, one region knob, for every ML task
 * queue in this app):
 *   - `MERCADO_LIVRE_TASKS_DISABLED=1` → `enqueue()` throws
 *     `MlMassImportTasksDisabledError`. Unlike the notification pipeline there
 *     is no sweep to fall back on — the caller (route or task handler) must
 *     surface this as a failed job/response, never a silent drop.
 *   - `MERCADO_LIVRE_TASKS_REGION` (default `us-east1`) — see `mlTasksRegion.ts`
 *     for why the region-qualified path is mandatory and why it must NOT fall
 *     back to `FUNCTIONS_REGION`.
 */
import { getFunctions } from 'firebase-admin/functions';

import { getAdminApp } from '../firebase/admin';
import { MERCADO_LIVRE_MASS_IMPORT_QUEUE, type MassImportTaskPayload } from './massImport';
import { mlQueuePath } from './mlTasksRegion';

/**
 * The enqueue seam. `processMassImportJob` and the `/importar-todos` route
 * depend on this interface, not the transport, so unit tests pass a fake
 * recorder; the real one comes from `createMlMassImportScheduler()`.
 */
export interface MlMassImportScheduler {
  enqueue(payload: MassImportTaskPayload): Promise<void>;
}

/**
 * Thrown by the disabled-mode scheduler. The route maps this to a failed job
 * (marks the just-created doc `failed` + a 503); the task handler has no
 * further caller to bubble up to, so it also marks the job `failed`.
 */
export class MlMassImportTasksDisabledError extends Error {
  constructor() {
    super('MERCADO_LIVRE_TASKS_DISABLED=1 — mass-import enqueue disabled');
    this.name = 'MlMassImportTasksDisabledError';
  }
}

/** Real scheduler — enqueues onto the `processMercadoLivreMassImport` queue. */
class FirebaseMlMassImportScheduler implements MlMassImportScheduler {
  // Region-qualified name so the queue resolves to the deployed function's
  // region (the Admin SDK otherwise defaults to us-central1).
  private queue() {
    return getFunctions(getAdminApp()).taskQueue<MassImportTaskPayload>(
      mlQueuePath(MERCADO_LIVRE_MASS_IMPORT_QUEUE),
    );
  }

  async enqueue(payload: MassImportTaskPayload): Promise<void> {
    await this.queue().enqueue(payload);
  }
}

/**
 * Build the scheduler from the environment:
 *   - `MERCADO_LIVRE_TASKS_DISABLED=1` → a scheduler whose `enqueue()` throws
 *     `MlMassImportTasksDisabledError`;
 *   - otherwise → the real `FirebaseMlMassImportScheduler`.
 */
export function createMlMassImportScheduler(): MlMassImportScheduler {
  if (process.env.MERCADO_LIVRE_TASKS_DISABLED === '1') {
    return {
      async enqueue() {
        throw new MlMassImportTasksDisabledError();
      },
    };
  }
  return new FirebaseMlMassImportScheduler();
}
