/**
 * Task scheduler for the Shopee push processor — backed by a **Firebase
 * Functions task queue** (`onTaskDispatched`), not raw Cloud Tasks / Terraform.
 * Mirrors `apps/mercado-pago/lib/payments/mpTasks.ts`.
 *
 * The receiver enqueues the lean push payload onto the
 * `processShopeeNotification` queue (auto-provisioned by the function on
 * deploy) and answers 204 fast; the queue dispatches to that function — which
 * runs the work in-process (no HTTP hop, no OIDC) at a rate bounded by the
 * function's `rateLimits`, retrying with backoff per its `retryConfig`.
 *
 * Transport: `firebase-admin`'s `getFunctions().taskQueue(...).enqueue(...)`. No
 * queue-path env and no google-auth-library: the queue is named after the
 * function and the invoking OIDC token is minted by the Cloud Tasks ↔ Functions
 * integration. ⚠️ Minting that token is not permission to USE it: Cloud Tasks
 * presents it to a gen2 function, which is a Cloud Run service, so the
 * enqueuing identity also needs `roles/run.invoker` ON THE SERVICE. That third
 * role is the one that gets forgotten, and it is the one that fails invisibly —
 * the enqueue already returned success, so nothing here can record the 403.
 * `getFunctions(getAdminApp())` binds the default admin app (App Hosting
 * injects ADC). All three roles land with the nested functions codebase's
 * DEPLOY.md; the dispatch one is applied by the deploy itself when
 * `TASKS_INVOKER_SA` is set (#1133).
 *
 * Config:
 *   - `SHOPEE_TASKS_DISABLED=1` → `enqueue()` throws
 *     {@link ShopeeTasksDisabledError}; the receiver falls back to persisting
 *     the push as `failed` so the reprocess sweep drains it (sweep-only mode —
 *     never a silent drop, and never a 5xx, which would count against Shopee's
 *     push success rate).
 *   - `SHOPEE_TASKS_REGION` (falls back to `FUNCTIONS_REGION`; no default) → the
 *     region the function + its queue are deployed to. The region-qualified
 *     name is mandatory: without it the Admin SDK targets `us-central1` and the
 *     task is **silently dropped** while the receiver still answers 204
 *     (#1108). An unset value THROWS on the first enqueue rather than guessing.
 *
 * ⚠️ Two candidates, in that order, and the order is the point. Mercado Livre
 * carries a warning that its single-candidate form is deliberate — its
 * functions deploy to a DIFFERENT region from its App Hosting backend, so a
 * `FUNCTIONS_REGION` fallback there would silently resolve the wrong one.
 * Shopee deploys both to one region, so the fallback is a convenience; if that
 * ever stops being true, drop `FUNCTIONS_REGION` from the candidate list rather
 * than reordering it.
 */
import { requireRegion } from '@delfrance/core/region';
import { getFunctions } from 'firebase-admin/functions';

import { getAdminApp } from '../firebase/admin';
import {
  SHOPEE_NOTIFICATION_QUEUE,
  type ShopeeNotificationPayload,
} from './notificacoes/notificacao';

/** Region the push function/queue live in (must match `FUNCTIONS_REGION`). */
export function shopeeTasksRegion(): string {
  return requireRegion({
    SHOPEE_TASKS_REGION: process.env.SHOPEE_TASKS_REGION,
    FUNCTIONS_REGION: process.env.FUNCTIONS_REGION,
  });
}

/**
 * The enqueue seam. The receiver depends on this interface, not the transport,
 * so unit tests pass a fake recorder; the real one comes from
 * {@link createShopeeTaskScheduler}.
 */
export interface ShopeeTaskScheduler {
  enqueue(payload: ShopeeNotificationPayload): Promise<void>;
}

/**
 * Thrown by the disabled-mode scheduler so the receiver funnels into its
 * persist-for-the-sweep fallback (the same branch as a genuine enqueue outage).
 */
export class ShopeeTasksDisabledError extends Error {
  constructor() {
    super('SHOPEE_TASKS_DISABLED=1 — enqueue desabilitado; persistindo para o sweep');
    this.name = 'ShopeeTasksDisabledError';
  }
}

/** Real scheduler — enqueues onto the `processShopeeNotification` queue. */
class FirebaseShopeeTaskScheduler implements ShopeeTaskScheduler {
  // Region-qualified name so the queue resolves to the deployed function's
  // region (the Admin SDK otherwise defaults to us-central1). Binds the default
  // admin app.
  private queue() {
    return getFunctions(getAdminApp()).taskQueue<ShopeeNotificationPayload>(
      `locations/${shopeeTasksRegion()}/functions/${SHOPEE_NOTIFICATION_QUEUE}`,
    );
  }

  async enqueue(payload: ShopeeNotificationPayload): Promise<void> {
    await this.queue().enqueue(payload);
  }
}

/**
 * Is the enqueue valve closed? Read BEFORE a decision, never inferred from a
 * throw — and the ONE reader of `SHOPEE_TASKS_DISABLED` (opt-in at exactly
 * `'1'`, like every other valve in this app).
 *
 * ⚠️ It exists for step 8's stuck-reservation sweep, which owes a verdict of its
 * own when the queue is off. Learning that by CATCHING
 * {@link ShopeeTasksDisabledError} could not produce one: the class is inside
 * `erroContidoPorConta` (`core/containment.ts:87`), so a disabled queue would
 * come out as one contained per-conta `lastError` and every candidate of that
 * conta would be skipped uncounted — an invisible outage where an observable one
 * belongs. And a DRY RUN never reaches the enqueue at all, so it could never
 * reach the verdict by any catch: `apps/mercado-livre/lib/marketplace/pedidos/pedidoTravadoSweep.ts:343`
 * returns `'redirecionado'` above its own try, so with the queue off a live tick
 * reports `tasks-desabilitado` and a dry run reports `redirecionado` for the
 * identical candidate — the exact conflation that verdict's own docblock
 * (`:180-186`) says it exists to prevent.
 */
export function shopeeTasksDesabilitado(): boolean {
  return process.env.SHOPEE_TASKS_DISABLED === '1';
}

/**
 * Build the scheduler from the environment:
 *   - `SHOPEE_TASKS_DISABLED=1` → a scheduler whose `enqueue()` throws
 *     {@link ShopeeTasksDisabledError} (the receiver persists + the sweep drains);
 *   - otherwise → the real {@link FirebaseShopeeTaskScheduler}.
 *
 * It reads the valve through {@link shopeeTasksDesabilitado} rather than the
 * variable, so the scheduler and every caller that must DECIDE about the valve
 * can never disagree about what `'1'` means.
 */
export function createShopeeTaskScheduler(): ShopeeTaskScheduler {
  if (shopeeTasksDesabilitado()) {
    return {
      async enqueue() {
        throw new ShopeeTasksDisabledError();
      },
    };
  }
  return new FirebaseShopeeTaskScheduler();
}
