// Import side-effect first: registers global function options (region) before
// any trigger is defined. See options.ts.
//
// ⚠️ `TASKS_SCHEDULER_REGION` is pulled in HERE rather than lower down with the
// other named imports, and the position is the whole point: ESM evaluates
// modules in the order their import declarations appear, so a second
// `from './options'` further down would leave this one to satisfy
// `import/no-duplicates` by merging INTO it — moving the option registration
// after the trigger modules and silently undoing the ordering this comment
// exists to guarantee.
//
// ⚠️ This line is load-bearing even when its BINDING is not. The bare
// `import './options';` it replaced was unremovable by construction — no
// binding, nothing to look unused. A named import is only self-evidently
// needed while `TASKS_SCHEDULER_REGION` has a reader, and `no-unused-vars` is
// an error since #1448, so the day the last reference goes CI will point
// whoever removes it straight at deleting this line. That un-registers the
// global function options for every trigger in the file, and it is invisible:
// the functions deploy fine, to the wrong region (#1108). If that day comes,
// restore the bare `import './options';` — do not delete the line.
import { TASKS_SCHEDULER_REGION } from './options';

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';

import {
  MERCADO_LIVRE_NOTIFICATION_QUEUE,
  reprocessDeferredNotifications,
  reprocessNotifications,
} from '../../lib/marketplace/notificacoes/notificacao';
import { MERCADO_LIVRE_MASS_IMPORT_QUEUE } from '../../lib/marketplace/mass-import/massImport';
import {
  ORDER_BACKFILL_FLAG_ENV,
  runOrderBackfillSweep,
} from '../../lib/marketplace/notificacoes/orderBackfill';
import {
  MISSED_FEEDS_FLAG_ENV,
  runMissedFeedsSweep,
} from '../../lib/marketplace/notificacoes/missedFeedsSweep';
import {
  PEDIDO_TRAVADO_FLAG_ENV,
  runPedidoTravadoSweep,
} from '../../lib/marketplace/pedidos/pedidoTravadoSweep';
import { MERCADO_LIVRE_STOCK_SEND_QUEUE } from '../../lib/marketplace/estoque/bulkEstoquePlan';
import { MERCADO_LIVRE_PRICE_SYNC_QUEUE } from '../../lib/marketplace/preco/precoSync';
import { MERCADO_LIVRE_NFE_UPLOAD_QUEUE } from '../../lib/marketplace/nfe/nfeUpload';
import { createMlTaskScheduler } from '../../lib/marketplace/notificacoes/mlTasks';
import { getDb } from './lib/admin';
import { readCacheDelta, readCacheMark } from '@delfrance/data/admin/cache';
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
 * The two link triggers that own `produtos.integracoesComProduto` (#920) — the
 * anchor pre-filter both ML sweeps open with. They replace six hand-written
 * stamp sites and, crucially, they derive the array from the LINK
 * subcollections rather than from the sibling `marketplace` array, which is
 * what lets `marketplace` + `marketplaceIds` be retired on their own at the
 * Flutter decommission (#431 lock 2).
 *
 * Same "no rename-safety assertion" reasoning as the triggers above: Eventarc
 * binds a document path and neither feeds a queue. Both bind no secrets (see
 * `src/options.ts`) and both decide from the event payload before touching
 * Firestore, because their documents are rewritten far more often than
 * membership actually moves.
 */
export { onProdutoMercadoLivreLinkChanged } from './onProdutoMercadoLivreLinkChanged';
export { onVariacaoMercadoLivreLinkChanged } from './onVariacaoMercadoLivreLinkChanged';

/**
 * The flag-gated stock sweeps: the 15-minute incremental tier, the 02:00 daily
 * tier and the MONTHLY full reconciliation (03:00 on the 1st), all feeding the
 * `sendMercadoLivreStock` queue. The three differ in window AND in send policy —
 * see ADR 0014; the incremental one additionally skips a change that leaves the
 * quantity comfortably high on both sides.
 *
 * The reconciliation is the corrector for what the first two deliberately do not
 * see: ML-side drift, and a kit whose component moved without the kit selling.
 * It carries its OWN flag on top of the master one, so it can be turned off
 * alone if it costs more ML quota than the drift it heals is worth.
 *
 * Plain `onSchedule` exports — nothing enqueues against THEIR names, so no
 * rename-safety assertion is needed (the queue they feed is covered by the
 * `MERCADO_LIVRE_STOCK_SEND_QUEUE` assertion above). No-ops until
 * `MERCADO_LIVRE_STOCK_SYNC_ENABLED=1` (the coordinated cutover).
 */
export {
  sweepMercadoLivreStock,
  sweepMercadoLivreStockDaily,
  sweepMercadoLivreStockReconciliacao,
} from './sweepStock';

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
    // Cloud Tasks/Scheduler do not exist in us-east5 — see TASKS_SCHEDULER_REGION.
    region: TASKS_SCHEDULER_REGION,
    schedule: 'every 15 minutes',
    timeZone: 'America/Sao_Paulo',
    secrets: ['MERCADO_LIVRE_CLIENT_ID', 'MERCADO_LIVRE_CLIENT_SECRET'],
    // Worst case per tick is N contas × (MAX_PAGES_PER_TICK searches + up to
    // 500 sequential Cloud Tasks enqueues) — the 60s onSchedule default can't
    // absorb that; 540s matches the mass-import processor's budget.
    timeoutSeconds: 540,
  },
  async () => {
    const cacheMark = readCacheMark();
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
      // Per-tick, not cumulative — see `lib/cacheStats`.
      readCache: readCacheDelta(cacheMark),
    });
    if (errors.length > 0) {
      logger.warn('[mercado-livre] order-backfill sweep had per-conta failures', {
        errors: errors.slice(0, 10).map((c) => ({ integracaoId: c.integracaoId, error: c.error })),
      });
    }
  },
);

