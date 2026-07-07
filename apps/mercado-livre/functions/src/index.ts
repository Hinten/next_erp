// Import side-effect first: registers global function options (region) before
// any trigger is defined. See options.ts.
import './options';

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';

import {
  MERCADO_LIVRE_NOTIFICATION_QUEUE,
  reprocessNotifications,
} from '../../lib/marketplace/notificacao';
import { getDb } from './lib/admin';
import * as notificationHandlers from './processNotification';

/**
 * Mercado Livre Cloud Functions (gen2), codebase `mercado-livre`. Deployed as a
 * deploy-artifact sub-build of `@delfrance/mercado-livre-app` (see
 * scripts/prepare-deploy.mjs + firebase.mercado-livre.deploy.json).
 *
 * Step 6 wires the resilient notification pipeline as a **Cloud Tasks queue**
 * (`processMercadoLivreNotification`, ./processNotification) + an `onSchedule`
 * reprocess sweep; `importMercadoLivreOrders` stays a skeleton until the
 * order-import milestone (#362).
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

/** Periodic backstop that pulls new/updated ML orders for each connected account. */
export const importMercadoLivreOrders = onSchedule('every 15 minutes', async () => {
  // TODO(#362): for each active Mercado Livre `integracao`, resolve its
  // ChannelContext (apps/mercado-livre/lib/marketplace) and run the incremental
  // order import (dedup by sha256(contaId|channel|orderId), completeness guard).
  logger.info('[mercado-livre] importMercadoLivreOrders tick (skeleton — no-op)');
});

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
