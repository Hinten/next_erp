// Import side-effect first: registers global function options (region) before
// any trigger is defined. See options.ts.
//
// ⚠️ This bare import is load-bearing precisely because it has NO binding —
// there is nothing here to look unused, so `no-unused-vars` can never point
// anyone at deleting it. Keep it that way, and keep it FIRST: ESM evaluates
// modules in the order their import declarations appear, so a second
// `from './options'` further down would satisfy `import/no-duplicates` by
// merging INTO that one, moving the option registration after the trigger
// modules. That un-registers the global options for every trigger in this file,
// and it is invisible: the functions deploy fine, to the wrong region (#1108).
import './options';

import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { readCacheDelta, readCacheMark } from '@delfrance/data/admin/cache';
import { createShopeePartnerClient } from '@delfrance/integrations-shopee';

import { runShopeeAuthorizationExpirySweep } from '../../lib/shopee/conta/expiracaoSweep';
import { shopeeConfig } from '../../lib/shopee/env';
import {
  SHOPEE_NOTIFICATION_QUEUE,
  reprocessDeferredNotifications,
  reprocessNotifications,
} from '../../lib/shopee/notificacoes/notificacao';
import { getDb } from './lib/admin';
import * as notificationHandlers from './processNotification';

/**
 * Shopee Cloud Functions (gen2), codebase `shopee`. Deployed as a
 * deploy-artifact sub-build of `@delfrance/shopee-app` (see
 * scripts/prepare-deploy.mjs and `firebase.shopee.deploy.json`, which ships
 * INERT — the rollout is step 22's, #1530, and running it is a manual
 * coordinated human step).
 *
 * Master plan step 3 (#1511) wires the resilient notification pipeline as a
 * **Cloud Tasks queue** (`processShopeeNotification`, ./processNotification) +
 * an `onSchedule` reprocess sweep, and adds the weekly authorization-expiry
 * sweep that posts to the operator avisos inbox. Mirrors
 * apps/mercado-pago/functions, with the deferred lane from
 * apps/mercado-livre/functions.
 */

/**
 * The Shopee partner credentials, bound to every trigger that can reach a
 * PUBLIC-signed Shopee call.
 *
 * ⚠️ It covers the two `onSchedule` triggers in THIS file only.
 * `processShopeeNotification` is declared in `processNotification.ts` and holds
 * its own copy of the same two names, pinned by that module's own test — so
 * this constant does not by itself stop a third trigger picking a different
 * subset; the exact-set assertions in the two test files do.
 *
 * ⚠️ Without these the sweep and the conta arms of the queue handler throw
 * `ShopeeConfigError` on their first call, which the pipeline treats as
 * transient — so the symptom is retries and parked documents, not a startup
 * failure that names the missing binding.
 */
const SHOPEE_SECRETS = ['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY'];

// Rename-safety: the DEPLOYED function name is the export KEY of the handler
// below, and the receiver enqueues against `SHOPEE_NOTIFICATION_QUEUE`. ESM
// export names must be static literals (you can't compute an `export const`
// name), so instead of deriving one from the other we assert — at module load,
// i.e. during Firebase's deploy codebase-analysis — that they never drifted. A
// rename that updates only one side fails the deploy loudly here instead of
// silently enqueuing onto a queue that doesn't exist.
if (!(SHOPEE_NOTIFICATION_QUEUE in notificationHandlers)) {
  throw new Error(
    '[shopee] function-name drift: functions/src/processNotification.ts must export a ' +
      `handler named '${SHOPEE_NOTIFICATION_QUEUE}' (the enqueue target). ` +
      'Rename the export and the SHOPEE_NOTIFICATION_QUEUE constant together.',
  );
}

/** The queue-based notification processor (rate-limited, retry-with-backoff). */
export { processShopeeNotification } from './processNotification';

/**
 * Reprocess backstop, draining BOTH retry lanes on the same tick:
 *
 *  - the HOT lane — persisted `failed` pushes older than 1h (the queued task
 *    exhausted its retries, or the receiver could not enqueue at all because
 *    `SHOPEE_TASKS_DISABLED` was on or the queue was unreachable);
 *  - the DEFERRED lane — a push whose `shop_id` matches no ACTIVE Shopee
 *    integração, waiting on an operator to connect that shop, on a 24h window
 *    and a horizon of `MAX_TENTATIVAS_DEFERRED` days.
 *
 * Both run each doc inline, per-doc isolated, deduped, bounded — success deletes
 * the doc, a persistent blocker parks it at its lane's cap.
 *
 * The deferred lane rides this 30-minute schedule rather than an `onSchedule` of
 * its own because its 24h WINDOW is already the per-doc cadence: 47 runs out of
 * 48 it is one indexed query that returns nothing.
 *
 * Secrets: the conta arms sign a PUBLIC Shopee call, so a re-drive needs the
 * partner credentials bound exactly as the queue handler does.
 */