/**
 * Reprocess backstop, draining BOTH retry lanes on the same tick:
 *
 *  - the HOT lane — persisted `failed` notifications older than 1h (the queued
 *    task exhausted its retries, or a transient outage has since cleared);
 *  - the DEFERRED lane (#808) — notifications waiting on a seller to connect
 *    their Mercado Livre account, on a 24h window and a horizon of
 *    `MAX_TENTATIVAS_DEFERRED` days.
 *
 * Both run each doc inline, per-doc isolated, deduped by `resource`, bounded —
 * success deletes the doc, a persistent blocker parks it at its lane's cap.
 * Mirrors the legacy `manageNotificationsMercadoLivre` sweep.
 *
 * The deferred lane rides this 30-minute schedule rather than an `onSchedule` of
 * its own because its 24h WINDOW is already the per-doc cadence: 47 runs out of
 * 48 it is one indexed query that returns nothing. It is also much cheaper per
 * doc than the hot lane — a seller who still has not connected costs one
 * `integracao` lookup and NO ML API call — so it cannot threaten the timeout
 * below.
 *
 * Secrets: every topic runner routes through `loadMercadoLivreContext()`, which
 * calls `mercadoLivreOAuthConfig()` unconditionally, so — like
 * `processNotification.ts`/`importMercadoLivreOrders` above — this needs the ML
 * app credentials bound. Without them every doc throws `MercadoLivreConfigError`,
 * which the pipeline treats as transient and parks after `MAX_TENTATIVAS` (#778).
 */
export const reprocessMercadoLivreNotifications = onSchedule(
  {
    // Cloud Tasks/Scheduler do not exist in us-east5 — see TASKS_SCHEDULER_REGION.
    region: TASKS_SCHEDULER_REGION,
    schedule: 'every 30 minutes',
    timeZone: 'America/Sao_Paulo',
    secrets: ['MERCADO_LIVRE_CLIENT_ID', 'MERCADO_LIVRE_CLIENT_SECRET'],
    // Each doc's topic runner routes through loadMercadoLivreContext(), which calls
    // mercadoLivreOAuthConfig() unconditionally — up to 50 docs processed
    // sequentially can't fit the gen2 60s onSchedule default; 540s matches the
    // other ML-API-bound sweeps (importMercadoLivreOrders above).
    timeoutSeconds: 540,
  },
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

    // The deferred lane is logged separately, never merged into the counts
    // above: the two answer different operational questions ("is processing
    // healthy" vs "how many sellers still owe us a connect"), and summing them
    // would hide a growing deferred backlog inside a healthy `processed`.
    const deferred = await reprocessDeferredNotifications(getDb());
    logger.info('[mercado-livre] deferred lane sweep', {
      processed: deferred.processed,
      outcomes: deferred.outcomes,
      errorCount: deferred.errors.length,
    });
    if (deferred.errors.length > 0) {
      logger.warn('[mercado-livre] deferred lane sweep had per-doc failures', {
        errors: deferred.errors.slice(0, 10),
      });
    }
  },
);

