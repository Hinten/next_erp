/**
 * **The stock sweep** — the tick that turns "something moved in the ERP" into
 * `sendShopeeStock` tasks, for every active Shopee conta (master-plan step 12,
 * #1520). Three scheduled tiers share this ONE function and differ only by the
 * `modo` they are called with:
 *
 * | tier | cadence | window | send policy | stamp |
 * |---|---|---|---|---|
 * | `incremental` | quarter-hourly | the cursor, bounded by the max lookback | skips a change that stays comfortably high on both sides | `cursorMs` |
 * | `diario` | nightly 02:10 BRT | a flat `DAILY_WINDOW_H` lookback | sends every real change | `lastDailyAtMs` |
 * | `reconciliacao` | 03:10 BRT on the 1st | **everything** (`changedSinceMs = -1`) | force-send | `lastReconciliacaoAtMs` |
 *
 * Template and precedent: `apps/mercado-livre/lib/marketplace/estoque/estoqueSweep.ts`,
 * whose shape this follows deliberately — the same page loop, the same
 * tick-wide promise memo, the same containment boundary, the same
 * continuation-wins rule. What differs is DELIBERATE and is called out where it
 * happens: the conta gates live in their own module here (`./contaEstoque`),
 * the state patches are a closed union (`./estadoEstoque`) instead of
 * hand-written records, the reconciliação runs **zero** ledger queries, and
 * every instant is MILLISECONDS.
 *
 * ## ⚠️ The five things that make a sweep quietly wrong
 *
 * 1. **ONE clock read per tick.** `deps.nowMs` is the tick's logical instant
 *    and is threaded into the window, the gates, the per-link skip set, the
 *    task payload and every stamp. Re-reading a clock mid-tick makes two
 *    listings in one sweep straddle an expiry and makes the `sweepId`
 *    non-deterministic.
 * 2. **A stored `continuacao` WINS over the tick's own mode.** A tick that
 *    finds one runs ONLY that frozen sweep — same window, same policy, same
 *    keyset position — and its own window waits for the next tick. That is what
 *    keeps the caps meaningful: one tick is never two sweeps' worth of pages.
 *    A daily continuation drained by an incremental tick completed a DAILY
 *    pass, so it stamps the DAILY field.
 * 3. **A truncated tick advances NOTHING.** It freezes where it stopped; the
 *    cursor moves only when the window is actually covered. The resume point is
 *    the last anchor whose tasks were ALL enqueued, so a family cut mid-way is
 *    RE-processed — re-enqueues are harmless (the send is verbatim and the next
 *    sweep converges), a skipped family is a silent permanent loss.
 * 4. **The incremental cursor advances to the sweep's OWN start**, never to the
 *    instant it finished. Anything that landed while the sweep ran is still
 *    owed.
 * 5. **The per-conta containment boundary has exactly one hole, on purpose.**
 *    A stock-tasks valve refusal is a DEPLOYMENT state, not a conta state, so
 *    it fails the whole tick loudly (#778's argument, C-m). Containing it would
 *    turn one broken deploy into N identical `lastError` strings and a green
 *    tick over a total outage.
 *
 * ## The tick-wide ledger memo
 *
 * The window's net movement is one grouped aggregate per `(window, depósito)`
 * and the tick holds the in-flight **promise**, not the resolved map, so two
 * contas bound to the same depósito share ONE execution and an IDLE tick — no
 * conta returning a family row — runs **zero** ledger queries. A rejected pass
 * is shared too, deliberately: every conta on that window would fail the same
 * way this tick, and each failure is contained per conta by the loop.
 *
 * ## The unverifiable-kit alarm
 *
 * A kit whose `componentesKitKeys` denorm went stale resolves NO components and
 * publishes 0 — a real number, structurally valid, and completely wrong. There
 * is no other signal for it: the planner is pure and has nowhere to shout. So
 * the alarm fires HERE, once per member per tick, right where the family row is
 * handed to the planner, through the injected logger. The manual push has no
 * logger seam and deliberately does not reuse it.
 *
 * ## Slot ownership
 *
 * One cron line cannot express "every quarter-hour EXCEPT this one slot" — the
 * minute and hour fields are a cross-product — so the incremental wrapper runs
 * on every quarter-hour and skips the two slots the other tiers own, in code,
 * through {@link ehSlotDoDiario} and {@link ehSlotDaReconciliacao}. The zone is
 * NAMED (`no-ambient-timezone`): `apps/nfe` runs on `America/Sao_Paulo` while
 * every other backend is UTC, so an ambient derivation would answer three hours
 * apart depending on which service ran it — and the test runner's own third
 * zone would hide it.
 */
import type { Firestore } from 'firebase-admin/firestore';

