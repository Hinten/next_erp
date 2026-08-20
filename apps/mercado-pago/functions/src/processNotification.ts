import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import {
  MERCADO_PAGO_NOTIFICATION_QUEUE,
  TASK_MAX_ATTEMPTS,
  handleNotificationTask,
} from '../../lib/payments/notificacao';
import { getDb } from './lib/admin';
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
    const result = await handleNotificationTask(getDb(), req.data, req.retryCount ?? 0);
    logger.info('[mercado-pago] processed notification task', {
      queue: MERCADO_PAGO_NOTIFICATION_QUEUE,
      outcome: result.outcome,
      topic: result.topic,
      retryCount: req.retryCount ?? 0,
    });
  },
);
