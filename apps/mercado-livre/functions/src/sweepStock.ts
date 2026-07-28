import { type ScheduleOptions, onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';

import { STOCK_SYNC_FLAG_ENV } from '../../lib/marketplace/estoquePlan';
import { runStockSweep } from '../../lib/marketplace/estoqueSweep';
import { createMlStockTaskScheduler } from '../../lib/marketplace/mlStockTasks';
import { getDb } from './lib/admin';

/**
 * The two ML stock-sync sweep schedules (Step 10 PR C) — thin `onSchedule`
 * wrappers over `runStockSweep` (lib/marketplace/estoqueSweep.ts), mirroring
 * the `importMercadoLivreOrders` wrapper in index.ts:
 *
 *  - `sweepMercadoLivreStock` — every 15 minutes EXCEPT the 02:00–02:59 hour
 *    (`0,15,30,45 0-1,3-23 * * *`, America/Sao_Paulo), `'incremental'` mode: per
 *    conta, discovers the produto families whose estoques changed since the
 *    durable cursor (state doc `estoqueMercadoLivreSync/{integracaoId}`),
 *    applies the 30-day activity filter and enqueues one send task per ML API
 *    call onto the `sendMercadoLivreStock` queue. The skipped hour is harmless:
 *    the window derives from the cursor, so the 03:00 tick re-covers it — and
 *    the daily pass owns that hour anyway.
 *  - `sweepMercadoLivreStockDaily` — 02:00 America/Sao_Paulo, `'daily'` mode:
 *    the same discovery over a FLAT `dailyWindowHours()` (24h) lookback — NOT
 *    a force-all `changedSinceMs: -1` scan — with no activity filter and no
 *    pedidos probe: the full-reconciliation pass over everything that moved in
 *    the last day. It runs alone in its hour (the incremental cron excludes
 *    hour 2), so the two never contend for one conta's caps and state doc.
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
async function runAndLog(mode: 'incremental' | 'daily'): Promise<void> {
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
 * The 15-minute incremental stock sweep (flag-gated — module doc). The cron
 * excludes the 02:00–02:59 hour — that hour belongs to the daily pass.
 */
export const sweepMercadoLivreStock = onSchedule(
  sweepScheduleOptions('0,15,30,45 0-1,3-23 * * *'),
  async () => {
    await runAndLog('incremental');
  },
);

/**
 * The 02:00 daily full stock sweep (flag-gated — module doc). Runs alone in
 * its hour: the incremental cron above skips hour 2 entirely.
 */
export const sweepMercadoLivreStockDaily = onSchedule(
  sweepScheduleOptions('0 2 * * *'),
  async () => {
    await runAndLog('daily');
  },
);
