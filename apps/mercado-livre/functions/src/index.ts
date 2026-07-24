// Import side-effect first: registers global function options (region) before
// any trigger is defined. See options.ts.
import './options';

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';

import {
  MERCADO_LIVRE_NOTIFICATION_QUEUE,
  reprocessNotifications,
} from '../../lib/marketplace/notificacao';
import { MERCADO_LIVRE_MASS_IMPORT_QUEUE } from '../../lib/marketplace/massImport';
import {
  ORDER_BACKFILL_FLAG_ENV,
  runOrderBackfillSweep,
} from '../../lib/marketplace/orderBackfill';
import { createMlTaskScheduler } from '../../lib/marketplace/mlTasks';
import { getDb } from './lib/admin';
import * as notificationHandlers from './processNotification';
import * as massImportHandlers from './processMassImport';

/**
 * Mercado Livre Cloud Functions (gen2), codebase `mercado-livre`. Deployed as a
 * deploy-artifact sub-build of `@delfrance/mercado-livre-app` (see
 * scripts/prepare-deploy.mjs + firebase.mercado-livre.deploy.json).
 *
 * Step 6 wires the resilient notification pipeline as a **Cloud Tasks queue**
 * (`processMercadoLivreNotification`, ./processNotification) + an `onSchedule`
 * reprocess sweep; Step 9 PR 4 (#360) turns `importMercadoLivreOrders` into the
 * flag-gated order-backfill sweep. Step 8 (#621) adds the mass-import job queue
 * (`processMercadoLivreMassImport`, ./processMassImport).
 */

// Rename-safety: the DEPLOYED function name is the export KEY of the handler
// below, and the receiver enqueues against `MERCADO_LIVRE_NOTIFICATION_QUEUE`.
// ESM export names must be static literals (you can't compute an `export const`
// name), so instead of deriving one from the other we assert — at module load,
// i.e. during Firebase's deploy codebase-analysis — that they never drifted. A
// rename that updates only one side fails the deploy loudly here instead of
// silently enqueuing onto a queue that doesn't exist.
if (!(MERCADO_LIVRE_NOTIFICATION_QUEUE in notificationHandlers)) {
  throw new Error(
    `[mercado-livre] function-name drift: functions/src/processNotification.ts must export a ` +
      `handler named '${MERCADO_LIVRE_NOTIFICATION_QUEUE}' (the enqueue target). ` +
      `Rename the export and the MERCADO_LIVRE_NOTIFICATION_QUEUE constant together.`,
  );
}

/** The queue-based notification processor (rate-limited, retry-with-backoff). */
export { processMercadoLivreNotification } from './processNotification';

// Same rename-safety assertion for the Step 8 mass-import queue: the scheduler
// (`mlMassImportTasks.ts`, and `processMassImportJob`'s own self-continuation)
// enqueues against `MERCADO_LIVRE_MASS_IMPORT_QUEUE`.
if (!(MERCADO_LIVRE_MASS_IMPORT_QUEUE in massImportHandlers)) {
  throw new Error(
    `[mercado-livre] function-name drift: functions/src/processMassImport.ts must export a ` +
      `handler named '${MERCADO_LIVRE_MASS_IMPORT_QUEUE}' (the enqueue target). ` +
      `Rename the export and the MERCADO_LIVRE_MASS_IMPORT_QUEUE constant together.`,
  );
}

/** The queue-based mass-import job processor (Step 8, #621). */
export { processMercadoLivreMassImport } from './processMassImport';

/**
 * Periodic backstop that pulls new/updated ML orders for each connected account
 * (Step 9 PR 4, #360): every 15 minutes the sweep pages `GET /orders/search`
 * per active conta from its durable cursor and enqueues a synthetic `orders_v2`
 * notification per order onto the existing processing queue — the same
 * idempotent, staleness-gated import path a real webhook takes.
 *
 * **Flag-gated OFF**: until `MERCADO_LIVRE_ORDER_BACKFILL_ENABLED=1` is set
 * (post webhook-callback cutover) the function deploys, ticks, logs one info
 * line and does nothing.
 *
 * Secrets: the sweep resolves each conta's channel context (token refresh via
 * `mercadoLivreOAuthConfig()`), so it needs the ML app credentials bound —
 * same rationale as `processNotification.ts`/`processMassImport.ts`.
 */
export const importMercadoLivreOrders = onSchedule(
  {
    schedule: 'every 15 minutes',
    timeZone: 'America/Sao_Paulo',
    secrets: ['MERCADO_LIVRE_CLIENT_ID', 'MERCADO_LIVRE_CLIENT_SECRET'],
    // Worst case per tick is N contas × (MAX_PAGES_PER_TICK searches + up to
    // 500 sequential Cloud Tasks enqueues) — the 60s onSchedule default can't
    // absorb that; 540s matches the mass-import processor's budget.
    timeoutSeconds: 540,
  },
  async () => {
    const result = await runOrderBackfillSweep(getDb(), {
      scheduler: createMlTaskScheduler(),
      nowMs: Date.now(),
    });
    if (!result.enabled) {
      logger.info(
        `[mercado-livre] order-backfill sweep disabled (${ORDER_BACKFILL_FLAG_ENV} != '1') — no-op`,
      );
      return;
    }
    const errors = result.contas.filter((c) => c.error != null);
    logger.info('[mercado-livre] order-backfill sweep', {
      enabled: result.enabled,
      contas: result.contas.length,
      enqueued: result.contas.reduce((sum, c) => sum + c.enqueued, 0),
      truncated: result.contas.filter((c) => c.truncated).length,
      errorCount: errors.length,
    });
    if (errors.length > 0) {
      logger.warn('[mercado-livre] order-backfill sweep had per-conta failures', {
        errors: errors.slice(0, 10).map((c) => ({ integracaoId: c.integracaoId, error: c.error })),
      });
    }
  },
);

/**
 * Reprocess backstop: re-drives persisted `failed` notifications older than 1h
 * (the queued task exhausted its retries, or a `failed` account has since
 * connected). Runs each inline, per-doc isolated, deduped by `resource`,
 * bounded — success deletes the doc, a persistent failure parks it at the cap.
 * Mirrors the legacy `manageNotificationsMercadoLivre` sweep.
 */
export const reprocessMercadoLivreNotifications = onSchedule(
  { schedule: 'every 30 minutes', timeZone: 'America/Sao_Paulo' },
  async () => {
    const result = await reprocessNotifications(getDb());
    logger.info('[mercado-livre] reprocess sweep', {
      processed: result.processed,
      outcomes: result.outcomes,
      errorCount: result.errors.length,
    });
    if (result.errors.length > 0) {
      logger.warn('[mercado-livre] reprocess sweep had per-doc failures', {
        errors: result.errors.slice(0, 10),
      });
    }
  },
);
