import { logger } from 'firebase-functions/v2';
import { type ScheduleOptions, onSchedule } from 'firebase-functions/v2/scheduler';

import { readCacheDelta, readCacheMark } from '@delfrance/data/admin/cache';
import { MODO_VARREDURA_ESTOQUE, type ModoVarreduraEstoque } from '@delfrance/schemas';

import { createShopeeStockTaskScheduler } from '../../lib/shopee/estoque/shopeeStockTasks';
import {
  ehSlotDaReconciliacao,
  ehSlotDoDiario,
  runShopeeStockSweep,
} from '../../lib/shopee/estoque/varreduraEstoque';
import { getDb } from './lib/admin';

/**
 * The THREE Shopee stock-sync sweep schedules (master plan step 12, #1520) —
 * thin `onSchedule` wrappers over ONE function,
 * `runShopeeStockSweep` (`lib/shopee/estoque/varreduraEstoque.ts`). Ports
 * `apps/mercado-livre/functions/src/sweepStock.ts`; the tiers and their windows
 * are documented on that function, not here.
 *
 * | export | cron (America/Sao_Paulo) | modo |
 * |---|---|---|
 * | `sweepShopeeStock` | `10,25,40,55 * * * *` | incremental |
 * | `sweepShopeeStockDaily` | `10 2 * * *` | diário |
 * | `sweepShopeeStockReconciliacao` | `10 3 1 * *` | reconciliação |
 *
 * ⚠️ **The minutes are chosen, not inherited.** The seven schedules this
 * codebase already runs occupy `:00`, `:15`, `:20`, `:30` and `:45`, and all of
 * them draw on ONE undocumented partner rate-limit budget; `:10/:25/:40/:55`
 * collides with none of them. One overlap is accepted and named: on Mondays at
 * 05:10 the incremental tick shares its minute with `monitorShopeePushConfig`
 * (`10 5 * * 1`), which is a single Public GET.
 *
 * ⚠️ **The incremental wrapper skips its OWN 02:10 and day-1 03:10 slots, in
 * code.** A single cron line cannot express "every quarter-hour EXCEPT these
 * two", and the other three ticks of those hours still run — stock that moved
 * at 02:05 must sync at 02:25, not at 03:10. `ehSlotDoDiario` /
 * `ehSlotDaReconciliacao` ask `Intl` for `America/Sao_Paulo` explicitly; the
 * ambient process zone is never read (`no-ambient-timezone`: `apps/nfe` runs on
 * BRT while every other backend is UTC).
 *
 * ⚠️ **The reconciliação ships ON, with no flag of its own** — deliberately,
 * and unlike its ML twin, which carries a second `*_RECONCILIACAO_ENABLED`
 * valve. There is exactly ONE valve on this whole path,
 * `SHOPEE_STOCK_SYNC_ENABLED`, and it is checked inside `runShopeeStockSweep`
 * as the first statement of every tier: a second flag would be a way for the
 * corrector — the only tier that can see a listing whose ERP stock never moved
 * — to be off while the operator believes stock sync is on.
 *
 * ⚠️ **Only `scheduler` and `nowMs` are passed in production.** Every other
 * member of `DepsDaVarreduraShopee` is a TEST seam with a real default, and
 * supplying one here is how a pipeline reader gets replaced by a stub nobody
 * notices.
 *
 * ⚠️ **A closed tasks valve fails the tick, and the wrapper must let it.**
 * `ShopeeStockTasksDisabledError` is not contained per conta (C-m / #778): the
 * valve is a DEPLOYMENT state, not a conta state, so containing it would report
 * one broken deploy as N identical per-conta strings under a green tick. There
 * is no try/catch here for exactly that reason.
 *
 * Secrets: the sweep resolves each conta's context through the conta gates,
 * which refresh the shop token and make three Shop-signed reads, so both
 * partner credentials must be bound — the same rationale as every other
 * schedule in `index.ts`.
 *
 * Timeout 540: worst case per tick is N contas × (bounded discovery pages + up
 * to `maxTasksPerSweep()` sequential Cloud Tasks enqueues), which the gen2 60 s
 * `onSchedule` default cannot absorb. It matches the six other sweeps in this
 * codebase that do per-conta work.
 *
 * ⚠️ These functions ENQUEUE. Their runtime service account therefore needs
 * `roles/cloudtasks.enqueuer` plus `roles/run.invoker` on `sendShopeeStock`,
 * and `TASKS_INVOKER_SA` is AUTHORITATIVE — a deploy REPLACES the members of
 * both bindings, so an identity left out of that list LOSES the role. See
 * `functions/DEPLOY.md`; granting it is step 22's.
 */

