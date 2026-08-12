import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { z } from 'zod';

import { createMlPriceSyncScheduler } from '../../lib/marketplace/mlPriceSyncTasks';
import {
  MERCADO_LIVRE_PRICE_SYNC_QUEUE,
  PRICE_SYNC_MAX_ATTEMPTS,
  type PriceSyncTaskPayload,
  priceSyncTaskSchema,
  processPriceSyncJob,
} from '../../lib/marketplace/precoSync';
import { getDb } from './lib/admin';

/**
 * Cloud Tasks dispatcher for the ML manual bulk price-sync job (Step 11 PR-C).
 * The `/atualizar-precos` route enqueues the first `{ jobId, integracaoId }`
 * task after creating the job doc; `processPriceSyncJob` re-enqueues onto this
 * SAME queue (via the scheduler passed in `deps`) for every subsequent
 * page/send batch — with `scheduleDelaySeconds` when ML 429s the conta — so
 * this dispatcher both starts AND continues the job. Like the mass import,
 * there is no separate sweep to fall back on.
 *
 * `retryConfig.maxAttempts` mirrors `PRICE_SYNC_MAX_ATTEMPTS`: a transient
 * (infra) failure retries with backoff, and on the FINAL attempt
 * `processPriceSyncJob` persists the job as `failed` instead of throwing —
 * that disposition lives in `precoSync.ts` so it stays unit-testable.
 * `rateLimits`/`timeoutSeconds` keep this to a single in-flight dispatch (the
 * job doc is the checkpoint; concurrent dispatches of the same job would race
 * the same doc) with headroom for a slow ML API page + a bounded send batch.
 *
 * Secrets: `MERCADO_LIVRE_CLIENT_ID` / `MERCADO_LIVRE_CLIENT_SECRET` are bound
 * on THIS function only (not codebase-wide via `options.ts`'s `setGlobalOptions`
 * — see the comment there) because `processPriceSyncJob`'s default
 * `resolveContext` calls `loadMercadoLivreContext` → `resolveChannelContext`,
 * which refreshes the account's ML access token via `mercadoLivreOAuthConfig()`
 * (reads both env vars) whenever it's near expiry.
 *
 * ⚠️ The export name below IS the deployed function + queue name — it MUST
 * equal `MERCADO_LIVRE_PRICE_SYNC_QUEUE` (the scheduler enqueues against that
 * string; enforced at load time in `index.ts`). Rename both together.
 */
export const processMercadoLivrePriceSync = onTaskDispatched(
  {
    retryConfig: {
      maxAttempts: PRICE_SYNC_MAX_ATTEMPTS,
      minBackoffSeconds: 30,
      maxBackoffSeconds: 300,
      maxDoublings: 2,
    },
    rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },
    timeoutSeconds: 540,
    secrets: ['MERCADO_LIVRE_CLIENT_ID', 'MERCADO_LIVRE_CLIENT_SECRET'],
  },
  async (req) => {
    let payload: PriceSyncTaskPayload;
    try {
      payload = priceSyncTaskSchema.parse(req.data);
    } catch (err) {
      if (err instanceof z.ZodError) {
        // A coding/enqueue bug (this queue only ever receives our own
        // `{ jobId, integracaoId }` payload) — nothing to retry, nothing to
        // persist against (we don't even have a jobId to mark failed).
        logger.error('[mercado-livre] price sync task DROPPED — malformed payload', {
          error: err.message,
        });
        return;
      }
      throw err;
    }

    const outcome = await processPriceSyncJob(
      { db: getDb(), scheduler: createMlPriceSyncScheduler() },
      payload,
      req.retryCount ?? 0,
    );
    logger.info('[mercado-livre] processed price sync task', {
      queue: MERCADO_LIVRE_PRICE_SYNC_QUEUE,
      jobId: payload.jobId,
      integracaoId: payload.integracaoId,
      outcome,
      retryCount: req.retryCount ?? 0,
    });
  },
);
