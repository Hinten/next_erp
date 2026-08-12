import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import {
  WHATSAPP_NOTIFICATION_QUEUE,
  TASK_MAX_ATTEMPTS,
  handleNotificationTask,
} from '../../lib/whatsapp/notificacao';
import { getDb } from './lib/admin';

/**
 * Cloud Tasks dispatcher for WhatsApp Cloud API webhook notifications (#527).
 * The receiver (App Hosting route) enqueues the lean per-change payload onto
 * this function's auto-provisioned queue; the queue dispatches here and runs
 * the work **in-process** (no HTTP hop, no OIDC) at a rate bounded by
 * `rateLimits`.
 *
 * `retryConfig.maxAttempts` mirrors `TASK_MAX_ATTEMPTS`: the handler retries a
 * transient failure with backoff, and on the FINAL attempt persists it as
 * `failed` (so the `onSchedule` sweep re-drives it) instead of throwing — the
 * throw/persist disposition lives in `handleNotificationTask` so it stays
 * unit-testable. The happy path persists NOTHING (the cost win).
 *
 * ⚠️ The export name below IS the deployed function + queue name — it MUST equal
 * `WHATSAPP_NOTIFICATION_QUEUE` (the receiver enqueues against that string).
 * Rename both together, or the enqueue targets a non-existent queue (silent drop).
 */
export const processWhatsappNotification = onTaskDispatched(
  {
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
    logger.info('[whatsapp] processed notification task', {
      queue: WHATSAPP_NOTIFICATION_QUEUE,
      outcome: result.outcome,
      field: result.field,
      contaId: result.contaId,
      retryCount: req.retryCount ?? 0,
    });
  },
);