import {
  type FetchMovimentosDaJanela,
  type MovimentosDaJanela,
  componentesNaoResolvidos,
  kitNaoVerificavel,
} from '@delfrance/data/admin/estoque';
import {
  SHOPEE_ERROR_KIND,
  ShopeeRateLimitError,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';
import { MODO_VARREDURA_ESTOQUE, type ModoVarreduraEstoque, idFromRef } from '@delfrance/schemas';

import { proximaViradaDaCotaMs } from '../anuncios/pausarAnuncio';
import { readConta } from '../core/contaCache';
import { listarContasShopeeAtivas } from '../core/contas';
import { erroContidoPorConta } from '../core/containment';
import {
  MAX_PAGES_PER_SWEEP,
  MOTIVOS_DE_PAUSA,
  SHOPEE_STOCK_SYNC_FLAG_ENV,
  cursorMaxLookbackHours,
  dailyWindowHours,
  incrementalWindowMin,
  isShopeeStockSyncEnabled,
  maxTasksPerSweep,
  ratePauseMin,
  windowOverlapSec,
} from './constantesEstoque';
import { avaliarContaParaEstoque } from './contaEstoque';
import {
  type BuscarFamiliasShopee,
  buscarFamiliasShopee,
  buscarMovimentosDaJanela,
} from './descobertaEstoque';
import {
  CARIMBO_VARREDURA,
  type ContinuacaoLida,
  type EstadoEstoqueLido,
  armarPausa,
  carimbarVarredura,
  estaPausada,
  lerEstadoEstoque,
  registrarErroDaConta,
  registrarMotivoDaConta,
} from './estadoEstoque';
import {
  MOTIVO_ESTOQUE_SHOPEE,
  type MotivoEstoqueShopee,
  ShopeeStockTasksDisabledError,
} from './errosEstoque';
import {
  type LinhaDeFamiliaShopee,
  anterioresComDesauditado,
  montarTarefasDeEstoqueShopee,
} from './planoEstoque';
import { deveEnviarFamiliaShopee, quantidadesDaFamiliaShopee } from './quantidadeEstoque';
import type { AgendadorEstoqueShopee } from './shopeeStockTasks';

/**
 * One hour in milliseconds, spelled from its factors.
 *
 * ⚠️ Not a readability choice: this folder's raw-text discipline forbids the
 * expanded literal in source, so the factors ARE the spelling. The same rule is
 * why nothing here converts a pause accessor — `pausaLojaH()` already answers
 * milliseconds.
 */
const MS_POR_HORA = 60 * 60 * 1000;

/** One minute in milliseconds. */
const MS_POR_MINUTO = 60_000;

/** How many unresolved component keys one alarm line names. */
const COMPONENTES_NO_ALARME = 10;

/** The minute band a slot owns — `[SLOT_MINUTO_DE, SLOT_MINUTO_ATE)`. */
const SLOT_MINUTO_DE = 10;
const SLOT_MINUTO_ATE = 25;

/* -------------------------------------------------------------------------- */
/*                                   SEAMS                                    */
/* -------------------------------------------------------------------------- */

/** The three lines a tick may emit. Injected so a suite reads them as data. */
export interface LoggerDaVarredura {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Everything the sweep needs that is not the database. */
export interface DepsDaVarreduraShopee {
  /** The enqueue seam — `createShopeeStockTaskScheduler()` in production. */
  readonly scheduler: AgendadorEstoqueShopee;
  /**
   * MILLISECONDS. ONE clock read for the WHOLE tick.
   *
   * ⚠️ It is the window's instant, the gates' instant, the caches' expiry
   * instant, every stamp and half of the `sweepId`. Handing in a value from
   * another clock domain moves all of them at once.
   */
  readonly nowMs: number;
  /** THE discovery query — defaults to the pipeline (pipelines never run in tests). */
  readonly buscarFamilias?: BuscarFamiliasShopee;
  /** The ledger aggregate — defaults to the pipeline, memoised per tick. */
  readonly buscarMovimentos?: FetchMovimentosDaJanela;
  /** The conta gates — defaults to {@link avaliarContaParaEstoque}. */
  readonly avaliarConta?: typeof avaliarContaParaEstoque;
  /** Threaded into the gates; they build the client lazily and only if a gate needs it. */
  readonly clientFor?: (db: Firestore, integracaoId: string) => Promise<ShopeeClient>;
  /** Defaults to the console. */
  readonly logger?: LoggerDaVarredura;
}

/** What ONE conta produced on ONE tick. */
export interface ResultadoDaContaShopee {
  readonly integracaoId: string;
  /** Tasks handed to the scheduler. */
  readonly enqueued: number;
  /**
   * Listings NOT sent: the planner's `pulos` plus one per family the send
   * policy found unchanged. A superset of {@link inalterados}.
   */
  readonly skipped: number;
  /**
   * Families the send policy found unchanged — the only number that says
   * whether the comparison pays for its ledger read. `skipped` alone cannot
   * answer that: it also carries the planner's per-listing drops.
   */
  readonly inalterados: number;
  readonly pages: number;
  /** A cap was hit with backlog remaining; nothing advanced. */
  readonly truncated: boolean;
  /** The pause gate was closed — the conta was skipped WHOLE, nothing was read. */
  readonly paused: boolean;
  /** Why nothing went out, when a conta gate refused. `null` when it did not. */
  readonly motivoConta: MotivoEstoqueShopee | null;
  /** A CONTAINED per-conta failure's message. `null` when the conta ran. */
  readonly error: string | null;
}

/** What the whole tick produced — what the `onSchedule` wrapper logs. */
export interface ResultadoDaVarreduraShopee {
  /** `false` ⇒ the valve is closed and NOTHING was read. */
  readonly enabled: boolean;
  readonly contas: readonly ResultadoDaContaShopee[];
}

/** The window ONE sweep runs over. Every instant is MILLISECONDS. */
export interface JanelaDaVarredura {
  /** Exclusive discovery lower bound. `-1` is the force-all sentinel. */
  readonly changedSinceMs: number;
  /** The ledger baseline; `null` ⇒ no baseline, force-send, ZERO ledger queries. */
  readonly movimentosDesdeMs: number | null;
  /** The tier whose POLICY this window carries. */
  readonly modo: ModoVarreduraEstoque;
}

/** The tick-wide `(window, depósito)` → movements getter. */
type ObterMovimentos = (desdeMs: number, depositoId: string) => Promise<MovimentosDaJanela>;

/* -------------------------------------------------------------------------- */
/*                              THE WINDOW                                    */
/* -------------------------------------------------------------------------- */

/**
 * The window the given tier runs over, derived from the conta's own state.
 *
 * - **incremental** — from the stored cursor, never further back than
 *   `CURSOR_MAX_LOOKBACK_H` (a cold cursor must not scan the world), minus the
 *   overlap slack. With no cursor at all — a conta's first tick — the floor is
 *   `now − INCREMENTAL_WINDOW_MIN`, which is the tier's own cadence.
 * - **diário** — a flat `DAILY_WINDOW_H` lookback. It carries no overlap: the
 *   incremental tier already re-covers this ground every quarter-hour, and this
 *   tier exists for the changes that tier deliberately SKIPPED (the high-stock
 *   rule), not for boundary coverage.
 * - **reconciliação** — `-1`, the discovery query's documented force-all, so
 *   every anchor survives the filter INCLUDING families with no estoque
 *   document at all, which any positive window excludes by construction. And
 *   `movimentosDesdeMs: null`: this tier compares against nothing and therefore
 *   runs ZERO ledger queries. That is the whole tier in one line — a full pass
 *   that asks no questions.
 *
 * ⚠️ `-1` is a LEGAL stored value, not a malformed one. Nothing anywhere may
 * read a non-positive `changedSinceMs` as damage.
 */
export function janelaDoSweepShopee(
  modo: ModoVarreduraEstoque,
  nowMs: number,
  estado: EstadoEstoqueLido,
): JanelaDaVarredura {
  if (modo === MODO_VARREDURA_ESTOQUE.reconciliacao) {
    return { changedSinceMs: -1, movimentosDesdeMs: null, modo };
  }
  if (modo === MODO_VARREDURA_ESTOQUE.diario) {
    const changedSinceMs = nowMs - dailyWindowHours() * MS_POR_HORA;
    return { changedSinceMs, movimentosDesdeMs: changedSinceMs, modo };
  }
  const overlapMs = windowOverlapSec() * 1000;
  const changedSinceMs =
    estado.cursorMs === null
      ? nowMs - incrementalWindowMin() * MS_POR_MINUTO - overlapMs
      : Math.max(estado.cursorMs, nowMs - cursorMaxLookbackHours() * MS_POR_HORA) - overlapMs;
  return { changedSinceMs, movimentosDesdeMs: changedSinceMs, modo };
}

/** The named wall-clock parts of `nowMs` in São Paulo. */
function partesEmSaoPaulo(nowMs: number): { dia: number; hora: number; minuto: number } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour12: false,
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date(nowMs));
  const ler = (tipo: string): number =>
    Number(partes.find((p) => p.type === tipo)?.value ?? Number.NaN);
  // Some ICU versions emit hour '24' for midnight under hour12:false. Irrelevant
  // to both predicates (they compare against 2 and 3), normalized anyway so a
  // future slot at midnight does not inherit the trap.
  return { dia: ler('day'), hora: ler('hour') % 24, minuto: ler('minute') };
}

