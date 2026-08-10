import { type ScheduleOptions, onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';

import { STOCK_SYNC_FLAG_ENV } from '../../lib/marketplace/estoquePlan';
import {
  type StockSweepMode,
  isSlotDaReconciliacao,
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
 *    the same discovery over a FLAT `dailyWindowHours()` (24h) lookback — NOT
 *    a force-all `changedSinceMs: -1` scan — with no activity filter and no
 *    pedidos probe: the full-reconciliation pass over everything that moved in
 *    the last day. It owns its slot alone (the incremental skips 02:00), so
 *    the two never contend for one conta's caps and state doc.
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
    const agora = Date.now();
    if (isSlotDoDaily(agora)) {
      logger.info(
        '[mercado-livre] stock sweep (incremental) — 02:00 America/Sao_Paulo slot belongs to the daily sweep, skipping this tick',
      );
      return;
    }
    if (isSlotDaReconciliacao(agora)) {
      logger.info(
        '[mercado-livre] stock sweep (incremental) — 03:00 slot on the 1st belongs to the monthly reconciliation, skipping this tick',
      );
      return;
    }
    await runAndLog('incremental');
  },
);

/**
 * The 02:00 daily full stock sweep (flag-gated — module doc). Owns its slot:
 * the incremental wrapper above skips exactly this tick.
 */
export const sweepMercadoLivreStockDaily = onSchedule(
  sweepScheduleOptions('0 2 * * *'),
  async () => {
    await runAndLog('daily');
  },
);

/** Its OWN flag, on top of the master one — see the export below. */
export const STOCK_RECONCILIACAO_FLAG_ENV = 'MERCADO_LIVRE_STOCK_RECONCILIACAO_ENABLED';

/**
 * The MONTHLY full reconciliation (flag-gated twice — module doc).
 *
 * Neither the incremental nor the daily tier can see a listing whose ERP stock
 * has not moved inside its window: drift on ML's side — a manual quantity edit,
 * a dropped PUT, a task lost past `maxPauseReenqueues` — is invisible to both.
 * Nor do they see a kit whose COMPONENT moved without the kit itself selling,
 * which is a deliberate cost decision (ADR 0014) and makes this pass the
 * corrector for the ~2000 sibling kits sharing one shirt and one print.
 *
 * `janelaDoSweep('reconciliacao')` returns `changedSinceMs: -1` — THE query's
 * documented force-all — so every anchor survives the window filter, including
 * families with no estoque doc at all. It still SKIPS listings whose published
 * number did not change since the last completed full pass; that comparison is
 * what makes re-sending an entire catalogue affordable, and it is why the pass
 * stamps its own `lastReconciliacaoAtUs` rather than borrowing `lastDailyAtUs`.
 *
 * Runs 03:00 America/Sao_Paulo on the 1st — clear of the 02:00 daily slot, so
 * the two never contend for a conta's caps or its state doc. Bounded per tick by
 * `maxTasksPerSweep()` plus the `continuacao` machinery, so a large catalogue
 * drains across several ticks rather than in one. Turn it on only after the
 * normal sweeps run cleanly, and turn it off alone if it costs more ML quota
 * than the drift it heals is worth.
 */
export const sweepMercadoLivreStockReconciliacao = onSchedule(
  sweepScheduleOptions('0 3 1 * *'),
  async () => {
    if (process.env[STOCK_RECONCILIACAO_FLAG_ENV] !== '1') {
      logger.info(
        `[mercado-livre] stock sweep (reconciliacao) disabled (${STOCK_RECONCILIACAO_FLAG_ENV} != '1') — no-op`,
      );
      return;
    }
    await runAndLog('reconciliacao');
  },
);
