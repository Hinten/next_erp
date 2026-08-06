import { type ScheduleOptions, onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';

import { STOCK_SYNC_FLAG_ENV } from '../../lib/marketplace/estoquePlan';
import {
  type StockSweepMode,
  isSlotDoDaily,
  runStockSweep,
} from '../../lib/marketplace/estoqueSweep';
import { createMlStockTaskScheduler } from '../../lib/marketplace/mlStockTasks';
import { getDb } from './lib/admin';

/**
 * The two ML stock-sync sweep schedules (Step 10 PR C) — thin `onSchedule`
 * wrappers over `runStockSweep` (lib/marketplace/estoqueSweep.ts), mirroring
 * the `importMercadoLivreOrders` wrapper in index.ts:
 *
 *  - `sweepMercadoLivreStock` — every 15 minutes, `'incremental'` mode: per
 *    conta, discovers the produto families whose estoques changed since the
 *    durable cursor (state doc `estoqueMercadoLivreSync/{integracaoId}`),
 *    applies the 30-day activity filter and enqueues one send task per ML API
 *    call onto the `sendMercadoLivreStock` queue. The ONE tick at the 02:00
 *    slot is skipped in code (`isSlotDoDaily` — a single cron line cannot
 *    exclude just one slot): that slot belongs to the daily pass below, while
 *    02:15/02:30/02:45 still run (owner call — stock changed at 02:05 must
 *    sync at 02:15, not 03:00; the cursor makes the one skipped slot
 *    self-healing regardless).
 *  - `sweepMercadoLivreStockDaily` — 02:00 America/Sao_Paulo, `'daily'` mode:
 *    the same discovery over a FLAT `dailyWindowHours()` (24h) lookback, with
 *    no activity filter and no pedidos probe — everything that MOVED in the
 *    last day. It owns its slot alone (the incremental skips 02:00), so the two
 *    never contend for one conta's caps and state doc.
 *    ⚠️ This is NOT a full reconciliation, whatever the code used to call it
 *    (#806 S11): a listing whose ERP stock has not moved in over 24h is never
 *    in its window, so ML-side drift — a manual edit on ML, a dropped PUT, a
 *    task lost past `maxPauseReenqueues` — is invisible to it. That is what
 *    the weekly pass below exists for.
 *  - `sweepMercadoLivreStockReconciliacao` — Sunday 03:00, `'reconciliacao'`
 *    mode: the force-all pass (`changedSinceMs: -1`) that re-sends the conta's
 *    whole linked catalogue and IGNORES skip-if-unchanged. Gated by its OWN
 *    flag on top of the master one, because it is the expensive pass: it
 *    enqueues one task per listing, bounded per tick by
 *    `maxTasksPerSweep()` + the `continuacao` machinery, so a large catalogue
 *    drains across several ticks rather than in one. It matters more now that
 *    #695 suppresses the incidental re-sends that used to heal drift as a side
 *    effect.
 *
 * **Flag-gated OFF**: until `MERCADO_LIVRE_STOCK_SYNC_ENABLED=1` is set (the
 * coordinated cutover — same window the legacy Flutter sender dies) both
 * functions deploy, tick, log one info line and do nothing.
 *
 * Secrets: the sweep resolves each conta's channel context (token refresh via
 * `mercadoLivreOAuthConfig()`), so it needs the ML app credentials bound —
 * same rationale as `importMercadoLivreOrders`.
 *
 * Timeout: worst case per tick is N contas × (bounded pipeline pages + up to
 * `maxTasksPerSweep()` sequential Cloud Tasks enqueues) — the 60s onSchedule
 * default can't absorb that; 540s matches `importMercadoLivreOrders`.
 */

/** Shared onSchedule options minus the schedule itself (see the module doc). */
function sweepScheduleOptions(schedule: string): ScheduleOptions {
  return {
    schedule,
    timeZone: 'America/Sao_Paulo',
    secrets: ['MERCADO_LIVRE_CLIENT_ID', 'MERCADO_LIVRE_CLIENT_SECRET'],
    timeoutSeconds: 540,
  };
}

/** Run one sweep tick and log its summary (the importMercadoLivreOrders discipline). */
async function runAndLog(mode: StockSweepMode): Promise<void> {
  const result = await runStockSweep(getDb(), mode, {
    scheduler: createMlStockTaskScheduler(),
    nowMs: Date.now(),
  });
  if (!result.enabled) {
    logger.info(
      `[mercado-livre] stock sweep (${mode}) disabled (${STOCK_SYNC_FLAG_ENV} != '1') — no-op`,
    );
    return;
  }
  const errors = result.contas.filter((c) => c.error != null);
  logger.info(`[mercado-livre] stock sweep (${mode})`, {
    enabled: result.enabled,
    contas: result.contas.length,
    enqueued: result.contas.reduce((sum, c) => sum + c.enqueued, 0),
    skipped: result.contas.reduce((sum, c) => sum + c.skipped, 0),
    // #695's measurable win: sends avoided because ML already held the number.
    // A SUBSET of `skipped` — read it against `enqueued` to see how much of the
    // queue used to be no-ops. Always 0 on the daily pass, which force-sends.
    inalterados: result.contas.reduce((sum, c) => sum + c.inalterados, 0),
    pages: result.contas.reduce((sum, c) => sum + c.pages, 0),
    truncated: result.contas.filter((c) => c.truncated).length,
    // Contas skipped by the 429 pause gate — a standing count here means the
    // send queue is being throttled by ML, not that the sweep is idle.
    paused: result.contas.filter((c) => c.paused).length,
    errorCount: errors.length,
  });
  if (errors.length > 0) {
    logger.warn(`[mercado-livre] stock sweep (${mode}) had per-conta failures`, {
      errors: errors.slice(0, 10).map((c) => ({ integracaoId: c.integracaoId, error: c.error })),
    });
  }
}

/**
 * The 15-minute incremental stock sweep (flag-gated — module doc). Skips only
 * the 02:00 slot — it belongs to the daily pass; 02:15/30/45 run normally.
 */
export const sweepMercadoLivreStock = onSchedule(
  sweepScheduleOptions('every 15 minutes'),
  async () => {
    if (isSlotDoDaily(Date.now())) {
      logger.info(
        '[mercado-livre] stock sweep (incremental) — 02:00 America/Sao_Paulo slot belongs to the daily sweep, skipping this tick',
      );
      return;
    }
    await runAndLog('incremental');
  },
);

/**
 * The 02:00 daily stock sweep (flag-gated — module doc). Owns its slot: the
 * incremental wrapper above skips exactly this tick. A flat 24h window, NOT a
 * reconciliation (#806 S11) — see `sweepMercadoLivreStockReconciliacao`.
 */
export const sweepMercadoLivreStockDaily = onSchedule(
  sweepScheduleOptions('0 2 * * *'),
  async () => {
    await runAndLog('daily');
  },
);

/**
 * The env flag gating the weekly force-all reconciliation, ON TOP of the master
 * `MERCADO_LIVRE_STOCK_SYNC_ENABLED`. Two gates because this pass re-sends the
 * ENTIRE linked catalogue: it must be possible to run the normal sweeps for a
 * while before turning it on, and to turn it off alone if it costs more ML
 * quota than the drift it heals is worth. Read LAZILY, `'1'` and nothing else.
 */
export const STOCK_RECONCILIACAO_FLAG_ENV = 'MERCADO_LIVRE_STOCK_RECONCILIACAO_ENABLED';

/**
 * The weekly force-all reconciliation (Sunday 03:00 America/Sao_Paulo — clear
 * of the 02:00 daily slot, so the two never contend for a conta's caps or its
 * state doc). This is the pass that actually reconciles: `changedSinceMs = -1`
 * admits every anchor, and it force-sends, so a quantity that drifted on ML's
 * side with no ERP movement behind it is finally corrected.
 */
export const sweepMercadoLivreStockReconciliacao = onSchedule(
  sweepScheduleOptions('0 3 * * 0'),
  async () => {
    if (process.env[STOCK_RECONCILIACAO_FLAG_ENV] !== '1') {
      logger.info(
        `[mercado-livre] stock reconciliation disabled (${STOCK_RECONCILIACAO_FLAG_ENV} != '1') — no-op`,
      );
      return;
    }
    await runAndLog('reconciliacao');
  },
);