/**
 * Does `nowMs` fall in the 02:10 America/São_Paulo slot the DIÁRIO tier owns?
 *
 * ⚠️ The band is `[10, 25)`, not "on the hour": Cloud Scheduler fires the `:10`
 * cron with jitter, and a band narrower than the jitter makes the incremental
 * tick and the nightly tick run the SAME slot — two sweeps of one conta with
 * two different policies, both stamping.
 */
export function ehSlotDoDiario(nowMs: number): boolean {
  const { hora, minuto } = partesEmSaoPaulo(nowMs);
  return hora === 2 && minuto >= SLOT_MINUTO_DE && minuto < SLOT_MINUTO_ATE;
}

/**
 * Does `nowMs` fall in the 03:10 slot on the 1st of the month that the
 * RECONCILIAÇÃO tier owns? Same band and same reason as {@link ehSlotDoDiario}.
 */
export function ehSlotDaReconciliacao(nowMs: number): boolean {
  const { dia, hora, minuto } = partesEmSaoPaulo(nowMs);
  return dia === 1 && hora === 3 && minuto >= SLOT_MINUTO_DE && minuto < SLOT_MINUTO_ATE;
}

/* -------------------------------------------------------------------------- */
/*                                 PLUMBING                                   */
/* -------------------------------------------------------------------------- */

