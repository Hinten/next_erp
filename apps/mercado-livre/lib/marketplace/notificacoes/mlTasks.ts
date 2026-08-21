/**
 * Task scheduler for the Mercado Livre webhook processor — backed by a **Firebase
 * Functions task queue** (`onTaskDispatched`), not raw Cloud Tasks / Terraform.
 * Mirrors `apps/nfe/lib/nfe/tasks.ts`.
 *
 * The receiver enqueues the lean notification payload onto the
 * `processMercadoLivreNotification` queue (auto-provisioned by the function on
 * deploy) and acks 200 fast; the queue dispatches to that function — which runs
 * the work in-process (no HTTP hop, no OIDC) at a rate bounded by the function's
 * `rateLimits`, retrying with backoff per its `retryConfig`.
 *
 * Transport: `firebase-admin`'s `getFunctions().taskQueue(...).enqueue(...)`. No
 * queue-path env and no google-auth-library: the queue is named after the
 * function and the invoking OIDC token is minted by the Cloud Tasks ↔ Functions
 * integration. `getFunctions(getAdminApp())` binds the default admin app (App
 * Hosting injects ADC). One-time IAM (grant the App Hosting runtime SA
 * `roles/cloudtasks.enqueuer` + `roles/iam.serviceAccountUser` on the functions
 * runtime SA) is in functions/DEPLOY.md.
 *
 * ⚠️ Minting that token is NOT the same as being allowed to use it, and
 * this docblock used to stop one sentence too early. The token's principal is
 * the enqueuer's own identity (nothing here overrides it), and a gen2 function
 * is a Cloud Run service - so that identity ALSO needs `roles/run.invoker` on
 * the target service. Without it the task is created and dispatched and the
 * service answers 403 `run.routes.invoke`, which this code never observes: the
 * enqueue SUCCEEDED, so no failure document is written and the notification
 * dies inside Cloud Tasks leaving no trace in Firestore. Found on the first
 * live run; all three roles are now in functions/DEPLOY.md.
 *
 * Config:
 *   - `MERCADO_LIVRE_TASKS_DISABLED=1` → `enqueue()` throws `MlTasksDisabledError`;
 *     the receiver falls back to persisting the notification as `failed` so the
 *     reprocess sweep drains it (sweep-only mode — never a silent drop).
 *   - `MERCADO_LIVRE_TASKS_REGION` (default `FUNCTIONS_REGION` → `us-east5`) → the
 *     region the function + its queue are deployed to. The region-qualified name
 *     is mandatory: without it the Admin SDK targets `us-central1` and the task
 *     silently drops. App Hosting / Cloud Run does NOT expose its own region as an
 *     env var (only the metadata server does), so it must be configured; the
 *     default matches the ML backend's deploy region (`us-east5`).
 *
 * `enqueue`'s optional 2nd arg (`MlEnqueueOptions`) passes through to the queue's
 * `TaskOptions` — the webhook route uses `scheduleDelaySeconds: 10` for the
 * order-family topics (`orders_v2`/`orders`/`payments`/`shipments`), since ML is
 * eventually consistent and an immediate re-fetch can race the write that fired
 * the notification (legacy `functions.dart:17-48` delayed EVERY topic this way;
 * we scope it to the topics that actually re-fetch a cross-referenced resource).
 */
import { getFunctions } from 'firebase-admin/functions';

import { getAdminApp } from '../../firebase/admin';
import { MERCADO_LIVRE_NOTIFICATION_QUEUE, type MlNotificationPayload } from './notificacao';

/**
 * Region the notification function and its queue live in.
 *
 * ⚠️ This is NOT the codebase region and must not fall back to it. Cloud Tasks
 * does not exist in `us-east5`, so the queue functions are pinned to `us-east1`
 * (`TASKS_SCHEDULER_REGION` in the functions codebase) while the Firestore
 * triggers stay in the Firestore region. A `FUNCTIONS_REGION` fallback used to
 * sit here and is actively harmful now: on a backend where that variable names
 * the data region, every enqueue would resolve a queue that does not exist and
 * the Admin SDK would silently target `us-central1`.
 */
export function mlTasksRegion(): string {
  return process.env.MERCADO_LIVRE_TASKS_REGION?.trim() || 'us-east1';
}

/**
 * Per-enqueue delivery options — currently just the delay. Mirrors (a subset
 * of) the Functions SDK's `TaskOptions.scheduleDelaySeconds`; kept as our own
 * minimal shape rather than re-exporting the SDK type so callers (the webhook
 * route) don't need a `firebase-admin/functions` import for a single field.
 */
export interface MlEnqueueOptions {
  /** Delay (seconds) added to now before the task is first attempted. */
  scheduleDelaySeconds?: number;
}

/**
 * The enqueue seam. The receiver depends on this interface, not the transport, so
 * unit tests pass a fake recorder; the real one comes from `createMlTaskScheduler()`.
 */
export interface MlTaskScheduler {
  enqueue(payload: MlNotificationPayload, opts?: MlEnqueueOptions): Promise<void>;
}

/**
 * Thrown by the disabled-mode scheduler so the receiver funnels into its
 * persist-for-the-sweep fallback (same branch as a genuine enqueue outage).
 */
export class MlTasksDisabledError extends Error {
  constructor() {
    super('MERCADO_LIVRE_TASKS_DISABLED=1 — enqueue disabled; persisting for the sweep');
    this.name = 'MlTasksDisabledError';
  }
}

/** Real scheduler — enqueues onto the `processMercadoLivreNotification` queue. */
class FirebaseMlTaskScheduler implements MlTaskScheduler {
  // Region-qualified name so the queue resolves to the deployed function's region
  // (the Admin SDK otherwise defaults to us-central1). Binds the default admin app.
  private queue() {
    return getFunctions(getAdminApp()).taskQueue<MlNotificationPayload>(
      `locations/${mlTasksRegion()}/functions/${MERCADO_LIVRE_NOTIFICATION_QUEUE}`,
    );
  }

  async enqueue(payload: MlNotificationPayload, opts?: MlEnqueueOptions): Promise<void> {
    await this.queue().enqueue(payload, opts);
  }
}

/**
 * Build the scheduler from the environment:
 *   - `MERCADO_LIVRE_TASKS_DISABLED=1` → a scheduler whose `enqueue()` throws
 *     `MlTasksDisabledError` (the receiver persists + the sweep drains);
 *   - otherwise → the real `FirebaseMlTaskScheduler`.
 */
export function createMlTaskScheduler(): MlTaskScheduler {
  if (process.env.MERCADO_LIVRE_TASKS_DISABLED === '1') {
    return {
      async enqueue() {
        throw new MlTasksDisabledError();
      },
    };
  }
  return new FirebaseMlTaskScheduler();
}