/**
 * The `missed_feeds` backstop (#812) — the LAST-RESORT recovery for a
 * notification that was never successfully received. Everything above can only
 * re-drive events that reached us; this one asks Mercado Livre what it failed to
 * deliver and replays each entry through the same queue a real webhook feeds.
 *
 * Before it, a blown ack — a cold start past ML's ~500 ms window (this backend
 * runs `minInstances: 0`; see apphosting.yaml), a receiver 5xx, an enqueue
 * outage — lost the payment/shipment/item/claim event permanently and silently.
 *
 * ⚠️ **Daily at 05:00 America/Sao_Paulo, and the period is load-bearing.** ML
 * retains a missed feed for 2 days and the feed has NO time-filter parameter, so
 * the sweep keeps no cursor: coverage rests entirely on
 *
 *     SCHEDULE_PERIOD (24h) × 2 ≤ MISSED_FEEDS_RETENTION_HOURS (48h)
 *
 * Lengthening this cron past 24h silently deletes the backstop for anything
 * filed between runs. `index.test.ts` asserts the literal for exactly that
 * reason. 05:00 also sits clear of the 02:00 daily and 03:00 monthly stock
 * tiers; it needs no `isSlotDo…` skip against the 15-minute incremental sweep,
 * which shares no state doc, no queue and no cursor with it.
 *
 * **Flag-gated OFF**: until `MERCADO_LIVRE_MISSED_FEEDS_ENABLED=1` is set the
 * function deploys, ticks, logs one info line and reads nothing.
 *
 * Secrets: `MERCADO_LIVRE_CLIENT_ID` does DOUBLE duty here — the per-conta token
 * refresh via `mercadoLivreOAuthConfig()`, and the `app_id` query param the
 * endpoint requires.
 */
export const sweepMercadoLivreMissedFeeds = onSchedule(
  {
    // Cloud Tasks/Scheduler do not exist in us-east5 — see TASKS_SCHEDULER_REGION.
    region: TASKS_SCHEDULER_REGION,
    schedule: '0 5 * * *',
    timeZone: 'America/Sao_Paulo',
    secrets: ['MERCADO_LIVRE_CLIENT_ID', 'MERCADO_LIVRE_CLIENT_SECRET'],
    // Worst case per tick is N contas × (MAX_PAGES_PER_TICK reads + up to 1000
    // sequential Cloud Tasks enqueues) — the 60s onSchedule default can't
    // absorb that; 540s matches the other ML-API-bound sweeps.
    timeoutSeconds: 540,
  },
  async () => {
    const result = await runMissedFeedsSweep(getDb(), {
      scheduler: createMlTaskScheduler(),
      nowMs: Date.now(),
    });
    if (!result.enabled) {
      logger.info(
        `[mercado-livre] missed-feeds sweep disabled (${MISSED_FEEDS_FLAG_ENV} != '1') — no-op`,
      );
      return;
    }
    if (!result.configured) {
      logger.error(
        '[mercado-livre] missed-feeds sweep: MERCADO_LIVRE_CLIENT_ID ausente ou inválido — o backstop NÃO rodou',
      );
      return;
    }
    const errors = result.contas.filter((c) => c.error != null);
    logger.info('[mercado-livre] missed-feeds sweep', {
      contas: result.contas.length,
      found: result.contas.reduce((sum, c) => sum + c.found, 0),
      novos: result.contas.reduce((sum, c) => sum + c.novos, 0),
      enqueued: result.contas.reduce((sum, c) => sum + c.enqueued, 0),
      // Two counters, never summed: `skippedTopic` rising means a topic absent
      // from TOPIC_DISPOSITION appeared and needs classifying — act on it.
      // `skippedIgnorado` rising means the ignore list did its job — noise.
      skippedTopic: result.contas.reduce((sum, c) => sum + c.skippedTopic, 0),
      skippedIgnorado: result.contas.reduce((sum, c) => sum + c.skippedIgnorado, 0),
      skippedInvalid: result.contas.reduce((sum, c) => sum + c.skippedInvalid, 0),
      // #813's evidence: the topics ML still delivers that nothing here handles.
      topicosPulados: result.topicosPulados,
      // ML's record of what OUR endpoint answered. A wall of 5xx says the
      // receiver was failing; a wall of timeouts says the ack window was blown,
      // which is the cold-start hypothesis this issue opens with.
      httpCodes: result.httpCodes,
      // Diagnostic only (see MissedFeedsEscopo): whether ML's response looks
      // app-wide or per-seller. Reads 'app-wide' for a week ⇒ the follow-up to
      // collapse to a single call is safe.
      escopoAparente: result.escopoAparente,
      pages: result.contas.reduce((sum, c) => sum + c.pages, 0),
      truncated: result.contas.filter((c) => c.truncated).length,
      errorCount: errors.length,
    });
    if (errors.length > 0) {
      logger.warn('[mercado-livre] missed-feeds sweep had per-conta failures', {
        errors: errors.slice(0, 10).map((c) => ({ integracaoId: c.integracaoId, error: c.error })),
      });
    }
  },
);

