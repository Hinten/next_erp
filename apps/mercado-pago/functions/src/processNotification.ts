import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import {
  MERCADO_PAGO_NOTIFICATION_QUEUE,
  TASK_MAX_ATTEMPTS,
  handleNotificationTask,
} from '../../lib/payments/notificacao';
import { getDb } from './lib/admin';
import { readCacheSummary } from '@delfrance/data/admin/cache';
import { tasksInvokerOptions } from './tasksInvoker';

/**
 * Cloud Tasks dispatcher for MP webhook notifications (#531). The receiver
 * (App Hosting route) enqueues the lean payload onto this function's
 * auto-provisioned queue; the queue dispatches here and runs the work
 * **in-process** (no HTTP hop, no OIDC) at a rate bounded by `rateLimits`.
 *
 * `retryConfig.maxAttempts` mirrors `TASK_MAX_ATTEMPTS`: the handler retries a
 * transient failure with backoff, and on the FINAL attempt persists it as
 * `failed` (so the `onSchedule` sweep re-drives it) instead of throwing — the
 * throw/persist disposition lives in `handleNotificationTask` so it stays
 * unit-testable. The happy path persists NOTHING (the cost win).
 *
 * ⚠️ The export name below IS the deployed function + queue name — it MUST equal
 * `MERCADO_PAGO_NOTIFICATION_QUEUE` (the receiver enqueues against that string).
 * Rename both together, or the enqueue targets a non-existent queue (silent drop).
 */
export const processMercadoPagoNotification = onTaskDispatched(
  {
    // roles/run.invoker on this service + roles/cloudtasks.enqueuer on its
    // queue, applied at deploy time from TASKS_INVOKER_SA. Absent when unset.
    ...tasksInvokerOptions(),
    retryConfig: {
      maxAttempts: TASK_MAX_ATTEMPTS,
      minBackoffSeconds: 30,
      maxBackoffSeconds: 300,
      maxDoublings: 2,
    },
    rateLimits: { maxConcurrentDispatches: 3, maxDispatchesPerSecond: 5 },
  },
  async (req) => {
    // Read off the RAW payload, not the `TaskResult`: these two survive the
    // shared pipeline's schema-parse drop, where there is no validated payload
    // and no channel result at all — which is precisely the case an operator
    // most needs named.
    const payload = req.data as { paymentId?: unknown; collectorUserId?: unknown } | null;
    const result = await handleNotificationTask(getDb(), req.data, req.retryCount ?? 0);
    // ⚠️ `outcome` alone is not enough, and that gap is not theoretical: on
    // Mercado Livre's first live run this line reported a bare success for every
    // delivery while nothing was being written, because `done` is the
    // disposition for BOTH "reconciled the pedido" and "found a stale
    // redelivery and did nothing" (#1087, fixed for ML in #1136).
    //
    // `kind` separates a reconcile from a drop the channel decided on and from
    // the shared pipeline's schema-parse drop (which carries no `kind` at all);
    // `detail` carries the reconcile's own outcome; `paymentId` names the
    // payment, which `topic` does not; `collectorUserId` is what a park for an
    // unresolvable collector is ABOUT, and today reaches only a `console.error`.
    //
    // ONE call on purpose — the fields land in `jsonPayload` and are filterable
    // (`jsonPayload.detail="stale-ignorado"`), so more fields beat more lines.
    // `?? null` rather than leaving them undefined: Cloud Logging drops
    // `undefined` keys, so the key would vanish instead of reading as absent.
    logger.info('[mercado-pago] processed notification task', {
      queue: MERCADO_PAGO_NOTIFICATION_QUEUE,
      outcome: result.outcome,
      kind: result.kind ?? null,
      detail: result.detail ?? null,
      topic: result.topic ?? null,
      paymentId: typeof payload?.paymentId === 'string' ? payload.paymentId : null,
      collectorUserId:
        typeof payload?.collectorUserId === 'number' ? payload.collectorUserId : null,
      metodoId: result.metodoId ?? null,
      pedidoId: result.pedidoId ?? null,
      retryCount: req.retryCount ?? 0,
      // CUMULATIVE for this instance — a notification has no tick to bracket
      // (the sweep in `index.ts` brackets its own with mark/delta instead).
      readCache: readCacheSummary(),
    });
  },
);