function loggerDe(deps: DepsDaVarreduraShopee): LoggerDaVarredura {
  return (
    deps.logger ?? {
      info: (msg: string, meta?: Record<string, unknown>): void => {
        // eslint-disable-next-line no-console -- bounded: one line per conta per tick
        if (meta === undefined) console.info(msg);
        // eslint-disable-next-line no-console -- bounded: one line per conta per tick
        else console.info(msg, meta);
      },
      warn: (msg: string, meta?: Record<string, unknown>): void => {
        if (meta === undefined) console.warn(msg);
        else console.warn(msg, meta);
      },
      error: (msg: string, meta?: Record<string, unknown>): void => {
        if (meta === undefined) console.error(msg);
        else console.error(msg, meta);
      },
    }
  );
}

/** An empty per-conta row — every counter zero, nothing observed. */
function contaVazia(integracaoId: string): ResultadoDaContaShopee {
  return {
    integracaoId,
    enqueued: 0,
    skipped: 0,
    inalterados: 0,
    pages: 0,
    truncated: false,
    paused: false,
    motivoConta: null,
    error: null,
  };
}

/**
 * Run a SECONDARY write — one that records why the primary work failed — and
 * tolerate a classifiable failure of it.
 *
 * ⚠️ Only a classifiable one. A secondary failure that is NOT in the contained
 * family is a coding bug and must still escape, exactly as the primary one
 * would have: swallowing it here would hide the bug behind the very incident it
 * was trying to report.
 */
async function tolerarFalhaSecundaria(
  acao: () => Promise<void>,
  log: LoggerDaVarredura,
  contexto: Record<string, unknown>,
): Promise<void> {
  try {
    await acao();
  } catch (err) {
    if (!erroContidoPorConta(err)) throw err;
    log.error('[shopee/estoque] falha secundária ao registrar o estado da conta', {
      ...contexto,
      falha: err.message,
    });
  }
}

/**
 * Arm the ONE pause gate from a rate-limit refusal met DURING the sweep.
 *
 * The daily quota resets at a fixed wall-clock instant (00:00 UTC+8), so the
 * pause runs to that instant and not to a duration; a burst throttle is a short
 * window and pauses for `ratePauseMin()`. Shopee's code is stored VERBATIM,
 * prefix and all, so an operator reading the document sees what Shopee said.
 */
async function armarPausaDoLimite(
  db: Firestore,
  integracaoId: string,
  err: ShopeeRateLimitError,
  pauseCountAtual: number,
  nowMs: number,
  log: LoggerDaVarredura,
): Promise<void> {
  const diaria = err.kind === SHOPEE_ERROR_KIND.daily;
  const ate = diaria ? proximaViradaDaCotaMs(nowMs) : nowMs + ratePauseMin() * MS_POR_MINUTO;
  const motivo = diaria ? MOTIVOS_DE_PAUSA.cotaDiaria : MOTIVOS_DE_PAUSA.burst;
  log.warn('[shopee/estoque] limite de chamadas — conta pausada', {
    integracaoId,
    motivo,
    codigo: err.code,
    pausadoAte: ate,
  });
  await tolerarFalhaSecundaria(
    () => armarPausa(db, integracaoId, { ate, motivo, codigo: err.code, pauseCountAtual }),
    log,
    { integracaoId, operacao: 'armarPausa' },
  );
}