/**
 * #1087 follow-up — the WEEKLY release of pedidos stuck awaiting a payment that
 * never resolved.
 *
 * Every other release path in this channel is event-driven, so a reservation
 * whose terminal `orders_v2`/`payments` event never arrived was held forever.
 * This is the only time-based one. It is mostly a RE-DRIVER: it asks ML what
 * happened and lets the existing import arms decide, releasing by itself only
 * when ML still reports the order pre-payment past the horizon.
 *
 * Monday 04:00 America/Sao_Paulo — clear of the 02:00 daily stock sweep, the
 * 03:00 monthly reconciliation and the 05:00 missed-feeds backstop.
 *
 * ⚠️ It ENDS SALES, so it ships doubly gated: `MERCADO_LIVRE_PEDIDO_TRAVADO_SWEEP_ENABLED`
 * must be `'1'` at all, and `MERCADO_LIVRE_PEDIDO_TRAVADO_DRY_RUN=1` decides and
 * counts without writing. Run the dry run for a few weeks and read the counters
 * before letting it write.
 */
export const sweepMercadoLivrePedidosTravados = onSchedule(
  {
    // Cloud Tasks/Scheduler do not exist in us-east5 — see TASKS_SCHEDULER_REGION.
    region: TASKS_SCHEDULER_REGION,
    schedule: '0 4 * * 1',
    timeZone: 'America/Sao_Paulo',
    secrets: ['MERCADO_LIVRE_CLIENT_ID', 'MERCADO_LIVRE_CLIENT_SECRET'],
    // One ML round trip per candidate, up to PAGE_LIMIT of them, sequentially —
    // the 60s onSchedule default cannot absorb that; 540s matches the other
    // ML-API-bound sweeps.
    timeoutSeconds: 540,
  },
  async () => {
    const result = await runPedidoTravadoSweep(getDb(), {
      scheduler: createMlTaskScheduler(),
      nowMs: Date.now(),
    });
    if (!result.enabled) {
      logger.info(
        `[mercado-livre] pedido-travado sweep disabled (${PEDIDO_TRAVADO_FLAG_ENV} != '1') — no-op`,
      );
      return;
    }
    logger.info('[mercado-livre] pedido-travado sweep', {
      dryRun: result.dryRun,
      examinados: result.examinados,
      // Per-verdict, never a single total: "examined 200, released 0" and
      // "examined 200, released 200" must not look alike in a log.
      veredictos: result.veredictos,
      truncado: result.truncado,
      errorCount: result.erros.length,
    });
    if (result.erros.length > 0) {
      logger.warn('[mercado-livre] pedido-travado sweep had per-pedido failures', {
        erros: result.erros.slice(0, 10),
      });
    }
  },
);
