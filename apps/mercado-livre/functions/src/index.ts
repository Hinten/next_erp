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
import { MERCADO_LIVRE_STOCK_SEND_QUEUE } from '../../lib/marketplace/estoquePlan';
import { MERCADO_LIVRE_PRICE_SYNC_QUEUE } from '../../lib/marketplace/precoSync';
import { MERCADO_LIVRE_NFE_UPLOAD_QUEUE } from '../../lib/marketplace/nfeUpload';
import { createMlTaskScheduler } from '../../lib/marketplace/mlTasks';
import { getDb } from './lib/admin';
import * as notificationHandlers from './processNotification';
import * as massImportHandlers from './processMassImport';
import * as stockSendHandlers from './sendStock';
import * as priceSyncHandlers from './processPriceSync';
import * as nfeUploadHandlers from './processNfeUpload';

/**
 * Mercado Livre Cloud Functions (gen2), codebase `mercado-livre`. Deployed as a
 * deploy-artifact sub-build of `@delfrance/mercado-livre-app` (see
 * scripts/prepare-deploy.mjs + firebase.mercado-livre.deploy.json).
 *
 * Step 6 wires the resilient notification pipeline as a **Cloud Tasks queue**
 * (`processMercadoLivreNotification`, ./processNotification) + an `onSchedule`
 * reprocess sweep; Step 9 PR 4 (#360) turns `importMercadoLivreOrders` into the
 * flag-gated order-backfill sweep. Step 8 (#621) adds the mass-import job queue
 * (`processMercadoLivreMassImport`, ./processMassImport). Step 10 PR B adds the
 * stock send queue (`sendMercadoLivreStock`, ./sendStock — 1 task = 1 ML call);
 * PR C adds the two flag-gated stock sweeps that feed it (./sweepStock). Step 11
 * PR-C adds the manual bulk price-sync job queue (`processMercadoLivrePriceSync`,
 * ./processPriceSync). Step 12 (#739) adds the NF-e invoice upload: the
 * `onNfeAprovada` Firestore trigger (./onNfeAprovada — this codebase's first)
 * feeding the `processMercadoLivreNfeUpload` queue (./processNfeUpload).
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

// Same rename-safety assertion for the Step 10 stock send queue: the stock
// sweeps (`mlStockTasks.ts`) and the handler's own 429-pause re-enqueue target
// `MERCADO_LIVRE_STOCK_SEND_QUEUE`.
if (!(MERCADO_LIVRE_STOCK_SEND_QUEUE in stockSendHandlers)) {
  throw new Error(
    `[mercado-livre] function-name drift: functions/src/sendStock.ts must export a ` +
      `handler named '${MERCADO_LIVRE_STOCK_SEND_QUEUE}' (the enqueue target). ` +
      `Rename the export and the MERCADO_LIVRE_STOCK_SEND_QUEUE constant together.`,
  );
}

/** The queue-based stock send processor (Step 10 PR B — 1 task = 1 ML call). */
export { sendMercadoLivreStock } from './sendStock';

// Same rename-safety assertion for the Step 11 price-sync queue: the
// `/atualizar-precos` route and the handler's own self-continuation / 429-pause
// re-enqueue (`mlPriceSyncTasks.ts`) target `MERCADO_LIVRE_PRICE_SYNC_QUEUE`.
if (!(MERCADO_LIVRE_PRICE_SYNC_QUEUE in priceSyncHandlers)) {
  throw new Error(
    `[mercado-livre] function-name drift: functions/src/processPriceSync.ts must export a ` +
      `handler named '${MERCADO_LIVRE_PRICE_SYNC_QUEUE}' (the enqueue target). ` +
      `Rename the export and the MERCADO_LIVRE_PRICE_SYNC_QUEUE constant together.`,
  );
}

/** The queue-based manual bulk price-sync job processor (Step 11 PR-C). */
export { processMercadoLivrePriceSync } from './processPriceSync';

// Same rename-safety assertion for the Step 12 NF-e upload queue: the
// `onNfeAprovada` trigger's scheduler (`mlNfeUploadTasks.ts`) enqueues against
// `MERCADO_LIVRE_NFE_UPLOAD_QUEUE`.
if (!(MERCADO_LIVRE_NFE_UPLOAD_QUEUE in nfeUploadHandlers)) {
  throw new Error(
    `[mercado-livre] function-name drift: functions/src/processNfeUpload.ts must export a ` +
      `handler named '${MERCADO_LIVRE_NFE_UPLOAD_QUEUE}' (the enqueue target). ` +
      `Rename the export and the MERCADO_LIVRE_NFE_UPLOAD_QUEUE constant together.`,
  );
}

/** The queue-based NF-e invoice upload processor (Step 12, #739 — 1 task = 1 NF-e). */
export { processMercadoLivreNfeUpload } from './processNfeUpload';

/**
 * The NF-e approval trigger (Step 12, #739) — this codebase's first Firestore
 * trigger, feeding the queue above. No rename-safety assertion for ITS name:
 * Eventarc binds a document path, not a queue/function name — nothing enqueues
 * against `onNfeAprovada` (the queue it feeds is covered by the
 * `MERCADO_LIVRE_NFE_UPLOAD_QUEUE` assertion above).
 */
export { onNfeAprovada } from './onNfeAprovada';

/**
 * The Mercado Livre conta → Mercado Envios `int_frete` sync trigger (#782). Keeps the
 * account's freight config doc in step with its `integracao` doc — created on connect,
 * re-synced on edit, deactivated on delete — restoring what the legacy Flutter conta
 * screen did inline on every save. Same "no rename-safety assertion" reasoning as
 * `onNfeAprovada` above: Eventarc binds a document path, and this one feeds no queue
 * at all. Binds no secrets (see `src/options.ts`).
 */
export { onIntegracaoMercadoLivreChanged } from './onIntegracaoMercadoLivreChanged';

/**
 * The flag-gated stock sweeps (Step 10 PR C): the 15-minute incremental sweep
 * + the 2AM daily full sweep, both feeding the `sendMercadoLivreStock` queue.
 * Plain `onSchedule` exports — nothing enqueues against THEIR names, so no
 * rename-safety assertion is needed (the queue they feed is covered by the
 * `MERCADO_LIVRE_STOCK_SEND_QUEUE` assertion above). No-ops until
 * `MERCADO_LIVRE_STOCK_SYNC_ENABLED=1` (the coordinated cutover).
 */
export { sweepMercadoLivreStock, sweepMercadoLivreStockDaily } from './sweepStock';

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
