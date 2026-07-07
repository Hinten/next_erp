// Import side-effect first: registers global function options (region) before
// any trigger is defined. See options.ts.
import './options';

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';

import { processNotification, reprocessNotifications } from '../../lib/marketplace/notificacao';
import { getDb } from './lib/admin';

/**
 * Mercado Livre Cloud Functions (gen2), codebase `mercado-livre`. Deployed as a
 * deploy-artifact sub-build of `@delfrance/mercado-livre-app` (see
 * scripts/prepare-deploy.mjs + firebase.mercado-livre.deploy.json).
 *
 * Step 6 wires the resilient notification pipeline; `importMercadoLivreOrders`
 * stays a skeleton until the order-import milestone (#362).
 */

/** Periodic backstop that pulls new/updated ML orders for each connected account. */
export const importMercadoLivreOrders = onSchedule('every 15 minutes', async () => {
  // TODO(#362): for each active Mercado Livre `integracao`, resolve its
  // ChannelContext (apps/mercado-livre/lib/marketplace) and run the incremental
  // order import (dedup by sha256(contaId|channel|orderId), completeness guard).
  logger.info('[mercado-livre] importMercadoLivreOrders tick (skeleton — no-op)');
});

/**
 * Real-time processor for a persisted ML notification. The receiver persists
 * every notification blind to the TOP-LEVEL `notificacoesMercadoLivre` keyed by
 * the ML `_id`; this fires on create. `{ retry: true }` = Eventarc at-least-once
 * with bounded backoff — `processNotification` THROWS on a transient failure so
 * it retries, and returns (marking failed/parked) on a deterministic one.
 * Idempotent: a terminal doc is skipped, so a redelivery never double-applies.
 */
export const processMercadoLivreNotification = onDocumentCreated(
  { document: 'notificacoesMercadoLivre/{notifId}', retry: true },
  async (event) => {
    const notifId = event.params.notifId;
    const result = await processNotification(getDb(), notifId);
    logger.info('[mercado-livre] processed notification', {
      notifId,
      outcome: result.outcome,
      topic: result.topic,
    });
  },
);

/**
 * Reprocess backstop: re-drives notifications still `pending`/`failed` and
 * older than 1h (the create trigger may have missed them, or a `failed`
 * account has since connected). Per-doc isolated, deduped by `resource`,
 * bounded — mirrors the legacy `manageNotificationsMercadoLivre` sweep.
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
