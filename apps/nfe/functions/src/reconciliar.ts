import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { z } from 'zod';

import { NFeCertError } from '@delfrance/integrations-nfe';

import { runReconcile } from '../../lib/nfe/handlers/runReconcile';
import { getNFeRuntime } from '../../lib/nfe/runtime';
import { createTaskScheduler, consultaTaskPayloadSchema } from '../../lib/nfe/tasks';
import { safeErrorShape } from '../../lib/nfe/log';
import { getDb } from './lib/admin';

/**
 * Cloud Tasks dispatcher for the async NF-e reconciler (#77). apps/nfe enqueues
 * one task per lote at `now + tMed` (then per-attempt backoff). This function —
 * whose queue is auto-provisioned on deploy — **executes the reconcile
 * in-process** (`runReconcile`): consults the lote by recibo and re-enqueues the
 * next consult while still pending. No HTTP hop, no OIDC.
 *
 * Retry disposition (the queue retries iff this throws):
 *   - handled outcome (incl. cStat 656 terminal, attempt cap, aprovada,
 *     105-reenqueued) → **return** (no retry; re-querying a 656 is a ban risk).
 *   - bad payload (Zod) / `NFeCertError` → **return** (deterministic; the
 *     backstop sweep covers a cert that's not yet uploaded).
 *   - runtime-not-ready / transport / Firestore → **throw** (bounded queue retry).
 */
/** The dispatcher body, extracted so the throw/return disposition is unit-testable. */
export async function handleReconciliarTask(data: unknown): Promise<void> {
  let payload;
  try {
    payload = consultaTaskPayloadSchema.parse(data);
  } catch (e) {
    if (e instanceof z.ZodError) {
      logger.error('reconciliarNfe: malformed task payload — dropping', {
        issue: e.issues[0]?.message ?? 'invalid',
      });
      return; // deterministic — no retry
    }
    throw e;
  }

  const fs = getDb();
  let baseRt;
  try {
    baseRt = getNFeRuntime();
  } catch (e) {
    logger.error('reconciliarNfe: runtime not ready', safeErrorShape(e));
    throw e; // transient/config — let the queue retry (bounded)
  }

  const scheduler = createTaskScheduler();
  try {
    const result = await runReconcile({ fs, baseRt, scheduler, payload });
    logger.info(
      `reconciliarNfe nRec=${payload.nRec} cStat=${result.cStat} ` +
        `recovered=${result.recovered} errored=${result.errored} ` +
        `stillPending=${result.stillPending} reEnqueued=${result.reEnqueued}`,
    );
    // handled — including 656 / cap (stillPending=0) → no re-enqueue, no retry.
  } catch (e) {
    if (e instanceof NFeCertError) {
      logger.error(`reconciliarNfe nRec=${payload.nRec}: cert unavailable — backstop will retry`, {
        name: e.name,
      });
      return; // deterministic — no retry
    }
    logger.error(`reconciliarNfe nRec=${payload.nRec}: transport/unexpected`, safeErrorShape(e));
    throw e; // transient — bounded queue retry
  }
}

export const reconciliarNfe = onTaskDispatched(
  {
    retryConfig: { maxAttempts: 5, minBackoffSeconds: 30, maxBackoffSeconds: 300, maxDoublings: 3 },
    rateLimits: { maxConcurrentDispatches: 5, maxDispatchesPerSecond: 10 },
  },
  (req) => handleReconciliarTask(req.data),
);
