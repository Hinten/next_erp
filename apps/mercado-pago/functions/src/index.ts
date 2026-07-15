// Import side-effect first: registers global function options (region) before
// any trigger is defined. See options.ts.
import './options';

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';

import {
  MERCADO_PAGO_NOTIFICATION_QUEUE,
  reprocessNotifications,
} from '../../lib/payments/notificacao';
import { getDb } from './lib/admin';
import * as notificationHandlers from './processNotification';

/**
 * Mercado Pago Cloud Functions (gen2), codebase `mercado-pago`. Deployed as a
 * deploy-artifact sub-build of `@delfrance/mercado-pago-app` (see
 * scripts/prepare-deploy.mjs + firebase.mercado-pago.deploy.json).
 *
 * #531 wires the resilient notification pipeline as a **Cloud Tasks queue**
 * (`processMercadoPagoNotification`, ./processNotification) + an `onSchedule`
 * reprocess sweep. Mirrors apps/mercado-livre/functions, adapted marketplace →
 * payments.
 */

// Rename-safety: the DEPLOYED function name is the export KEY of the handler
// below, and the receiver enqueues against `MERCADO_PAGO_NOTIFICATION_QUEUE`.
// ESM export names must be static literals (you can't compute an `export const`
// name), so instead of deriving one from the other we assert — at module load,
// i.e. during Firebase's deploy codebase-analysis — that they never drifted. A
// rename that updates only one side fails the deploy loudly here instead of
// silently enqueuing onto a queue that doesn't exist.
if (!(MERCADO_PAGO_NOTIFICATION_QUEUE in notificationHandlers)) {
  throw new Error(
    `[mercado-pago] function-name drift: functions/src/processNotification.ts must export a ` +
      `handler named '${MERCADO_PAGO_NOTIFICATION_QUEUE}' (the enqueue target). ` +
      `Rename the export and the MERCADO_PAGO_NOTIFICATION_QUEUE constant together.`,
  );
}

/** The queue-based notification processor (rate-limited, retry-with-backoff). */
export { processMercadoPagoNotification } from './processNotification';

/**
 * Reprocess backstop: re-drives persisted `failed` notifications older than 1h
 * (the queued task exhausted its retries, or a `failed`/unresolved account or
 * pedido has since resolved). Runs each inline, per-doc isolated, deduped by
 * `paymentId`, bounded — success deletes the doc, a persistent failure parks it
 * at the cap. Mirrors apps/mercado-livre's `reprocessMercadoLivreNotifications`.
 */
export const reprocessMercadoPagoNotifications = onSchedule(
  { schedule: 'every 30 minutes', timeZone: 'America/Sao_Paulo' },
  async () => {
    const result = await reprocessNotifications(getDb());
    logger.info('[mercado-pago] reprocess sweep', {
      processed: result.processed,
      outcomes: result.outcomes,
      errorCount: result.errors.length,
    });
    if (result.errors.length > 0) {
      logger.warn('[mercado-pago] reprocess sweep had per-doc failures', {
        errors: result.errors.slice(0, 10),
      });
    }
  },
);
