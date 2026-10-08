import { type ScheduleOptions, onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';

import {
  AUDITORIA_LOG_PREFIX,
  resumirAuditoria,
  runAuditoriaNaoEnumerados,
} from '../../lib/marketplace/estoque/auditoriaNaoEnumerados';
import { STOCK_SYNC_FLAG_ENV } from '../../lib/marketplace/estoque/bulkEstoquePlan';
import {
  type StockSweepMode,
  isSlotDaReconciliacao,
  isSlotDoDaily,
  runStockSweep,
} from '../../lib/marketplace/estoque/estoqueSweep';
import { createMlStockTaskScheduler } from '../../lib/marketplace/estoque/mlStockTasks';
import { getDb } from './lib/admin';
import { readCacheDelta, readCacheMark } from '@delfrance/data/admin/cache';
import { TASKS_SCHEDULER_REGION } from './options';

/**
 * The two ML stock-sync sweep schedules (Step 10 PR C) — thin `onSchedule`
 * wrappers over `runStockSweep` (lib/marketplace/estoque/estoqueSweep.ts), mirroring
 * the `importMercadoLivreOrders` wrapper in index.ts:
 *
 *  - `sweepMercadoLivreStock` — every 15 minutes, `'incremental'` mode: per
 *    conta, discovers the produto families whose estoques changed since the
 *    durable cursor (state doc `estoqueMercadoLivreSync/{integracaoId}`), keeps
 *    the ones whose PUBLISHED number actually changed (`anterior = atual −
 *    Σmovimento` over the window, run back through the same kit math) and
 *    enqueues one send task per ML API call onto the `sendMercadoLivreStock`
 *    queue. A change is skipped anyway while the quantity stays above
 *    `limiarEstoqueAlto()` on BOTH sides — that arm is incremental-only. The ONE
 *    tick at the 02:00 slot is skipped in code (`isSlotDoDaily` — a single cron
 *    line cannot exclude just one slot): that slot belongs to the daily pass
 *    below, while 02:15/02:30/02:45 still run (owner call — stock changed at
 *    02:05 must sync at 02:15, not 03:00; the cursor makes the one skipped slot
 *    self-healing regardless).
 *  - `sweepMercadoLivreStockDaily` — 02:00 America/Sao_Paulo, `'daily'` mode:
 *    the same discovery over a FLAT `dailyWindowHours()` (24h) lookback — NOT
 *    a force-all `changedSinceMs: -1` scan, so it is **not** a reconciliation:
 *    a listing whose ERP stock did not move inside the window is not a
 *    candidate. It re-sends everything that DID change, without the high-stock
 *    arm. The monthly `'reconciliacao'` pass below is the real corrector. It
 *    owns its slot alone (the incremental skips 02:00), so the two never
 *    contend for one conta's caps and state doc.
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
 *
 * ---- The FOURTH schedule, and the one that is not a tier: the monthly link
 * audit (#1200), `sweepMercadoLivreAnunciosNaoEnumerados` at the bottom.
 *
 * All three tiers enumerate PRODUTOS through S1's two anchor terms (`paiId ==
 * null` AND `integracoesComProduto array-contains <conta>`), so a live anúncio
 * whose produto falls outside them is invisible to every tier at once and leaves
 * no trace — a sweep reports `completed` while that listing keeps selling at
 * whatever stock it last had. Once a month the audit walks each conta's LINKS
 * instead (`runAuditoriaNaoEnumerados`, lib/marketplace/estoque/
 * auditoriaNaoEnumerados.ts): it re-adds the conta to a produto whose array lost
 * it (the tier-1 read-derived heal) and raises ONE aviso per produto (new ones
 * capped per conta per run) for what only a human can fix. It sends nothing,
 * enqueues nothing and writes no
 * `estoqueMercadoLivreSync` state doc.
 *
 *  - **Why 02:30 on the 1st.** The heal must land BEFORE the 03:00 force-all
 *    re-enumerates the catalogue, or a healed family waits a whole month for its
 *    next full pass. 02:30 plus the 540 s timeout is 02:39 — clear of 03:00 even
 *    for a run killed at its timeout (`index.test.ts` pins the cron AND that
 *    arithmetic against the reconciliação's own parsed cron). It shares the 02:30
 *    slot with an ordinary incremental tick, harmlessly: the audit owns no state
 *    doc, no cursor and no queue that tick could contend for.
 *  - **Why the reconciliação valve does not gate it.**
 *    `MERCADO_LIVRE_STOCK_RECONCILIACAO_ENABLED` is an ML-QUOTA valve — it exists
 *    to switch off a pass that costs more ML calls than the drift it heals. The
 *    audit makes ZERO ML calls, so it runs with that valve off, behind the master
 *    `MERCADO_LIVRE_STOCK_SYNC_ENABLED` alone (read inside
 *    `runAuditoriaNaoEnumerados`). Its handler names no other flag, and a
 *    source-read test in `index.test.ts` keeps it that way.
 *  - **Why its own options literal.** `sweepScheduleOptions` binds the ML app
 *    secrets, and a function that never calls ML must not carry them
 *    (`options.ts`).
 *  - ⚠️ **Precondition: the COLLECTION_GROUP index
 *    `produtoMercadoLivre(contaOuterRef ASC, __name__ ASC)` must be READY wherever
 *    the master flag is on.** It was declared in the same commit as S1's own
 *    entry (#1191), so a project where S1 is indexed has it. Without it nothing
 *    fails: Enterprise full-scans the whole collection group — every link of
 *    every conta — on every page of the walk, silently and billed by data
 *    scanned. `scripts/check-stock-indexes.mjs` carries the plan check.
 *  - **What a heal does and does NOT send (owner decision D4).** The audit holds
 *    no ML secret, so a healed family reaches ML through the 03:00 force-all.
 *    That pass is a force-all for ENUMERATION only: the send policy
 *    (`deveEnviarFamiliaCore`) still skips a family whose stock did not move
 *    since the conta's `lastReconciliacaoAtUs` baseline, the previous completed
 *    full pass. So a healed family is re-sent at 03:00 only if its stock moved
 *    since that pass — which, in steady state, covers every movement made while
 *    it was invisible: the audit that ran just before that pass left it visible
 *    (healthy or healed), so the invisibility began after the baseline.
 *    Otherwise — a month whose full pass was off or pre-empted, or drift older
 *    than one cycle — it converges on the family's next stock movement or a
 *    manual push; the summary line names the healed anchors (`amostraCurados`)
 *    for exactly that push.
 */

/** Shared onSchedule options minus the schedule itself (see the module doc). */
function sweepScheduleOptions(schedule: string): ScheduleOptions {
  return {
    schedule,
    timeZone: 'America/Sao_Paulo',
    // Cloud Scheduler does not exist in us-east5 — see TASKS_SCHEDULER_REGION.
    region: TASKS_SCHEDULER_REGION,
    secrets: ['MERCADO_LIVRE_CLIENT_ID', 'MERCADO_LIVRE_CLIENT_SECRET'],
    timeoutSeconds: 540,
  };
}

/** Run one sweep tick and log its summary (the importMercadoLivreOrders discipline). */
async function runAndLog(mode: StockSweepMode): Promise<void> {
  // Bracket the tick: the snapshot counters are cumulative for the process, so
  // only a delta answers "for THIS sweep" — the number #754 asks for.
  const cacheMark = readCacheMark();
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
    // A SUBSET of `skipped`: the families the SEND POLICY rejected. Read against
    // `enqueued` — that ratio is the whole point of the ledger comparison, and
    // without this line it is not observable (#695).
    // ⚠️ On the INCREMENTAL tier it is not purely "nothing changed": the policy
    // also rejects a family that DID change while staying above
    // `limiarEstoqueAlto()` on both sides (the freshness arm), and that lands
    // here too. The daily and monthly passes carry no such arm, so only THEIR
    // `inalterados` reads as "nothing moved".
    inalterados: result.contas.reduce((sum, c) => sum + c.inalterados, 0),
    pages: result.contas.reduce((sum, c) => sum + c.pages, 0),
    truncated: result.contas.filter((c) => c.truncated).length,
    // Contas skipped by the 429 pause gate — a standing count here means the
    // send queue is being throttled by ML, not that the sweep is idle.
    paused: result.contas.filter((c) => c.paused).length,
    errorCount: errors.length,
    // Read-cache hits/misses accrued by THIS tick. All-zeroes means either an
    // idle tick or the `DATA_READ_CACHE_DISABLED` kill switch — which
    // short-circuits before any counter moves. That is the A/B baseline.
    readCache: readCacheDelta(cacheMark),
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
 * The 02:00 daily stock sweep — a flat 24h window, NOT a force-all (flag-gated;
 * see the module doc). Owns its slot: the incremental wrapper above skips
 * exactly this tick.
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

/**
 * The MONTHLY link audit (#1200) — 02:30 America/Sao_Paulo on the 1st, half an
 * hour before the force-all above, so the classes it heals are enumerable again
 * by the time that pass runs. Not a tier: it sends nothing (module doc, "The
 * FOURTH schedule").
 *
 * ⚠️ Its OWN options literal, never `sweepScheduleOptions`: that helper binds
 * the ML app secrets, and the audit makes zero ML calls. `index.test.ts`
 * asserts the endpoint carries no `MERCADO_LIVRE_CLIENT_ID`.
 *
 * ⚠️ Gated by the master flag alone (inside `runAuditoriaNaoEnumerados`), NEVER
 * by `STOCK_RECONCILIACAO_FLAG_ENV` — owner decision D2: it runs even with the
 * reconciliação valve off, because that valve rations ML quota and the audit
 * spends none. A source-read test in `index.test.ts` pins that this handler
 * names no such flag; keep the handler self-contained (no shared helper that
 * could read one on its behalf).
 *
 * No try/catch: per-conta Firestore failures are already contained inside the
 * run and come back as `error` on that conta's result; anything else is a bug
 * and must fail the invocation loudly (root `CLAUDE.md` rule 6).
 */
export const sweepMercadoLivreAnunciosNaoEnumerados = onSchedule(
  {
    schedule: '30 2 1 * *',
    timeZone: 'America/Sao_Paulo',
    // Cloud Scheduler does not exist in us-east5 — see TASKS_SCHEDULER_REGION.
    region: TASKS_SCHEDULER_REGION,
    // No `secrets:` — deliberately (doc above). 540 s is the run's hard stop;
    // the audit's own time budget (`AUDITORIA_ORCAMENTO_MS`, 400 s) leaves the
    // rest for the last in-flight write and the per-conta log lines.
    timeoutSeconds: 540,
  },
  async () => {
    const inicio = Date.now();
    const result = await runAuditoriaNaoEnumerados(getDb(), { agora: () => Date.now() });
    if (!result.enabled) {
      logger.info(`${AUDITORIA_LOG_PREFIX} disabled (${STOCK_SYNC_FLAG_ENV} != '1') — no-op`);
      return;
    }
    // THE summary line — its message is exactly AUDITORIA_LOG_PREFIX (the
    // per-conta lines append `: conta concluída`), which is what the #948 cost
    // step greps to attribute the audit separately from the stock tiers.
    logger.info(AUDITORIA_LOG_PREFIX, resumirAuditoria(result, Date.now() - inicio));
    const errors = result.contas.filter((c) => c.error != null);
    if (errors.length > 0) {
      logger.warn(`${AUDITORIA_LOG_PREFIX} had per-conta failures`, {
        errors: errors.slice(0, 10).map((c) => ({ integracaoId: c.integracaoId, error: c.error })),
      });
    }
  },
);