/**
 * The two partner credentials, duplicated rather than imported.
 *
 * `index.ts` declares the same pair as a module-private `SHOPEE_SECRETS` and
 * exports nothing, and importing it would make this module depend on the file
 * that imports IT — a cycle through the one module whose import ORDER is
 * load-bearing (`./options` must be evaluated first). Both queue handlers carry
 * their own copy for the same reason. The copies cannot drift: `index.test.ts`
 * asserts the EXACT set on every schedule of this codebase, so a third name or
 * a typo reds there rather than deploying and failing at startup with a Secret
 * Manager 403.
 */
const SHOPEE_SECRETS = ['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY'];

/**
 * The shared `onSchedule` options, minus the schedule itself.
 *
 * ⚠️ No `region:` key, exactly like the seven schedules in `index.ts`:
 * `options.ts` sets it globally for this codebase from the build-time inlined
 * `FUNCTIONS_REGION`, and it defaults the enqueuer's region to the same value.
 * A local override would let the two drift, and a queue path pointing at the
 * wrong region drops every task while the enqueue still returns success
 * (#1108). Do not copy `apps/mercado-livre`'s explicit region — its functions
 * and its backend live in different regions, Shopee's do not.
 */
function opcoesDaVarredura(schedule: string): ScheduleOptions {
  return {
    schedule,
    timeZone: 'America/Sao_Paulo',
    secrets: SHOPEE_SECRETS,
    timeoutSeconds: 540,
  };
}

/**
 * Run ONE tick and log its summary.
 *
 * `nowMs` is the caller's SINGLE clock read, threaded rather than re-read: it
 * is the window's instant, the gates' cache expiry, every stamp and half of the
 * `sweepId`, and the incremental wrapper has already spent it on the slot
 * predicates.
 *
 * ⚠️ The tick itself already logs one summary line plus one line per gated,
 * paused or contained conta, so this line does NOT re-print the rows — it adds
 * the two things `runShopeeStockSweep` cannot know: whether the valve let it
 * run at all, and the read-cache hits/misses accrued by THIS tick. All-zeroes
 * on the latter means either an idle tick or the `DATA_READ_CACHE_DISABLED`
 * kill switch, which short-circuits before any counter moves.
 */