/**
 * The ONLY signal that a kit publishing 0 has a STALE `componentesKitKeys`
 * denorm rather than a genuinely empty composition.
 *
 * ⚠️ Once per MEMBER per tick, never per task, and only for a member the family
 * actually publishes — a member with no quantity is not being published as 0,
 * it is not being published at all, and a line about it would send whoever
 * reached for it mid-incident hunting a denorm that is not their problem. That
 * guard is UNREACHABLE today and is kept deliberately: this channel pins the
 * core's virtual-kit skip to `false`, so the quantity map omits nothing. It is
 * the same tail the quantity binding keeps for the same reason — correct the
 * moment that option changes, and no behaviour is built on it meanwhile.
 *
 * It lives in the sweep and not in the planner because the planner is pure and
 * has nowhere to shout, and because the manual push — the other caller of that
 * planner — has no logger seam.
 */
function alarmarKitsNaoVerificaveis(
  row: LinhaDeFamiliaShopee,
  quantidades: ReadonlyMap<string, number>,
  ctx: { integracaoId: string; sweepId: string; log: LoggerDaVarredura },
): void {
  for (const membro of [row.anchor, ...row.children]) {
    if (!quantidades.has(membro.produtoId)) continue;
    if (!kitNaoVerificavel(membro)) continue;
    ctx.log.error(
      '[shopee/estoque] kit sem componentes resolvíveis — publicando 0 ' +
        '(provável `componentesKitKeys` desatualizado)',
      {
        integracaoId: ctx.integracaoId,
        sweepId: ctx.sweepId,
        anchorId: row.anchorId,
        produtoId: membro.produtoId,
        componentes: componentesNaoResolvidos(membro).slice(0, COMPONENTES_NO_ALARME),
      },
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                              ONE CONTA'S SWEEP                             */
/* -------------------------------------------------------------------------- */

/** What {@link varrerConta} needs. */
interface ArgsDaVarreduraDaConta {
  readonly db: Firestore;
  readonly integracaoId: string;
  readonly depositoId: string;
  readonly estado: EstadoEstoqueLido;
  /** The tier this TICK was invoked as — not necessarily the one it runs. */
  readonly modoDoTick: ModoVarreduraEstoque;
  readonly nowMs: number;
  readonly buscarFamilias: BuscarFamiliasShopee;
  readonly obterMovimentos: ObterMovimentos;
  readonly scheduler: AgendadorEstoqueShopee;
  readonly log: LoggerDaVarredura;
}

/** The counters one conta's sweep produced. */
type ParcialDaConta = Pick<
  ResultadoDaContaShopee,
  'enqueued' | 'skipped' | 'inalterados' | 'pages' | 'truncated'
>;

/**
 * Sweep ONE conta that has already passed the pause gate and the conta gates:
 * resume a frozen continuation (or derive this tier's window), page the
 * discovery query, plan and enqueue per family row, then close the tick with
 * exactly the stamp its outcome earns.
 *
 * Throws on any failure — the caller's containment boundary is what classifies
 * it. There is no `catch` in here on purpose: a provider outage contained into
 * a per-family "skip" would read as a catalogue of broken listings.
 */
async function varrerConta(args: ArgsDaVarreduraDaConta): Promise<ParcialDaConta> {
  const { db, integracaoId, depositoId, estado, modoDoTick, nowMs, log } = args;

  // (a) RESUME or derive. A stored continuation freezes the truncated sweep's
  // window, policy and keyset position, and this tick runs ONLY that — its own
  // window waits for the next tick.
  const { continuacao } = estado;
  const { changedSinceMs, movimentosDesdeMs, modo } =
    continuacao === null
      ? janelaDoSweepShopee(modoDoTick, nowMs, estado)
      : {
          changedSinceMs: continuacao.changedSinceMs,
          movimentosDesdeMs: continuacao.movimentosDesdeMs,
          modo: continuacao.modo,
        };
  // The send policy comes from the FROZEN window, never from the tick that
  // picked it up: a diário continuation drained by an incremental tick must
  // keep diário semantics, or the high-stock skip silently suppresses exactly
  // the rows the nightly pass exists to send.
  const incremental = modo === MODO_VARREDURA_ESTOQUE.incremental;
  // What an incremental pass advances its cursor to: the ORIGINAL sweep's
  // start on a drained continuation, this tick's start on a fresh run.
  const startedAtMs = continuacao?.startedAtMs ?? nowMs;
  // Deterministic — never random. A retried tick with the same clock reproduces
  // it, which is what makes a sweep correlatable with the tasks it produced.
  const sweepId =
    continuacao === null
      ? `${modoDoTick}-${integracaoId}-${nowMs}`
      : `${modoDoTick}-cont-${integracaoId}-${nowMs}`;

  const maxTasks = maxTasksPerSweep();
  // Resolved LAZILY and cached per conta: nothing is queried until a family row
  // actually needs its baseline, and the tick's memo makes it at most once per
  // (window, depósito) overall.
  let movimentos: MovimentosDaJanela | null = null;
  let pages = 0;
  let enqueued = 0;
  let skipped = 0;
  let inalterados = 0;
  let truncated = false;
  let afterAnchorId: string | null = continuacao?.afterAnchorId ?? null;
  // The last anchor whose tasks were ALL enqueued — the only safe resume point.
  let ultimoAnchorCompleto: string | null = null;
  const pulosPorMotivo = new Map<MotivoEstoqueShopee, number>();

  // (b) Page loop — ONE discovery execution per iteration, keyset-fed.
  for (;;) {
    const pagina = await args.buscarFamilias(db, {
      integracaoId,
      depositoId,
      changedSinceMs,
      afterAnchorId,
    });
    pages += 1;

    for (const row of pagina.rows) {
      // (c) Quantities AT SWEEP TIME — the payload carries them verbatim.
      const quantidades = quantidadesDaFamiliaShopee(row);
      // THE lazy trigger point. A `null` baseline means force-send with no
      // ledger read at all — the reconciliação tier, and a conta's very first
      // pass, where there is nothing to compare against.
      const anteriores =
        movimentosDesdeMs === null
          ? null
          : anterioresComDesauditado(
              row,
              depositoId,
              (movimentos ??= await args.obterMovimentos(movimentosDesdeMs, depositoId)),
              changedSinceMs,
            );
      if (!deveEnviarFamiliaShopee(quantidades, anteriores, incremental)) {
        // Either nothing this family publishes actually moved, or (incremental
        // only) it moved while staying comfortably high on both sides — the
        // nightly and monthly passes cover that.
        skipped += 1;
        inalterados += 1;
        ultimoAnchorCompleto = row.anchorId;
        continue;
      }

      alarmarKitsNaoVerificaveis(row, quantidades, { integracaoId, sweepId, log });

      const { tarefas, pulos } = montarTarefasDeEstoqueShopee(row, quantidades, {
        integracaoId,
        sweepId,
        sweepComputadoEmMs: nowMs,
        nowMs,
      });
      skipped += pulos.length;
      for (const pulo of pulos) {
        pulosPorMotivo.set(pulo.motivo, (pulosPorMotivo.get(pulo.motivo) ?? 0) + 1);
      }
      for (const tarefa of tarefas) {
        if (enqueued >= maxTasks) {
          // Cap hit with tasks remaining: stop enqueueing entirely. The cursor
          // does NOT advance — the position is PERSISTED and the next tick of
          // any tier resumes this same frozen window right here.
          truncated = true;
          log.warn(
            '[shopee/estoque] varredura TRUNCADA — limite de tasks atingido ' +
              '(cursor não avança; a posição é persistida e o próximo tick retoma a mesma janela)',
            { integracaoId, modo, sweepId, enqueued, maxTasks, pages },
          );
          break;
        }
        // No delay: sweep-discovered stock is settled data.
        await args.scheduler.enqueue(tarefa);
        enqueued += 1;
      }
      if (truncated) break;
      ultimoAnchorCompleto = row.anchorId;
    }
    if (truncated) break;

    if (pagina.nextAfterAnchorId === null) break; // backlog drained
    afterAnchorId = pagina.nextAfterAnchorId;
    if (pages >= MAX_PAGES_PER_SWEEP) {
      truncated = true;
      log.warn(
        '[shopee/estoque] varredura TRUNCADA — backlog restante após o cap de páginas ' +
          '(cursor não avança; a posição é persistida e o próximo tick retoma a mesma janela)',
        { integracaoId, modo, sweepId, pages, enqueued },
      );
      break;
    }
  }

  // (d) Close the tick with exactly one stamp.
  //
  // ⚠️ The resume point falls back to the PAGE cursor when no family completed
  // on this page: re-running that page is harmless (every quantity is
  // recomputed at the next sweep's own time), while dropping the position is
  // how a conta with a standing backlog never reaches its tail.
  const retomarDe = truncated ? (ultimoAnchorCompleto ?? afterAnchorId) : null;
  if (truncated && retomarDe !== null) {
    const nova: ContinuacaoLida = {
      afterAnchorId: retomarDe,
      changedSinceMs,
      modo,
      movimentosDesdeMs,
      startedAtMs,
    };
    await carimbarVarredura(db, integracaoId, {
      tipo: CARIMBO_VARREDURA.truncada,
      continuacao: nova,
      nowMs,
    });
  } else if (truncated) {
    // The cap hit before ANY anchor completed on page 1 of a fresh sweep: a
    // SINGLE family already exceeds the task cap, so there is no position to
    // freeze and writing an empty one would store a continuation that reads
    // back as absent. Nothing is stamped — the next tick re-derives this window
    // and retries it, and raising the cap is the only way out.
    log.error(
      '[shopee/estoque] varredura TRUNCADA sem posição de retomada — a primeira família já ' +
        'estoura o cap de tasks; nada foi carimbado e o próximo tick repete esta janela',
      { integracaoId, modo, sweepId, enqueued, maxTasks },
    );
  } else if (modo === MODO_VARREDURA_ESTOQUE.incremental) {
    await carimbarVarredura(db, integracaoId, {
      tipo: CARIMBO_VARREDURA.incrementalDrenada,
      startedAtMs,
      nowMs,
    });
  } else if (modo === MODO_VARREDURA_ESTOQUE.diario) {
    await carimbarVarredura(db, integracaoId, { tipo: CARIMBO_VARREDURA.diarioDrenado, nowMs });
  } else {
    await carimbarVarredura(db, integracaoId, {
      tipo: CARIMBO_VARREDURA.reconciliacaoDrenada,
      nowMs,
    });
  }

  if (pulosPorMotivo.size > 0) {
    log.info('[shopee/estoque] anúncios não enviados, por motivo', {
      integracaoId,
      modo,
      sweepId,
      pulos: Object.fromEntries(pulosPorMotivo),
    });
  }

  return { enqueued, skipped, inalterados, pages, truncated };
}

/* -------------------------------------------------------------------------- */
/*                                 THE TICK                                   */
/* -------------------------------------------------------------------------- */

/**
 * The whole sweep tick: the valve, every ACTIVE Shopee conta, each one gated,
 * swept and failure-isolated, and one summary the wrapper logs.
 *
 * The valve is checked FIRST and NOTHING is read when it is closed — not the
 * integrações, not a state document, not Shopee.
 */
export async function runShopeeStockSweep(
  db: Firestore,
  modo: ModoVarreduraEstoque,
  deps: DepsDaVarreduraShopee,
): Promise<ResultadoDaVarreduraShopee> {
  const log = loggerDe(deps);
  if (!isShopeeStockSyncEnabled()) {
    log.info(
      `[shopee/estoque] varredura (${modo}) desabilitada (${SHOPEE_STOCK_SYNC_FLAG_ENV} != '1') — nada a fazer`,
    );
    return { enabled: false, contas: [] };
  }

  const { nowMs } = deps;
  const buscarFamilias = deps.buscarFamilias ?? buscarFamiliasShopee;
  const buscarMovimentos = deps.buscarMovimentos ?? buscarMovimentosDaJanela;
  const avaliarConta = deps.avaliarConta ?? avaliarContaParaEstoque;

  // THE tick-wide memo, keyed `<desdeMs>|<depositoId>` and holding the in-flight
  // PROMISE rather than the resolved map: two contas on one depósito and window
  // — the common case, since the window comes from the same clock — share ONE
  // execution, and a tick where no conta needs a baseline runs ZERO of them.
  const memoDeMovimentos = new Map<string, Promise<MovimentosDaJanela>>();
  const obterMovimentos: ObterMovimentos = (desdeMs, depositoId) => {
    const chave = `${desdeMs}|${depositoId}`;
    const pendente = memoDeMovimentos.get(chave);
    if (pendente !== undefined) return pendente;
    const nova = buscarMovimentos(db, { desdeMs, depositoId });
    memoDeMovimentos.set(chave, nova);
    return nova;
  };

  const ativas = await listarContasShopeeAtivas(db);
  const contas: ResultadoDaContaShopee[] = [];

  for (const ativa of ativas) {
    const { integracaoId } = ativa;
    // Held outside the try so the containment arm can still read the pause
    // counter when the failure happened after the state was read.
    let estado: EstadoEstoqueLido | null = null;
    try {
      // ONE read per conta per tick: it feeds the pause gate, the stored
      // continuation and the window derivation alike.
      estado = await lerEstadoEstoque(db, integracaoId);

      // The pause gate. A paused conta is skipped WHOLE — no Shopee call, no
      // discovery, no enqueue — and NOTHING is written, so the next unpaused
      // tick finds the cursor and the continuation exactly where they were.
      if (estaPausada(estado, nowMs)) {
        log.info('[shopee/estoque] conta pausada — varredura pulada; nada avançou', {
          integracaoId,
          modo,
          pausadoAte: estado.pausadoAte,
          pausaMotivo: estado.pausaMotivo,
        });
        contas.push({ ...contaVazia(integracaoId), paused: true });
        continue;
      }

      // The depósito ref is read through the CACHED conta reader — the same
      // document several surfaces in this tick already want — and narrowed
      // here rather than trusted: only this one field is needed, and the gate
      // below is what turns a blank one into a rendered refusal.
      const conta = await readConta(db, integracaoId);
      const refBruto: unknown = conta?.depositoOuterRef;
      const depositoOuterRef =
        typeof refBruto === 'string' && refBruto.trim() !== '' ? refBruto : null;

      // ONE gate evaluation per conta per tick, BEFORE discovery. `{ok: true}`
      // means "ask Shopee about this conta", never "Shopee will accept" — the
      // sender's error ladder is the correctness, these gates are the
      // optimisation. Nothing here re-checks any of its rungs.
      const veredito = await avaliarConta(
        db,
        { integracaoId, shopId: ativa.shopId, depositoOuterRef },
        { clientFor: deps.clientFor, nowMs },
      );
      if (!veredito.ok) {
        // `sem-shop-id` is COUNTED and never written: a conta consented by the
        // main account has nothing shop-signed to do and will report the same
        // thing every quarter-hour for ever.
        if (veredito.motivo !== MOTIVO_ESTOQUE_SHOPEE.semShopId) {
          await registrarMotivoDaConta(db, integracaoId, veredito.motivo, nowMs);
        }
        log.info('[shopee/estoque] conta não envia estoque — nada enfileirado', {
          integracaoId,
          modo,
          motivo: veredito.motivo,
        });
        contas.push({ ...contaVazia(integracaoId), motivoConta: veredito.motivo });
        continue;
      }

      // Past the gate the ref is non-blank; an id it cannot yield is a
      // different fact from a blank ref and the gate cannot see it, so it is
      // decided here and reported under the same slug an operator already
      // understands.
      const depositoId = depositoOuterRef === null ? '' : idFromRef(depositoOuterRef);
      if (depositoId === '') {
        await registrarMotivoDaConta(db, integracaoId, MOTIVO_ESTOQUE_SHOPEE.semDeposito, nowMs);
        log.warn('[shopee/estoque] depósito da conta não resolve um id — nada enfileirado', {
          integracaoId,
          modo,
        });
        contas.push({
          ...contaVazia(integracaoId),
          motivoConta: MOTIVO_ESTOQUE_SHOPEE.semDeposito,
        });
        continue;
      }

      const parcial = await varrerConta({
        db,
        integracaoId,
        depositoId,
        estado,
        modoDoTick: modo,
        nowMs,
        buscarFamilias,
        obterMovimentos,
        scheduler: deps.scheduler,
        log,
      });
      contas.push({ ...contaVazia(integracaoId), ...parcial });
    } catch (err) {
      // ⚠️ The ONE hole in the boundary, and it is deliberate (C-m): the stock
      // tasks valve is a DEPLOYMENT state, not a conta state. A tick that
      // cannot enqueue has not done its job, and containing this would report
      // one broken deploy as N identical per-conta strings under a green tick.
      if (err instanceof ShopeeStockTasksDisabledError) throw err;
      // Narrow the derived class FIRST — it extends the API error the boundary
      // contains, so the containment arm below would swallow it and the conta
      // would keep being hammered every quarter-hour.
      if (err instanceof ShopeeRateLimitError) {
        await armarPausaDoLimite(db, integracaoId, err, estado?.pauseCount ?? 0, nowMs, log);
      }
      if (!erroContidoPorConta(err)) throw err;
      log.error('[shopee/estoque] conta contida — cursor NÃO avançado', {
        integracaoId,
        modo,
        erro: err.message,
      });
      await tolerarFalhaSecundaria(
        () => registrarErroDaConta(db, integracaoId, err.message, nowMs),
        log,
        { integracaoId, operacao: 'registrarErroDaConta' },
      );
      contas.push({ ...contaVazia(integracaoId), error: err.message });
    }
  }

  log.info('[shopee/estoque] varredura concluída', {
    modo,
    contas: contas.length,
    enqueued: somar(contas, (c) => c.enqueued),
    skipped: somar(contas, (c) => c.skipped),
    inalterados: somar(contas, (c) => c.inalterados),
    pages: somar(contas, (c) => c.pages),
    truncadas: contas.filter((c) => c.truncated).length,
    pausadas: contas.filter((c) => c.paused).length,
    portoes: contas.filter((c) => c.motivoConta !== null).length,
    comErro: contas.filter((c) => c.error !== null).length,
  });

  return { enabled: true, contas };
}

function somar(
  contas: readonly ResultadoDaContaShopee[],
  ler: (c: ResultadoDaContaShopee) => number,
): number {
  return contas.reduce((total, c) => total + ler(c), 0);
}
