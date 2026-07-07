import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import { TASK_MAX_ATTEMPTS, handleNotificationTask } from '../../lib/marketplace/notificacao';
import { getDb } from './lib/admin';

/**
 * Cloud Tasks dispatcher for ML webhook notifications (Step 6). The receiver
 * (App Hosting route) enqueues the lean payload onto this function's
 * auto-provisioned queue; the queue dispatches here and runs the work
 * **in-process** (no HTTP hop, no OIDC) at a rate bounded by `rateLimits`.
 *
 * `retryConfig.maxAttempts` mirrors `TASK_MAX_ATTEMPTS`: the handler retries a
 * transient failure with backoff, and on the FINAL attempt persists it as
 * `failed` (so the `onSchedule` sweep re-drives it) instead of throwing — the
 * throw/persist disposition lives in `handleNotificationTask` so it stays
 * unit-testable. The happy path persists NOTHING (the cost win).
 */
export const processMercadoLivreNotification = onTaskDispatched(
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
    logger.info('[mercado-livre] processed notification task', {
      outcome: result.outcome,
      topic: result.topic,
      retryCount: req.retryCount ?? 0,
    });
  },
);