export const reprocessShopeeNotifications = onSchedule(
  {
    schedule: 'every 30 minutes',
    timeZone: 'America/Sao_Paulo',
    secrets: SHOPEE_SECRETS,
    // Up to a bounded page of docs processed SEQUENTIALLY, each of which may
    // make a Shopee round trip — the gen2 60s onSchedule default cannot absorb
    // that. 540s matches the sweep below.
    timeoutSeconds: 540,
  },
  async () => {
    const hotMark = readCacheMark();
    const result = await reprocessNotifications(getDb());
    logger.info('[shopee] reprocess sweep', {
      processed: result.processed,
      outcomes: result.outcomes,
      errorCount: result.errors.length,
      // Read-cache hits/misses accrued by THIS lane. Reports the SWEEP process's
      // caches, not the task consumer's — they are separate deployments.
      readCache: readCacheDelta(hotMark),
    });
    if (result.errors.length > 0) {
      logger.warn('[shopee] reprocess sweep had per-doc failures', {
        errors: result.errors.slice(0, 10),
      });
    }

    // The deferred lane is logged SEPARATELY, never merged into the counts
    // above: the two answer different operational questions ("is processing
    // healthy" vs "how many shops still owe us a connect"), and summing them
    // would hide a growing deferred backlog inside a healthy `processed`.
    const deferredMark = readCacheMark();
    const deferred = await reprocessDeferredNotifications(getDb());
    logger.info('[shopee] deferred lane sweep', {
      processed: deferred.processed,
      outcomes: deferred.outcomes,
      errorCount: deferred.errors.length,
      readCache: readCacheDelta(deferredMark),
    });
    if (deferred.errors.length > 0) {
      logger.warn('[shopee] deferred lane sweep had per-doc failures', {
        errors: deferred.errors.slice(0, 10),
      });
    }
  },
);

/**
 * The WEEKLY authorization-expiry sweep (master plan P8).
 *
 * A Shopee consent lasts 7–365 days and nothing renews it: when it lapses every
 * order import, stock push and label stops at once, and the legacy Flutter app
 * never read that clock at all — the first signal was the day everything went
 * quiet. This walks the partner's authorized shops (`get_shops_by_partner`,
 * PUBLIC-signed, so no token is read anywhere in it) and raises an operator
 * aviso at 30 days or less, resolving it once a re-consent pushes the clock
 * back out.
 *
 * Monday 04:00 America/Sao_Paulo: a weekly cadence is enough for a 30-day
 * horizon, and the aviso does not nag — a repeat bumps `ocorrencias` and
 * refreshes the day count without moving `criadoEm`.
 *
 * Shopee's `push 12` describes the same expiry from the other side and runs the
 * SAME producer scoped to the shops it names, so the two collapse onto one aviso
 * row rather than racing to create two.
 */
export const sweepShopeeAuthorizationExpiry = onSchedule(
  {
    schedule: '0 4 * * 1',
    timeZone: 'America/Sao_Paulo',
    secrets: SHOPEE_SECRETS,
    // One enumeration page per 100 shops plus a Firestore round trip per shop,
    // sequentially — the gen2 60s onSchedule default cannot absorb that.
    timeoutSeconds: 540,
  },
  async () => {
    const mark = readCacheMark();
    const result = await runShopeeAuthorizationExpirySweep(getDb(), {
      partnerClient: createShopeePartnerClient(shopeeConfig()),
      // Injected because `packages/data/src/admin/**` may only `import type`
      // from firebase-admin — the aviso counter is a tier-0 FieldValue, so two
      // producers landing together cannot lose each other's bump.
      increment: (by: number) => FieldValue.increment(by),
      nowMs: Date.now(),
      logger,
    });
    logger.info('[shopee] authorization expiry sweep', {
      lojasEnumeradas: result.lojasEnumeradas,
      paginasLidas: result.paginasLidas,
      // A truncated walk means `lojasEnumeradas` is a PREFIX — the shops past
      // the page cap were not examined at all.
      truncado: result.truncado,
      // ⚠️ Never sum `semIntegracao` with `avisados`: it counts shops the sweep
      // deliberately did NOT act on, and adding the two would read as coverage.
      semIntegracao: result.semIntegracao,
      avisados: result.avisados,
      resolvidos: result.resolvidos,
      // The per-verdict breakdown behind `avisados`: "30 shops, 30 criado" and
      // "30 shops, 30 repetido" must not look alike in a log.
      resultados: result.resultados,
      errorCount: result.erros.length,
      readCache: readCacheDelta(mark),
    });
    if (result.erros.length > 0) {
      logger.warn('[shopee] authorization expiry sweep had per-shop failures', {
        erros: result.erros.slice(0, 10),
      });
    }
  },
);
