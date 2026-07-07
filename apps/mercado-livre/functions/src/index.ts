// Import side-effect first: registers global function options (region) before
// any trigger is defined. See options.ts.
import './options';

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';

import { reprocessNotifications } from '../../lib/marketplace/notificacao';
import { getDb } from './lib/admin';

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