async function varrerERegistrar(modo: ModoVarreduraEstoque, nowMs: number): Promise<void> {
  // Bracket the tick: the snapshot counters are cumulative for the process, so
  // only a delta answers "for THIS sweep".
  const marca = readCacheMark();
  const result = await runShopeeStockSweep(getDb(), modo, {
    scheduler: createShopeeStockTaskScheduler(),
    nowMs,
  });
  const erros = result.contas
    .filter((conta) => conta.error !== null)
    .map((conta) => ({ integracaoId: conta.integracaoId, erro: conta.error }));
  logger.info(`[shopee] stock sweep (${modo})`, {
    // `false` ⇒ the master valve is closed and NOTHING was read — not the
    // integrações, not a state document, not Shopee. The tick itself already
    // logged the line that NAMES the variable, so this field is the machine
    // half of that fact rather than a second message.
    enabled: result.enabled,
    contas: result.contas.length,
    enqueued: somar(result, (conta) => conta.enqueued),
    // A SUPERSET of `inalterados`: it also carries the planner's per-listing
    // drops (no link, a native kit, a live refusal fingerprint). Summing the
    // two would double-count.
    skipped: somar(result, (conta) => conta.skipped),
    // Families the send policy found unchanged — the only number that says
    // whether the ledger comparison pays for itself. Read it against
    // `enqueued`.
    inalterados: somar(result, (conta) => conta.inalterados),
    pages: somar(result, (conta) => conta.pages),
    // A truncated conta advanced NOTHING — it is not partial success, and a
    // count that stays high tick after tick is a conta that can no longer keep
    // up, which is invisible in every other counter here.
    truncated: result.contas.filter((conta) => conta.truncated).length,
    // Contas skipped WHOLE by the pause gate. A standing count means Shopee is
    // throttling the send queue, not that the sweep is idle.
    paused: result.contas.filter((conta) => conta.paused).length,
    errorCount: erros.length,
    readCache: readCacheDelta(marca),
  });
  if (erros.length > 0) {
    // Bounded, and never a body: a contained conta failure cost the tick
    // nothing for the others, so it is its own line.
    logger.warn(`[shopee] stock sweep (${modo}) com falhas por conta`, {
      erros: erros.slice(0, 10),
    });
  }
}

/** Sum one per-conta counter across the tick. */
function somar(
  result: Awaited<ReturnType<typeof runShopeeStockSweep>>,
  pegar: (conta: (typeof result.contas)[number]) => number,
): number {
  return result.contas.reduce((total, conta) => total + pegar(conta), 0);
}

/**
 * The quarter-hourly INCREMENTAL sweep. Skips exactly two slots of its own
 * cron — 02:10 belongs to the daily pass and the 1st's 03:10 to the monthly
 * reconciliação — so the three tiers never contend for one conta's caps, its
 * state document or its continuation.
 */
export const sweepShopeeStock = onSchedule(opcoesDaVarredura('10,25,40,55 * * * *'), async () => {
  // THE clock read of this tick — spent on the predicates first and then
  // threaded into the sweep, so a tick cannot decide it is not the daily slot
  // and then run its window from a later instant.
  const agora = Date.now();
  if (ehSlotDoDiario(agora)) {
    logger.info(
      '[shopee] stock sweep (incremental) — o slot 02:10 America/Sao_Paulo é do diário; tick pulado',
    );
    return;
  }
  if (ehSlotDaReconciliacao(agora)) {
    logger.info(
      '[shopee] stock sweep (incremental) — o slot 03:10 do dia 1 é da reconciliação; tick pulado',
    );
    return;
  }
  await varrerERegistrar(MODO_VARREDURA_ESTOQUE.incremental, agora);
});

/**
 * The nightly DIÁRIO sweep, 02:10 America/Sao_Paulo — a flat 24 h lookback, not
 * a force-all: a listing whose ERP stock did not move inside the window is not
 * a candidate. It owns its slot, because the incremental wrapper above skips
 * exactly this tick.
 */
export const sweepShopeeStockDaily = onSchedule(opcoesDaVarredura('10 2 * * *'), async () => {
  await varrerERegistrar(MODO_VARREDURA_ESTOQUE.diario, Date.now());
});

/**
 * The monthly RECONCILIAÇÃO, 03:10 America/Sao_Paulo on the 1st — the only tier
 * that can see a listing whose ERP stock has not moved inside any window, which
 * is exactly where drift on Shopee's side lives (a hand edit in Seller Centre,
 * a dropped write, a task lost past the pause cap).
 *
 * It force-sends every discovered family (`changedSinceMs = -1`) and runs ZERO
 * ledger queries, so it is bounded by `maxTasksPerSweep()` and the continuation
 * machinery rather than by a window: a large catalogue drains across several
 * ticks.
 *
 * ⚠️ It reads NO flag of its own — see the module doc.
 */
export const sweepShopeeStockReconciliacao = onSchedule(
  opcoesDaVarredura('10 3 1 * *'),
  async () => {
    await varrerERegistrar(MODO_VARREDURA_ESTOQUE.reconciliacao, Date.now());
  },
);
