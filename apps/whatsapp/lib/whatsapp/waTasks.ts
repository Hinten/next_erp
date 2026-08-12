/**
 * Task scheduler for the WhatsApp inbound webhook processor — backed by a
 * **Firebase Functions task queue** (`onTaskDispatched`), not raw Cloud Tasks.
 * Mirrors `apps/mercado-pago/lib/payments/mpTasks.ts`; the legacy Flutter path
 * used a hand-rolled `CloudTasksClient.createTask` against
 * `projects/.../queues/whatsapp-cloud-api` (functions.dart) — this replaces that
 * with the Admin SDK's typed enqueue.
 *
 * The receiver enqueues ONE lean per-change payload
 * ({@link WhatsappNotificationPayload}) per `entry[].changes[]` onto the
 * `processWhatsappNotification` queue (auto-provisioned by the function on
 * deploy) and acks 200 fast; the queue dispatches to that function which runs
 * `handleNotificationTask` in-process at a rate bounded by the function's
 * `rateLimits`, retrying with backoff per its `retryConfig`.
 *
 * Config:
 *   - `WHATSAPP_TASKS_DISABLED=1` → `enqueue()` throws `WhatsappTasksDisabledError`;
 *     the receiver falls back to persisting the notification as `failed` so the
 *     reprocess sweep drains it (sweep-only mode — never a silent drop).
 *   - `WHATSAPP_TASKS_REGION` (default `FUNCTIONS_REGION` → `us-east5`) → the
 *     region the function + its queue live in. The region-qualified name is
 *     mandatory: without it the Admin SDK targets `us-central1` and the task
 *     silently drops. App Hosting / Cloud Run does NOT expose its region as an
 *     env var, so it must be configured.
 */
import { getFunctions } from 'firebase-admin/functions';

import { getAdminApp } from '../firebase/admin';
import { WHATSAPP_NOTIFICATION_QUEUE, type WhatsappNotificationPayload } from './notificacao';

/** Region the notification function/queue live in (must match FUNCTIONS_REGION). */
function whatsappTasksRegion(): string {
  return process.env.WHATSAPP_TASKS_REGION?.trim() || process.env.FUNCTIONS_REGION || 'us-east5';
}

/**
 * The enqueue seam. The receiver depends on this interface, not the transport,
 * so unit tests pass a fake recorder; the real one comes from
 * `createWhatsappTaskScheduler()`.
 */
export interface WhatsappTaskScheduler {
  enqueue(payload: WhatsappNotificationPayload): Promise<void>;
}

/**
 * Thrown by the disabled-mode scheduler so the receiver funnels into its
 * persist-for-the-sweep fallback (same branch as a genuine enqueue outage).
 */
export class WhatsappTasksDisabledError extends Error {
  constructor() {
    super('WHATSAPP_TASKS_DISABLED=1 — enqueue disabled; persisting for the sweep');
    this.name = 'WhatsappTasksDisabledError';
  }
}

/** Real scheduler — enqueues onto the `processWhatsappNotification` queue. */
class FirebaseWhatsappTaskScheduler implements WhatsappTaskScheduler {
  // Region-qualified name so the queue resolves to the deployed function's region
  // (the Admin SDK otherwise defaults to us-central1). Binds the default admin app.
  private queue() {
    return getFunctions(getAdminApp()).taskQueue<WhatsappNotificationPayload>(
      `locations/${whatsappTasksRegion()}/functions/${WHATSAPP_NOTIFICATION_QUEUE}`,
    );
  }

  async enqueue(payload: WhatsappNotificationPayload): Promise<void> {
    await this.queue().enqueue(payload);
  }
}

/**
 * Build the scheduler from the environment:
 *   - `WHATSAPP_TASKS_DISABLED=1` → a scheduler whose `enqueue()` throws
 *     `WhatsappTasksDisabledError` (the receiver persists + the sweep drains);
 *   - otherwise → the real `FirebaseWhatsappTaskScheduler`.
 */
export function createWhatsappTaskScheduler(): WhatsappTaskScheduler {
  if (process.env.WHATSAPP_TASKS_DISABLED === '1') {
    return {
      async enqueue() {
        throw new WhatsappTasksDisabledError();
      },
    };
  }
  return new FirebaseWhatsappTaskScheduler();
}
