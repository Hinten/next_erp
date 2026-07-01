// Import side-effect first: registers global function options (region) before
// any trigger is defined. See options.ts.
import './options';

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';

/**
 * Mercado Livre Cloud Functions (gen2), codebase `mercado-livre`. Deployed as a
 * deploy-artifact sub-build of `@delfrance/mercado-livre-app` (see
 * scripts/prepare-deploy.mjs + firebase.mercado-livre.deploy.json).
 *
 * These are SKELETON stubs — the real behavior lands with the per-channel port:
 *   - importMercadoLivreOrders   → #362 (pull new/updated orders per account)
 *   - processMercadoLivreNotification → #290/#360 (process a persisted notification)
 */

/** Periodic backstop that pulls new/updated ML orders for each connected account. */
export const importMercadoLivreOrders = onSchedule('every 15 minutes', async () => {
  // TODO(#362): for each active Mercado Livre `integracao`, resolve its
  // ChannelContext (apps/mercado-livre/lib/marketplace) and run the incremental
  // order import (dedup by sha256(contaId|channel|orderId), completeness guard).
  logger.info('[mercado-livre] importMercadoLivreOrders tick (skeleton — no-op)');
});

/**
 * Real-time processor for a persisted ML notification. The webhook receiver
 * (apps/mercado-livre/app/api/webhooks/mercado-livre) will persist notifications
 * under `integracao/{integracaoId}/notificacoesMercadoLivre/{notifId}`; this
 * trigger fires on create.
 */
export const processMercadoLivreNotification = onDocumentCreated(
  'integracao/{integracaoId}/notificacoesMercadoLivre/{notifId}',
  async () => {
    // TODO(#290/#360): re-fetch the notification's `resource` from the ML API
    // with the account token, apply it (order/item/question), then delete or mark
    // the notification doc processed (idempotent).
    logger.info('[mercado-livre] processMercadoLivreNotification (skeleton — no-op)');
  },
);
