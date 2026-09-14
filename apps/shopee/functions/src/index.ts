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
import { runShopeeEscrowSettlement } from '../../lib/shopee/pedidos/liquidacaoSweep';
import { runShopeeLostPushSweep } from '../../lib/shopee/notificacoes/lostPushSweep';
import {
  SHOPEE_NOTIFICATION_QUEUE,
  reprocessDeferredNotifications,
  reprocessNotifications,
} from '../../lib/shopee/notificacoes/notificacao';
import {
  SHOPEE_ORDER_BACKFILL_FLAG_ENV,
  runShopeeOrderBackfill,
} from '../../lib/shopee/notificacoes/orderBackfill';
import { runShopeePushConfigMonitor } from '../../lib/shopee/notificacoes/pushConfigMonitor';
import { createShopeeTaskScheduler } from '../../lib/shopee/shopeeTasks';
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
 *
 * Master plan step 4 (#1512) adds the three DELIVERY BACKSTOPS — the lost-push
 * sweep, the daily push-health monitor and the flag-gated order backfill. They
 * are what decision P3 spends the receiver's cold-start cost on: everything
 * Shopee's own retry ladder fails to deliver is recovered by a schedule here,
 * never by the receiver.
 *
 * Master plan step 6 (#1514) adds the WEEKLY settlement sweep. ⚠️ It is not a
 * backstop: nothing failed to arrive, because Shopee never sends a payment event
 * at all — the final money exists only behind `get_escrow_list`, and a schedule
 * is the only thing that can go and read it.
 */

/**
 * The Shopee partner credentials, bound to every trigger that can reach a
 * PUBLIC-signed Shopee call.
 *
 * ⚠️ It covers the six `onSchedule` triggers in THIS file only.
 * `processShopeeNotification` is declared in `processNotification.ts` and holds
 * its own copy of the same two names, pinned by that module's own test — so
 * this constant does not by itself stop a NEW trigger picking a different
 * subset; the exact-set assertions in the two test files do. `index.test.ts`'s
 * `AGENDAMENTOS` map plus its exhaustiveness test is what keeps the count from
 * silently going stale again: a new schedule that is not in the map fails.
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

/**
 * The LOST-PUSH sweep (master plan step 4, #1512) — the backstop decision P3
 * spends the receiver's cold-start cost on.
 *
 * A push that exhausts Shopee's own ladder (+5 min / +30 min / +3 h) lands in a
 * partner-level queue holding "the earliest 100 lost within 3 days and not
 * confirmed". Paging is cursor-by-ACKNOWLEDGEMENT: the only way to advance is
 * to confirm, so ONE entry we never make durable blocks every later one until
 * it expires. That is the ordering rule the sweep body is built around — every
 * entry enqueued, persisted `failed` or parked FIRST, then one confirm per
 * page, and never a confirm on an empty page.
 *
 * Every 2 h at :20 — 36 ticks inside the 3-day window, so losing 30 consecutive
 * ticks still leaves 12 h of margin (the invariant `index.test.ts` derives from
 * the cron literal). The :20 keeps it clear of the 30-minute reprocess sweep's
 * :00/:30 and of the Monday 04:00 walk, all of which draw on one undocumented
 * rate-limit budget — `rate_limit` is published EMPTY on both push pages.
 *
 * Secrets: both provider calls are PUBLIC-signed, so they still work when every
 * conta's access token is dead — which is exactly when they matter — but they
 * are signed with the partner key all the same.
 *
 * ⚠️ This function ENQUEUES. Its runtime service account therefore needs
 * `roles/cloudtasks.enqueuer` plus `roles/run.invoker` on
 * `processShopeeNotification`, and `TASKS_INVOKER_SA` is AUTHORITATIVE — a
 * deploy REPLACES the members of both bindings, so an identity left out of that
 * list LOSES the role. See functions/DEPLOY.md; granting it is step 22's.
 */
export const sweepShopeeLostPushes = onSchedule(
  {
    schedule: '20 */2 * * *',
    timeZone: 'America/Sao_Paulo',
    secrets: SHOPEE_SECRETS,
    // Up to 5 pages × 100 sequential enqueues plus two provider round trips per
    // page — the gen2 60s onSchedule default cannot absorb that.
    timeoutSeconds: 540,
  },
  async () => {
    const mark = readCacheMark();
    // ⚠️ `getDb()` is evaluated FIRST (arguments left to right), so the admin
    // app exists before the scheduler asks for one; both resolve `getApps()[0]`.
    const result = await runShopeeLostPushSweep(getDb(), {
      partnerClient: createShopeePartnerClient(shopeeConfig()),
      // No `region:` anywhere in this file — `options.ts` sets it globally, and
      // it already defaults `SHOPEE_TASKS_REGION` to the inlined
      // `FUNCTIONS_REGION` for exactly this case, "a sweep re-driving a push
      // through the queue". Do not copy `apps/mercado-livre`'s explicit region:
      // its functions and its backend live in different regions, Shopee's do
      // not, and `no-hardcoded-gcp-region` is the backstop either way.
      scheduler: createShopeeTaskScheduler(),
      nowMs: Date.now(),
      logger,
    });
    logger.info('[shopee] lost push sweep', {
      paginas: result.paginas,
      encontradas: result.encontradas,
      enfileiradas: result.enfileiradas,
      persistidas: result.persistidas,
      // Unreadable entries confirmed PAST — never summed with `enfileiradas`:
      // one is recovery, the other is a terminal row an operator must look at.
      paradas: result.paradas,
      duplicadas: result.duplicadas,
      // PAGES, not entries — the ack is per page. `confirmadas < paginas` means
      // a page was left for the next tick, which is the safe direction and the
      // whole design.
      confirmadas: result.confirmadas,
      truncado: result.truncado,
      maisAntigaMs: result.maisAntigaMs,
      // The `"error": "-"` doc contradiction (D1), settled by live traffic:
      // this is the GETTER envelope's `error` VERBATIM — the confirm's would be
      // absent on exactly the rehearsal tick
      // (`SHOPEE_LOST_PUSH_CONFIRM_DISABLED`) this field exists for. Delete the
      // field once a week of ticks has read the same value.
      envelopeError: result.envelopeError,
      errorCount: result.erros.length,
      // Read-cache hits/misses accrued by THIS lane, not by the task consumer's
      // process — they are separate deployments.
      readCache: readCacheDelta(mark),
    });
    if (result.erros.length > 0) {
      logger.warn('[shopee] lost push sweep had page failures', {
        erros: result.erros.slice(0, 10),
      });
    }
  },
);

/**
 * The DAILY push-health monitor (master plan step 4, #1512).
 *
 * `get_app_push_config.live_push_status` is the only API surface on Shopee's
 * warning/auto-disable ladder (>600 pushes / 6 h AND <70 % success ⇒ Warning;
 * AND <30 % ⇒ the subscription is DISABLED). There is no API for the success
 * rate itself — the Console is the only place it exists — and a suspension
 * loses everything not already in the 3-day lost-push queue, which is why the
 * sweep above does NOT cover it and why the suspended aviso is `critico`.
 *
 * Daily at 05:45: one Public GET and one reading, on a minute nothing else in
 * this codebase shares, fresh when the operator's day starts. ⚠️ The reading is
 * meaningless until the production callback URL points at the deployed receiver
 * — a human step (#1534 / #1208).
 *
 * ⚠️ It never calls `set_app_push_config`, and the package exposes no such
 * operation: that absence is the enforcement. The config is app-wide with a
 * single `callback_url`, setting it fires a live test push, and its partial-body
 * semantics are undocumented — a read-modify-write would drop every code above
 * 13, which is most of them.
 */
export const monitorShopeePushConfig = onSchedule(
  {
    schedule: '45 5 * * *',
    timeZone: 'America/Sao_Paulo',
    secrets: SHOPEE_SECRETS,
    // ⚠️ Deliberately NOT 540. One provider GET plus at most three aviso round
    // trips; 540 would claim this might legitimately take nine minutes and
    // would hide a hang for that long — `shopeeCall` carries no timeout of its
    // own.
    timeoutSeconds: 120,
  },
  async () => {
    const mark = readCacheMark();
    const result = await runShopeePushConfigMonitor(getDb(), {
      partnerClient: createShopeePartnerClient(shopeeConfig()),
      // Injected because `packages/data/src/admin/**` may only `import type`
      // from firebase-admin — the aviso counter is a tier-0 FieldValue, so two
      // producers landing together cannot lose each other's bump.
      increment: (by: number) => FieldValue.increment(by),
      nowMs: Date.now(),
      logger,
    });
    logger.info('[shopee] push config monitor', {
      status: result.status,
      // Shopee's string VERBATIM — the only record of a value we do not know,
      // and what settles the documented `Suspended` against the page's own
      // lowercase `suspended` sample.
      statusBruto: result.statusBruto,
      avisados: result.avisados,
      // Rows actually CLOSED — a transition, never "we asked about two rows".
      resolvidos: result.resolvidos,
      resultados: result.resultados,
      callbackDivergente: result.callbackDivergente,
      codigosDesligados: result.codigosDesligados,
      lojasBloqueadas: result.lojasBloqueadas,
      readCache: readCacheDelta(mark),
    });
    // The three log-only findings: no aviso tipo exists for any of them, so a
    // warn is the whole signal. They are raised together because each one alone
    // is a configuration answer to "why did a push never arrive".
    if (
      result.callbackDivergente ||
      result.codigosDesligados.length > 0 ||
      result.lojasBloqueadas > 0
    ) {
      logger.warn('[shopee] push config divergences', {
        callbackDivergente: result.callbackDivergente,
        codigosDesligados: result.codigosDesligados,
        lojasBloqueadas: result.lojasBloqueadas,
      });
    }
  },
);

/**
 * The ORDER BACKFILL (master plan step 4, #1512) — the 15-minute safety net
 * behind the push receiver, and the ONLY documented recovery from a suspended
 * subscription: "you will not receive Push Mechanism notifications missed
 * during the period where your subscription was disabled", which the lost-push
 * queue does not cover either.
 *
 * Per active conta it pages `get_order_list` on `update_time` from a durable
 * per-conta cursor with overlap, and enqueues one SYNTHETIC code-3 notification
 * per `order_sn` — the same import path a real push takes, so the step-5 arms
 * stay the single writer. It is also the only way to reach `PENDING`,
 * `RETRY_SHIP`, `TO_CONFIRM_RECEIVE` and `TO_RETURN` orders, which Shopee's
 * `order_status` filter cannot list (hence: no status filter, ever).
 *
 * ⚠️ SINGLY GATED since step 5. `SHOPEE_ORDER_BACKFILL_ENABLED === '1'` ships
 * OFF and is now the ONLY gate: the structural guard (the sweep refuses while
 * `destinoDoCodigo(3) === 'parado'`) flipped itself the moment `DISPATCH[3]`
 * became `'pedido'`, exactly as designed. Turning the flag on is a runtime env
 * change for the migration window — the first enabled tick enqueues one task
 * per order in the cursor window, and each one writes a pedido.
 *
 * ⚠️ This function ENQUEUES and it is Shop-signed: the same `TASKS_INVOKER_SA`
 * requirement as the lost-push sweep above, plus a live access token per conta.
 */
export const backfillShopeeOrders = onSchedule(
  {
    schedule: 'every 15 minutes',
    timeZone: 'America/Sao_Paulo',
    secrets: SHOPEE_SECRETS,
    // Up to 20 pages per conta, sequentially, each followed by one enqueue per
    // order — the gen2 60s onSchedule default cannot absorb that.
    timeoutSeconds: 540,
  },
  async () => {
    const mark = readCacheMark();
    const result = await runShopeeOrderBackfill(getDb(), {
      scheduler: createShopeeTaskScheduler(),
      nowMs: Date.now(),
      logger,
    });
    if (!result.enabled) {
      // ONE info line, naming the variable, so "why is nothing importing" is
      // answerable from the log without reading the source. Nothing was read on
      // this tick: not Firestore, not Shopee.
      logger.info('[shopee] order backfill inativo — nada lido', {
        motivo: result.motivo,
        flag: SHOPEE_ORDER_BACKFILL_FLAG_ENV,
      });
      return;
    }
    const erros = result.contas
      .filter((conta) => conta.error !== null)
      .map((conta) => ({ integracaoId: conta.integracaoId, erro: conta.error }));
    logger.info('[shopee] order backfill', {
      contas: result.contas.length,
      // ⚠️ Never summed with `processadas`: it counts contas connected by main
      // account only, which cannot be shop-signed at all, and adding the two
      // would read as coverage.
      semShopId: result.semShopId,
      processadas: result.contas.filter((conta) => conta.pulada === null).length,
      paginasLidas: result.contas.reduce((total, conta) => total + conta.paginas, 0),
      pedidosEncontrados: result.contas.reduce((total, conta) => total + conta.ordersFound, 0),
      enfileirados: result.contas.reduce((total, conta) => total + conta.enqueued, 0),
      duplicadosNoTick: result.contas.reduce((total, conta) => total + conta.duplicadas, 0),
      janelasDrenadas: result.contas.filter((conta) => conta.drenada).length,
      // A truncated window advances NOTHING and persists a pending triple — the
      // next tick replays it. A count that stays high tick after tick is a
      // conta that can no longer keep up, and that is invisible in every other
      // counter here.
      janelasTruncadas: result.contas.filter((conta) => conta.truncada).length,
      janelasRetomadas: result.contas.filter((conta) => conta.retomada).length,
      errorCount: erros.length,
      readCache: readCacheDelta(mark),
    });
    if (erros.length > 0) {
      logger.warn('[shopee] order backfill com falhas por conta', {
        erros: erros.slice(0, 10),
      });
    }
  },
);

/**
 * The WEEKLY SETTLEMENT SWEEP (master plan step 6, #1514) — the only thing in
 * this channel that ever learns what the marketplace actually PAID.
 *
 * Shopee ships no payment push and no payment resource of its own: the order
 * import writes a pagamento from `get_order_detail` + `get_escrow_detail` on the
 * code-3 task, but `escrow_amount` is documented to MOVE until the order
 * completes, and `escrow_release_time` — the field that says the money really
 * left — is exposed by exactly ONE endpoint, `get_escrow_list`. So the final
 * figure cannot arrive by event; it has to be fetched, and this is the schedule
 * that fetches it.
 *
 * Per active conta it pages that listing over a release-time window from a
 * durable cursor (`liquidacaoShopee/{integracaoId}`, MILLISECONDS, this sweep
 * its only writer, one merge per conta per tick, no transaction), reads the
 * fresh escrow of every row whose pagamento exists and stamps the top-level
 * `pagamento.liquidacao`. A row whose pagamento is not here yet is PARKED and
 * re-driven through the normal import path with a synthetic code 3, capped at
 * 50 per tick.
 *
 * Mondays 05:10 America/Sao_Paulo. Weekly because an escrow release is weekly
 * business — it lags delivery by 7–15 days — and the minute keeps it clear of
 * every sibling schedule's :00/:15/:20/:30/:45, between the 04:00 expiry walk
 * and the 05:45 push monitor, all of which draw on one undocumented partner
 * rate-limit budget. A daily cadence would be `'10 5 * * *'`, one character
 * away, which is why `index.test.ts` pins the near-miss explicitly.
 *
 * ⚠️ It ships **ON, with no `*_ENABLED` flag** — deliberately, and unlike the
 * order backfill. A backstop that ships off is #778's failure; the fan-out here
 * is bounded on every axis (300 settlements and 50 synthetic pushes per tick),
 * and the only pedido-CREATING side effect is that synthetic code 3, which lands
 * on a deterministic id a migrated pedido already occupies.
 *
 * ⚠️ This function ENQUEUES and it is Shop-signed: the same `TASKS_INVOKER_SA`
 * requirement as the lost-push sweep and the backfill, plus a live access token
 * per conta.
 */
export const sweepShopeeEscrowSettlement = onSchedule(
  {
    schedule: '10 5 * * 1',
    timeZone: 'America/Sao_Paulo',
    secrets: SHOPEE_SECRETS,
    // Up to MAX_LIQUIDACOES_POR_TICK (300) `get_escrow_detail` calls, each
    // followed by one transaction, plus up to 20 list pages per conta. 540 is
    // the gen2 ceiling and the per-tick budget is sized against it (≈ 370 s), so
    // the ceiling is margin rather than a claim that nine minutes is normal.
    timeoutSeconds: 540,
    // No `region:` anywhere in this file — `options.ts` sets it globally.
  },
  async () => {
    const mark = readCacheMark();
    // ⚠️ `getDb()` is evaluated FIRST (arguments left to right), so the admin app
    // exists before the scheduler asks for one; both resolve `getApps()[0]`.
    const result = await runShopeeEscrowSettlement(getDb(), {
      nowMs: Date.now(),
      scheduler: createShopeeTaskScheduler(),
      logger,
    });
    const erros = result.contas
      .filter((conta) => conta.error !== null)
      .map((conta) => ({ integracaoId: conta.integracaoId, erro: conta.error }));
    logger.info('[shopee] escrow settlement sweep', {
      contas: result.contas.length,
      // ⚠️ Never summed with `processadas`: it counts contas connected by main
      // account only, which cannot be shop-signed at all, and adding the two
      // would read as coverage.
      semShopId: result.semShopId,
      processadas: result.contas.filter((conta) => conta.pulada === null).length,
      paginasLidas: result.contas.reduce((total, conta) => total + conta.paginas, 0),
      linhas: result.contas.reduce((total, conta) => total + conta.linhas, 0),
      liquidados: result.contas.reduce((total, conta) => total + conta.liquidados, 0),
      // The idempotent steady state: a re-covered overlap row writes NOTHING, so
      // a high `semMudanca` beside a low `liquidados` is the healthy week.
      semMudanca: result.contas.reduce((total, conta) => total + conta.semMudanca, 0),
      obsoletos: result.contas.reduce((total, conta) => total + conta.obsoletos, 0),
      pendentes: result.contas.reduce((total, conta) => total + conta.pendentes, 0),
      sinteticas: result.contas.reduce((total, conta) => total + conta.sinteticas, 0),
      puladas: result.contas.reduce((total, conta) => total + conta.puladas, 0),
      janelasDrenadas: result.contas.filter((conta) => conta.drenada).length,
      // A truncated window advances NOTHING and persists its page number — the
      // next tick replays it. A count that stays high week after week is a conta
      // that can no longer keep up, and that is invisible in every other counter
      // here.
      janelasTruncadas: result.contas.filter((conta) => conta.truncada).length,
      janelasRetomadas: result.contas.filter((conta) => conta.retomada).length,
      errorCount: erros.length,
      // Read-cache hits/misses accrued by THIS lane, not by the task consumer's
      // process — they are separate deployments.
      readCache: readCacheDelta(mark),
    });
    if (erros.length > 0) {
      logger.warn('[shopee] escrow settlement sweep com falhas por conta', {
        erros: erros.slice(0, 10),
      });
    }
  },
);
