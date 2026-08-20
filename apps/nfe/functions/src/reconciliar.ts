import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { z } from 'zod';

import { NFeCertError } from '@delfrance/integrations-nfe';

import { runReconcile } from '../../lib/nfe/handlers/runReconcile';
import { runReconcileCce } from '../../lib/nfe/handlers/runReconcileCce';
import { getNFeRuntime } from '../../lib/nfe/runtime';
import { RECONCILE_FUNCTION, createTaskScheduler, taskPayloadSchema } from '../../lib/nfe/tasks';
import { safeErrorShape } from '../../lib/nfe/log';
import { getDb } from './lib/admin';
import { tasksInvokerOptions } from './tasksInvoker';

/**
 * Cloud Tasks dispatcher for the async NF-e reconciler. apps/nfe enqueues two
 * kinds of task onto this function's auto-provisioned queue, discriminated by
 * `kind` and **executed in-process** (no HTTP hop, no OIDC):
 *   - `consulta-lote` (#77) — consult an async lote by recibo (`runReconcile`)
 *     and re-enqueue the next consult while still cStat 105.
 *   - `cce-vinculo` (#81) — re-check a pending cStat-136 CC-e
 *     (`runReconcileCce`) and re-enqueue the next re-check while still 136.
 *
 * Retry disposition (the queue retries iff this throws):
 *   - handled outcome (cStat 656 terminal, attempt cap, aprovada/resolved,
 *     re-enqueued) → **return** (no retry; re-querying a 656 is a ban risk).
 *   - bad payload (Zod) / `NFeCertError` → **return** (deterministic; the
 *     backstop sweep covers a cert that's not yet uploaded).
 *   - runtime-not-ready / transport / Firestore → **throw** (bounded queue retry).
 */
/** The dispatcher body, extracted so the throw/return disposition is unit-testable. */
export async function handleReconciliarTask(data: unknown): Promise<void> {
  let payload;
  try {
    payload = taskPayloadSchema.parse(data);
  } catch (e) {
    if (e instanceof z.ZodError) {
      logger.error(`${RECONCILE_FUNCTION}: malformed task payload — dropping`, {
        issue: e.issues[0]?.message ?? 'invalid',
      });
      return; // deterministic — no retry
    }
    throw e;
  }

  // A kind-aware label for the logs (cce-vinculo has no nRec).
  const label =
    payload.kind === 'cce-vinculo'
      ? `cce pedido=${payload.pedidoId} nfe=${payload.nfeId} cce=${payload.cceId}`
      : `nRec=${payload.nRec}`;

  const fs = getDb();
  let baseRt;
  try {
    baseRt = getNFeRuntime();
  } catch (e) {
    logger.error(`${RECONCILE_FUNCTION}: runtime not ready`, safeErrorShape(e));
    throw e; // transient/config — let the queue retry (bounded)
  }

  const scheduler = createTaskScheduler();
  try {
    if (payload.kind === 'cce-vinculo') {
      const result = await runReconcileCce({ fs, baseRt, scheduler, payload });
      logger.info(
        `${RECONCILE_FUNCTION} ${label} cStat=${result.cStat} ` +
          `disposition=${result.disposition} reEnqueued=${result.reEnqueued}`,
      );
      // handled — terminal dispositions leave reEnqueued=false; no retry.
      return;
    }
    const result = await runReconcile({ fs, baseRt, scheduler, payload });
    logger.info(
      `${RECONCILE_FUNCTION} ${label} cStat=${result.cStat} ` +
        `recovered=${result.recovered} errored=${result.errored} ` +
        `stillPending=${result.stillPending} reEnqueued=${result.reEnqueued}`,
    );
    // handled — including 656 / cap (stillPending=0) → no re-enqueue, no retry.
  } catch (e) {
    if (e instanceof NFeCertError) {
      logger.error(`${RECONCILE_FUNCTION} ${label}: cert unavailable — backstop will retry`, {
        name: e.name,
      });
      return; // deterministic — no retry
    }
    logger.error(`${RECONCILE_FUNCTION} ${label}: transport/unexpected`, safeErrorShape(e));
    throw e; // transient — bounded queue retry
  }
}

/**
 * ⚠️ The export name below IS the deployed function + auto-provisioned queue name —
 * it MUST equal `RECONCILE_FUNCTION` (apps/nfe/lib/nfe/tasks.ts), which the producer
 * uses to build the enqueue path. Rename both together, or the enqueue targets a
 * non-existent queue (silent drop). Pinned by the coupling test in reconciliar.test.ts.
 */
export const reconciliarNfe = onTaskDispatched(
  {
    // roles/run.invoker on this service + roles/cloudtasks.enqueuer on its
    // queue, applied at deploy time from TASKS_INVOKER_SA. Absent when unset.
    ...tasksInvokerOptions(),
    retryConfig: { maxAttempts: 5, minBackoffSeconds: 30, maxBackoffSeconds: 300, maxDoublings: 3 },
    rateLimits: { maxConcurrentDispatches: 5, maxDispatchesPerSecond: 10 },
    // Cert secrets are declared once in src/options.ts (setGlobalOptions) for the
    // whole codebase.
  },
  (req) => handleReconciliarTask(req.data),
);
