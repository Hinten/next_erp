/**
 * Task scheduler for the Mercado Pago webhook processor — backed by a **Firebase
 * Functions task queue** (`onTaskDispatched`), not raw Cloud Tasks / Terraform.
 * Mirrors `apps/mercado-livre/lib/marketplace/mlTasks.ts`.
 *
 * The receiver enqueues the lean notification payload onto the
 * `processMercadoPagoNotification` queue (auto-provisioned by the function on
 * deploy) and acks 200 fast; the queue dispatches to that function — which runs
 * the work in-process (no HTTP hop, no OIDC) at a rate bounded by the function's
 * `rateLimits`, retrying with backoff per its `retryConfig`.
 *
 * Transport: `firebase-admin`'s `getFunctions().taskQueue(...).enqueue(...)`. No
 * queue-path env and no google-auth-library: the queue is named after the
 * function and the invoking OIDC token is minted by the Cloud Tasks ↔ Functions
 * integration. ⚠️ Minting that token is not permission to USE it: Cloud Tasks
 * presents it to a gen2 function, which is a Cloud Run service, so the enqueuing
 * identity also needs `roles/run.invoker` ON THE SERVICE. That third role is the
 * one that gets forgotten, and it is the one that fails invisibly — the enqueue
 * already returned success, so nothing here can record the 403.
 * `getFunctions(getAdminApp())` binds the default admin app (App Hosting injects
 * ADC). All three roles land with the nested functions codebase's DEPLOY.md; the
 * dispatch one is applied by the deploy itself when `TASKS_INVOKER_SA` is set
 * (#1133).
 *
 * Config:
 *   - `MERCADO_PAGO_TASKS_DISABLED=1` → `enqueue()` throws `MpTasksDisabledError`;
 *     the receiver falls back to persisting the notification as `failed` so the
 *     reprocess sweep drains it (sweep-only mode — never a silent drop).
 *   - `MERCADO_PAGO_TASKS_REGION` (falls back to `FUNCTIONS_REGION`; no default) → the
 *     region the function + its queue are deployed to. The region-qualified name
 *     is mandatory: without it the Admin SDK targets `us-central1` and the task
 *     silently drops. App Hosting / Cloud Run does NOT expose its own region as
 *     an env var, so it must be configured — and an unset value THROWS on the
 *     first enqueue rather than guessing a region.
 */
import { requireRegion } from '@delfrance/core/region';
import { getFunctions } from 'firebase-admin/functions';

import { getAdminApp } from '../firebase/admin';
import { MERCADO_PAGO_NOTIFICATION_QUEUE, type MpNotificationPayload } from './notificacao';

/** Region the notification function/queue live in (must match FUNCTIONS_REGION). */
function mpTasksRegion(): string {
  return requireRegion(['MERCADO_PAGO_TASKS_REGION', 'FUNCTIONS_REGION'], process.env);
}

/**
 * The enqueue seam. The receiver depends on this interface, not the transport,
 * so unit tests pass a fake recorder; the real one comes from
 * `createMpTaskScheduler()`.
 */
export interface MpTaskScheduler {
  enqueue(payload: MpNotificationPayload): Promise<void>;
}

/**
 * Thrown by the disabled-mode scheduler so the receiver funnels into its
 * persist-for-the-sweep fallback (same branch as a genuine enqueue outage).
 */
export class MpTasksDisabledError extends Error {
  constructor() {
    super('MERCADO_PAGO_TASKS_DISABLED=1 — enqueue disabled; persisting for the sweep');
    this.name = 'MpTasksDisabledError';
  }
}

/** Real scheduler — enqueues onto the `processMercadoPagoNotification` queue. */
class FirebaseMpTaskScheduler implements MpTaskScheduler {
  // Region-qualified name so the queue resolves to the deployed function's region
  // (the Admin SDK otherwise defaults to us-central1). Binds the default admin app.
  private queue() {
    return getFunctions(getAdminApp()).taskQueue<MpNotificationPayload>(
      `locations/${mpTasksRegion()}/functions/${MERCADO_PAGO_NOTIFICATION_QUEUE}`,
    );
  }

  async enqueue(payload: MpNotificationPayload): Promise<void> {
    await this.queue().enqueue(payload);
  }
}

/**
 * Build the scheduler from the environment:
 *   - `MERCADO_PAGO_TASKS_DISABLED=1` → a scheduler whose `enqueue()` throws
 *     `MpTasksDisabledError` (the receiver persists + the sweep drains);
 *   - otherwise → the real `FirebaseMpTaskScheduler`.
 */
export function createMpTaskScheduler(): MpTaskScheduler {
  if (process.env.MERCADO_PAGO_TASKS_DISABLED === '1') {
    return {
      async enqueue() {
        throw new MpTasksDisabledError();
      },
    };
  }
  return new FirebaseMpTaskScheduler();
}
