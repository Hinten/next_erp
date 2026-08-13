import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import {
  MERCADO_LIVRE_NOTIFICATION_QUEUE,
  TASK_MAX_ATTEMPTS,
  handleNotificationTask,
} from '../../lib/marketplace/notificacao';
import { getDb } from './lib/admin';
import { readCacheSummary } from '@delfrance/data/admin/cache';

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
 *
 * ⚠️ The export name below IS the deployed function + queue name — it MUST equal
 * `MERCADO_LIVRE_NOTIFICATION_QUEUE` (the receiver enqueues against that string).
 * Rename both together, or the enqueue targets a non-existent queue (silent drop).
 *
 * Secrets: `MERCADO_LIVRE_CLIENT_ID` / `MERCADO_LIVRE_CLIENT_SECRET` are bound on
 * THIS function (mirrors `processMassImport.ts`) because the Step 9 order-import
 * default runner (`notificacao.ts`'s `runOrderImport`) calls
 * `loadMercadoLivreContext` → `resolveChannelContext`, which refreshes the
 * account's ML access token via `mercadoLivreOAuthConfig()` (reads both env
 * vars) whenever it's near expiry — same rationale as the mass-import function.
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
    secrets: ['MERCADO_LIVRE_CLIENT_ID', 'MERCADO_LIVRE_CLIENT_SECRET'],
  },
  async (req) => {
    const result = await handleNotificationTask(getDb(), req.data, req.retryCount ?? 0);
    logger.info('[mercado-livre] processed notification task', {
      queue: MERCADO_LIVRE_NOTIFICATION_QUEUE,
      outcome: result.outcome,
      topic: result.topic,
      retryCount: req.retryCount ?? 0,
      // CUMULATIVE for this instance — a notification has no tick to bracket.
      // The three-reads-into-one collapse is what this line makes visible.
      readCache: readCacheSummary(),
    });
  },
);
