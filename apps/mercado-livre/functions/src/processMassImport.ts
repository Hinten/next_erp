import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { z } from 'zod';

import {
  MASS_IMPORT_MAX_ATTEMPTS,
  MERCADO_LIVRE_MASS_IMPORT_QUEUE,
  type MassImportTaskPayload,
  massImportTaskSchema,
  processMassImportJob,
} from '../../lib/marketplace/import/massImport';
import { createMlMassImportScheduler } from '../../lib/marketplace/tasks/mlMassImportTasks';
import { getDb } from './lib/admin';

/**
 * Cloud Tasks dispatcher for the ML mass-import job (Step 8, #621). The
 * `/importar-todos` route enqueues the first `{ jobId, integracaoId }` task
 * after creating the job doc; `processMassImportJob` re-enqueues onto this
 * SAME queue (via the scheduler passed in `deps`) for every subsequent
 * page/drain batch, so this dispatcher both starts AND continues the job —
 * unlike the notification pipeline, there's no separate sweep to fall back on.
 *
 * `retryConfig.maxAttempts` mirrors `MASS_IMPORT_MAX_ATTEMPTS`: a transient
 * (infra) failure retries with backoff, and on the FINAL attempt
 * `processMassImportJob` persists the job as `failed` instead of throwing —
 * that disposition lives in `massImport.ts` so it stays unit-testable.
 * `rateLimits`/`timeoutSeconds` keep this to a single in-flight dispatch (the
 * job doc is the checkpoint; concurrent dispatches of the same job would race
 * the same doc) with headroom for a slow ML API page + a bounded drain.
 *
 * Secrets: `MERCADO_LIVRE_CLIENT_ID` / `MERCADO_LIVRE_CLIENT_SECRET` are bound
 * on THIS function only (not codebase-wide via `options.ts`'s `setGlobalOptions`
 * — see the comment there) because `processMassImportJob`'s default
 * `resolveImportDeps` calls `loadMercadoLivreContext` → `resolveChannelContext`,
 * which refreshes the account's ML access token via `mercadoLivreOAuthConfig()`
 * (reads both env vars) whenever it's near expiry.
 *
 * ⚠️ The export name below IS the deployed function + queue name — it MUST
 * equal `MERCADO_LIVRE_MASS_IMPORT_QUEUE` (the scheduler enqueues against that
 * string; enforced at load time in `index.ts`). Rename both together.
 */
export const processMercadoLivreMassImport = onTaskDispatched(
  {
    retryConfig: {
      maxAttempts: MASS_IMPORT_MAX_ATTEMPTS,
      minBackoffSeconds: 30,
      maxBackoffSeconds: 300,
      maxDoublings: 2,
    },
    rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },
    timeoutSeconds: 540,
    secrets: ['MERCADO_LIVRE_CLIENT_ID', 'MERCADO_LIVRE_CLIENT_SECRET'],
  },
  async (req) => {
    let payload: MassImportTaskPayload;
    try {
      payload = massImportTaskSchema.parse(req.data);
    } catch (err) {
      if (err instanceof z.ZodError) {
        // A coding/enqueue bug (this queue only ever receives our own
        // `{ jobId, integracaoId }` payload) — nothing to retry, nothing to
        // persist against (we don't even have a jobId to mark failed).
        logger.error('[mercado-livre] mass import task DROPPED — malformed payload', {
          error: err.message,
        });
        return;
      }
      throw err;
    }

    const outcome = await processMassImportJob(
      { db: getDb(), scheduler: createMlMassImportScheduler() },
      payload,
      req.retryCount ?? 0,
    );
    logger.info('[mercado-livre] processed mass import task', {
      queue: MERCADO_LIVRE_MASS_IMPORT_QUEUE,
      jobId: payload.jobId,
      integracaoId: payload.integracaoId,
      outcome,
      retryCount: req.retryCount ?? 0,
    });
  },
);
