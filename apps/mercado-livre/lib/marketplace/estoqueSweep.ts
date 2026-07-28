/**
 * Flag-gated Mercado Livre **stock sweeps** (Step 10 PR C) — the core behind
 * the 15-minute incremental and the 2AM daily `onSchedule` ticks. Per active
 * conta it runs THE produtos-first joined query
 * (`estoquePlan.fetchStockFamilies`) page by page, computes every family
 * member's quantity AT SWEEP TIME (`quantidadesDaFamilia`), applies the
 * incremental activity filter (`deveEnviarIncremental` — the daily sweep sends
 * ALL surviving families), and enqueues the resulting `buildSendTasks` drafts
 * onto the `sendMercadoLivreStock` queue. The task payload CARRIES the
 * quantities — the send handler transmits them verbatim (estoqueSend.ts).
 *
 * Flag-gated OFF: runs ONLY when `MERCADO_LIVRE_STOCK_SYNC_ENABLED === '1'`
 * (`isStockSyncEnabled()`); until the flag flips the deployed functions tick,
 * log one info line and do nothing.
 *
 * ---- Durable state: ONE admin-only doc per conta at
 * `estoqueMercadoLivreSync/{integracaoId}` (µs fields — see the schema's
 * write-discipline doc). Window derivation is `janelaDoSweep` (pure, unit
 * tested): the incremental window starts at the stored `cursorUs` (capped by
 * `cursorMaxLookbackHours()`, defaulting to `incrementalWindowMin()` when the
 * conta has no cursor yet) minus the `windowOverlapSec()` slack (legacy
 * `interval+20s`); the daily window is a flat `dailyWindowHours()` lookback.
 * The daily sweep passes `vendaCutoffUs: null` — it sends everything, nothing
 * reads the sales flag, so the pedidos probe is skipped entirely (the plan's
 * decision).
 *
 * ---- Cursor discipline: after a conta's incremental pages + enqueues ALL
 * succeed the sweep merges `{ cursorUs: millisToMicros(nowMs), lastSweepAtUs,
 * lastError: null }`. The daily sweep merges `{ lastDailyAtUs, lastError: null }`
 * and NEVER touches `cursorUs`.
 *
 * ---- Truncation = PERSISTENT CONTINUATION (forward progress): a tick cut
 * short by the page cap or the task cap merges `{ continuacao }` — the frozen
 * window (`changedSinceMs`/`vendaCutoffUs`), the keyset position it stopped at
 * and the ORIGINAL sweep's `startedAtUs` — and does NOT advance `cursorUs`.
 * The NEXT tick RESUMES that stored position with the SAME frozen window and
 * the SAME filter mode (inferred from `vendaCutoffUs == null` ⇒ daily
 * semantics), doing ONLY the continuation: its own window's work waits one
 * tick, which is what keeps the caps meaningful (a tick is never two sweeps'
 * worth of pages). When the continuation finally drains, `continuacao` clears
 * and an incremental one advances `cursorUs` to `startedAtUs` — the frozen
 * window is covered exactly up to the original sweep's start. Without this a
 * conta whose backlog exceeds one tick's caps would restart page 1 of a
 * re-derived window forever and never reach its tail. The resume position is
 * the last anchor whose tasks were ALL enqueued, so a family cut mid-way is
 * re-processed rather than skipped (re-enqueues are harmless — the send is
 * verbatim and the next sweep converges).
 *
 * ---- 429 pause gate: the send handler stamps `pausedUntilUs` on the conta's
 * state doc when ML rate-limits it. A sweep tick that finds a live pause SKIPS
 * that conta whole — no ML probe, no discovery, no enqueue — and touches
 * neither `cursorUs` nor `continuacao`, so the next unpaused tick picks up
 * exactly where this one would have started.
 *
 * ---- Multiorigin guard (owner-locked detect+alarm): ML silently IGNORES
 * `PUT /items` stock on multiorigin accounts (`user.tags` containing
 * `warehouse_management` — stock lives per seller_warehouse there, support
 * tracked separately), so sending would "succeed" while doing nothing. The
 * sweep probes `GET /users/me` once per conta per tick and REFUSES the conta
 * loudly (lastError + console.error) instead of enqueueing sends ML would
 * drop on the floor.
 *
 * ---- Per-conta failure isolation: copied from `orderBackfill.ts` — the
 * per-conta catch CONTAINS the expected failure families (the
 * `MercadoLivreError` hierarchy, a mid-sweep
 * `MercadoLivreContaNotConfiguredError`, `MlTasksDisabledError`, and any
 * gRPC-coded transport error, integer `code` 1–16); a contained conta gets
 * `{ lastError, lastErrorAtUs }` merged WITHOUT advancing `cursorUs` (the next
 * tick retries the same window). Anything unclassifiable is a coding bug and
 * RETHROWS, failing the whole tick loudly.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { millisToMicros } from '@delfrance/core/datetime';
import { INTEGRACAO_TIPO, idFromRef } from '@delfrance/schemas';
import {
  type MercadoLivreApi,
  type MlUser,
  MercadoLivreError,
  createMercadoLivreApi,
} from '@delfrance/integrations-mercado-livre';
import {
  estoqueMercadoLivreSyncCollection,
  integracaoCollection,
} from '@delfrance/data/admin/collections';

import {
  ESTADOS_VENDA,
  type FetchStockFamilies,
  STOCK_SYNC_FLAG_ENV,
  atividadeLookbackDays,
  buildSendTasks,
  cursorMaxLookbackHours,
  dailyWindowHours,
  deveEnviarIncremental,
  fetchStockFamilies,
  incrementalWindowMin,
  isStockSyncEnabled,
  maxTasksPerSweep,
  quantidadesDaFamilia,
  windowOverlapSec,
} from './estoquePlan';
import type { MlStockTaskScheduler } from './mlStockTasks';
import { MlTasksDisabledError } from './mlTasks';
import { MercadoLivreContaNotConfiguredError, loadMercadoLivreContext } from './mercadoLivre';

/** Which of the two scheduled ticks is running (drives window + cursor rules). */
export type StockSweepMode = 'incremental' | 'daily';

/**
 * Page cap per conta per tick — bounds one tick's pipeline executions
 * (`orderBackfill.MAX_PAGES_PER_TICK` precedent). Hitting it with backlog
 * remaining truncates the sweep: loud warn, cursor NOT advanced, and the
 * keyset position is PERSISTED as `continuacao` so the next tick resumes the
 * same window right where this one stopped (module doc).
 */
export const MAX_PAGES_PER_SWEEP = 10;

/** The sweep's injectable dependencies — production defaults live in the FUNCTIONS wrapper. */
export interface StockSweepDeps {
  /** The stock-queue enqueue seam (`createMlStockTaskScheduler()` in prod). */
  scheduler: MlStockTaskScheduler;
  /** ONE clock read for the whole tick (`Date.now()` in prod, never re-read here). */
  nowMs: number;
  /** THE query seam — defaults to `fetchStockFamilies` (pipelines never run in tests). */
  fetchFamilies?: FetchStockFamilies;
  /** The multiorigin-guard probe seam — defaults to `api.getMe()` (`GET /users/me`). */
  getMe?: (api: MercadoLivreApi) => Promise<MlUser>;
}

/** Per-conta outcome of one sweep tick. */
export interface StockSweepContaResult {
  integracaoId: string;
  /** Send-task drafts enqueued onto the stock queue. */
  enqueued: number;
  /** Families dropped by the incremental filter + per-listing/member skips. */
  skipped: number;
  /** THE-query pages executed for this conta. */
  pages: number;
  /** `true` when the page cap or the task cap cut the sweep short. */
  truncated: boolean;
  /**
   * `true` when the conta was skipped whole because a 429 pause
   * (`pausedUntilUs`) is still in effect — nothing was read or enqueued and
   * neither `cursorUs` nor `continuacao` moved. `false` on every other path.
   */
  paused: boolean;
  /** The contained per-conta error message (`null` on success). */
  error: string | null;
}

/** Whole-tick summary (the `onSchedule` wrapper logs it). */
export interface StockSweepResult {
  /** `false` ⇒ the flag is off — nothing was read, nothing was enqueued. */
  enabled: boolean;
  contas: StockSweepContaResult[];
}

/** Recorded (and stamped) for a conta whose integração has no depósito configured. */
const SEM_DEPOSITO_ERROR = 'integração sem depósito — configure o depósito da conta';

/**
 * Recorded (and stamped) for a multiorigin conta — LOUD by design: ML silently
 * ignores `PUT /items` stock there, so a quiet skip would look like success.
 */
const MULTIORIGIN_ERROR =
  'conta multiorigem (warehouse_management) — o ML ignora estoque via PUT /items; ' +
  'suporte a seller_warehouse é rastreado separadamente';

/* --------------------------------- window ---------------------------------- */

/** The window `janelaDoSweep` derives — feeds `fetchStockFamilies` directly. */
export interface SweepJanela {
  /** Exclusive estoque-change window start (ms since epoch). */
  changedSinceMs: number;
  /** Sales-probe lower bound (µs) — null on the daily sweep (probe skipped). */
  vendaCutoffUs: number | null;
}

/**
 * PURE window derivation for one conta's tick. Incremental: window start =
 * the stored cursor (ms), floored by the `cursorMaxLookbackHours()` cap so a
 * long-stale cursor can't explode the window, or the flat
 * `incrementalWindowMin()` fallback when the conta has no cursor yet — minus
 * the `windowOverlapSec()` re-cover slack either way; the sales probe looks
 * back `atividadeLookbackDays()`. Daily: a flat `dailyWindowHours()` lookback
 * (same overlap) and NO sales probe (`vendaCutoffUs: null` — the daily sweep
 * sends everything, nothing reads the flag).
 */
export function janelaDoSweep(
  mode: StockSweepMode,
  nowMs: number,
  stateRaw: Record<string, unknown>,
): SweepJanela {
  const overlapMs = windowOverlapSec() * 1000;
  if (mode === 'daily') {
    return {
      changedSinceMs: nowMs - dailyWindowHours() * 3_600_000 - overlapMs,
      vendaCutoffUs: null,
    };
  }
  const cursorUs = finiteNumber(stateRaw.cursorUs);
  const changedSinceMs =
    cursorUs == null
      ? nowMs - incrementalWindowMin() * 60_000 - overlapMs
      : Math.max(Math.floor(cursorUs / 1000), nowMs - cursorMaxLookbackHours() * 3_600_000) -
        overlapMs;
  return {
    changedSinceMs,
    vendaCutoffUs: (nowMs - atividadeLookbackDays() * 86_400_000) * 1000,
  };
}

/* ------------------------------- continuation ------------------------------- */

/**
 * The stored `continuacao` of a truncated sweep (the schema field of the same
 * name): the FROZEN window plus the keyset position the next tick resumes from
 * and the original sweep's start.
 */
export interface SweepContinuacao {
  /** Keyset cursor — THE query resumes after this produto anchor id. */
  afterAnchorId: string;
  /** The frozen window start (ms since epoch). */
  changedSinceMs: number;
  /** The frozen sales-probe bound (µs) — null ⇒ daily semantics (probe skipped). */
  vendaCutoffUs: number | null;
  /** When the ORIGINAL (pre-truncation) sweep started (µs). */
  startedAtUs: number;
}

/**
 * Read the stored continuation DEFENSIVELY (raw `doc.data()` discipline): every
 * required key must be present and well-typed, `vendaCutoffUs` explicitly
 * `null` or a finite number — an absent key is NOT silently read as daily
 * semantics. Anything malformed yields `null`, and the tick simply runs its own
 * freshly derived window (overwriting the junk on its next state merge).
 */
function parseContinuacao(raw: unknown): SweepContinuacao | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const afterAnchorId =
    typeof o.afterAnchorId === 'string' && o.afterAnchorId !== '' ? o.afterAnchorId : null;
  const changedSinceMs = finiteNumber(o.changedSinceMs);
  const startedAtUs = finiteNumber(o.startedAtUs);
  const vendaOk = o.vendaCutoffUs === null || finiteNumber(o.vendaCutoffUs) != null;
  if (afterAnchorId == null || changedSinceMs == null || startedAtUs == null || !vendaOk) {
    return null;
  }
  return {
    afterAnchorId,
    changedSinceMs,
    vendaCutoffUs: o.vendaCutoffUs === null ? null : finiteNumber(o.vendaCutoffUs),
    startedAtUs,
  };
}

/* ------------------------------- containment -------------------------------- */

/**
 * Admin-SDK Firestore and Cloud Tasks enqueue transport failures surface as
 * `Error`s carrying a numeric gRPC status `code` (integers 1–16; 0 = OK never
 * rides an error) — same discriminant as `orderBackfill.ts`. Any other numeric
 * `code` is a coding bug and must NOT be contained.
 */
function isGrpcCodedError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' && Number.isInteger(code) && code >= 1 && code <= 16;
}

/**
 * The per-conta containment boundary (module doc): expected failure families
 * are contained and recorded on the conta's state doc; anything else is a
 * coding bug and must rethrow out of the sweep loop.
 */
function isPerContaContainable(err: unknown): err is Error {
  return (
    err instanceof MercadoLivreError ||
    err instanceof MercadoLivreContaNotConfiguredError ||
    err instanceof MlTasksDisabledError ||
    isGrpcCodedError(err)
  );
}

/**
 * Record a contained per-conta failure: `{ lastError, lastErrorAtUs }` merged
 * WITHOUT `cursorUs` (schema write discipline), so the next tick retries the
 * same window. A secondary failure while stamping is tolerated-but-logged when
 * itself classifiable (the `orderBackfill.recordContaError` discipline); an
 * unclassifiable one still rethrows.
 */
async function recordContaError(
  db: Firestore,
  integracaoId: string,
  nowUs: number,
  message: string,
): Promise<StockSweepContaResult> {
  console.error('[mercado-livre] stock-sweep: conta contida — cursor NÃO avançado', {
    integracaoId,
    error: message,
  });
  try {
    await estoqueMercadoLivreSyncCollection.merge(db, {}, integracaoId, {
      lastError: message,
      lastErrorAtUs: nowUs,
    });
  } catch (stampErr) {
    if (!isPerContaContainable(stampErr)) throw stampErr;
    console.error('[mercado-livre] stock-sweep: falha secundária ao registrar lastError', {
      integracaoId,
      cause: message,
      stampError: stampErr.message,
    });
  }
  return {
    integracaoId,
    enqueued: 0,
    skipped: 0,
    pages: 0,
    truncated: false,
    paused: false,
    error: message,
  };
}

/* ------------------------------ per-conta sweep ----------------------------- */

/**
 * Sweep ONE conta from its already-read state doc: RESUME a stored
 * `continuacao` (or derive a fresh window), page THE query (up to
 * `MAX_PAGES_PER_SWEEP`), filter + build + enqueue per family row, then merge
 * the state (continuation + cursor rules in the module doc). Throws on any
 * failure — the caller's containment boundary classifies it.
 */
async function sweepConta(
  db: Firestore,
  scheduler: MlStockTaskScheduler,
  fetchFamilies: FetchStockFamilies,
  mode: StockSweepMode,
  integracaoId: string,
  depositoId: string,
  stateRaw: Record<string, unknown>,
  nowMs: number,
  nowUs: number,
): Promise<Omit<StockSweepContaResult, 'error'>> {
  // (a) RESUME or derive. A stored `continuacao` freezes the truncated sweep's
  // window + keyset position, and this tick does ONLY that continuation — its
  // OWN window's work waits for the next tick, which is exactly what keeps the
  // caps meaningful (one tick is never two sweeps' worth of pages).
  const continuacao = parseContinuacao(stateRaw.continuacao);
  const { changedSinceMs, vendaCutoffUs } =
    continuacao == null
      ? janelaDoSweep(mode, nowMs, stateRaw)
      : { changedSinceMs: continuacao.changedSinceMs, vendaCutoffUs: continuacao.vendaCutoffUs };
  // A resumed sweep's filter mode comes from the FROZEN window, never from the
  // tick that picks it up: `vendaCutoffUs == null` means the pedidos probe was
  // skipped, so every row carries `temVenda30d: false` and the incremental
  // filter would wrongly drop the whole page — that window is daily-semantics.
  const filtroIncremental =
    continuacao == null ? mode === 'incremental' : continuacao.vendaCutoffUs != null;
  // The ORIGINAL sweep's start: what an incremental continuation advances
  // `cursorUs` to once it drains (the frozen window is covered up to THAT
  // instant, not up to the tick that happened to finish it).
  const startedAtUs = continuacao?.startedAtUs ?? millisToMicros(nowMs);

  // Deterministic sweep id (log correlation across sweep + send handler) —
  // never random: a retried tick with the same clock reproduces it. A resumed
  // sweep is tagged `-cont-` so its tasks are distinguishable in the logs.
  const sweepId =
    continuacao == null
      ? `${mode}-${integracaoId}-${nowMs}`
      : `${mode}-cont-${integracaoId}-${nowMs}`;
  const maxTasks = maxTasksPerSweep();

  let pages = 0;
  let enqueued = 0;
  let skipped = 0;
  let truncated = false;
  let afterAnchorId: string | null = continuacao?.afterAnchorId ?? null;
  // The last anchor whose drafts were ALL enqueued — the only safe resume
  // position: a family cut mid-way must be RE-processed, never skipped
  // (re-enqueues are harmless, the send is verbatim and the next sweep
  // converges; a skipped family would silently lose its remaining listings).
  let ultimoAnchorCompleto: string | null = null;

  // (b) Page loop — ONE pipeline execution per iteration, keyset-fed.
  for (;;) {
    const page = await fetchFamilies(db, {
      integracaoId,
      depositoId,
      changedSinceMs,
      vendaCutoffUs,
      estadosVenda: ESTADOS_VENDA,
      afterAnchorId,
    });
    pages += 1;

    for (const row of page.rows) {
      // (c) Quantities AT SWEEP TIME — the payload carries them verbatim.
      const quantidades = quantidadesDaFamilia(row);
      if (filtroIncremental && !deveEnviarIncremental(row, quantidades, nowMs)) {
        skipped += 1; // changed but inactive family — the daily sweep covers it
        ultimoAnchorCompleto = row.anchorId;
        continue;
      }
      const { tasks, skips } = buildSendTasks(row, quantidades, {
        integracaoId,
        sweepId,
        sweepComputedAtMs: nowMs,
      });
      skipped += skips.length;
      for (const task of tasks) {
        if (enqueued >= maxTasks) {
          // Task cap hit with drafts remaining: stop enqueueing entirely. The
          // cursor is NOT advanced — instead the keyset position is PERSISTED
          // as `continuacao` and the NEXT tick RESUMES this same window here.
          truncated = true;
          console.warn(
            '[mercado-livre] stock-sweep TRUNCADO — limite de tasks por sweep atingido ' +
              '(cursor não avança; a posição é PERSISTIDA em continuacao e o próximo ' +
              'sweep RETOMA daqui, na mesma janela)',
            {
              integracaoId,
              mode,
              sweepId,
              enqueued,
              maxTasks,
              pages,
              retomarDe: ultimoAnchorCompleto ?? afterAnchorId,
            },
          );
          break;
        }
        // No scheduleDelaySeconds: sweep-discovered stock is settled data.
        await scheduler.enqueue(task);
        enqueued += 1;
      }
      if (truncated) break;
      ultimoAnchorCompleto = row.anchorId;
    }
    if (truncated) break;

    if (page.nextAfterAnchorId == null) break; // backlog drained
    afterAnchorId = page.nextAfterAnchorId;
    if (pages >= MAX_PAGES_PER_SWEEP) {
      // Page cap hit with backlog remaining — same persistence as the task
      // cap: the position is frozen in `continuacao`, the cursor stays put.
      truncated = true;
      console.warn(
        '[mercado-livre] stock-sweep TRUNCADO — backlog restante após o cap de páginas ' +
          '(cursor não avança; a posição é PERSISTIDA em continuacao e o próximo ' +
          'sweep RETOMA daqui, na mesma janela)',
        { integracaoId, mode, sweepId, pages, enqueued, retomarDe: afterAnchorId },
      );
      break;
    }
  }

  // (d) State merge (schema write discipline — module doc).
  const retomarDe = truncated ? (ultimoAnchorCompleto ?? afterAnchorId) : null;
  let patch: Record<string, unknown>;
  if (truncated && retomarDe != null) {
    // Forward progress: freeze the window + the position. `cursorUs` is NOT
    // advanced — the window is only covered once the continuation drains.
    patch = {
      continuacao: { afterAnchorId: retomarDe, changedSinceMs, vendaCutoffUs, startedAtUs },
      lastError: null,
    };
  } else if (truncated) {
    // The cap hit before ANY anchor completed on page 1 of a fresh sweep:
    // there is no position to freeze (a SINGLE family already exceeds the task
    // cap), so nothing is persisted and the next tick re-derives this window
    // and retries it — raising the cap is the only way out.
    console.warn(
      '[mercado-livre] stock-sweep TRUNCADO sem posição de retomada — a primeira família já ' +
        'estoura o cap de tasks; aumente MERCADO_LIVRE_STOCK_MAX_TASKS_PER_SWEEP',
      { integracaoId, mode, sweepId, enqueued, maxTasks },
    );
    patch = { lastError: null };
  } else if (continuacao != null) {
    // The continuation DRAINED: the frozen window is now fully covered, up to
    // the ORIGINAL sweep's start. Clear it and stamp the mode's own field.
    patch = filtroIncremental
      ? { continuacao: null, cursorUs: startedAtUs, lastSweepAtUs: nowUs, lastError: null }
      : { continuacao: null, lastDailyAtUs: nowUs, lastError: null };
  } else {
    // A complete fresh sweep: the incremental cursor advances to `nowMs`; the
    // daily sweep stamps `lastDailyAtUs` and never touches the cursor. Both
    // clear `continuacao` defensively (nothing is left to resume).
    patch =
      mode === 'incremental'
        ? {
            cursorUs: millisToMicros(nowMs),
            lastSweepAtUs: nowUs,
            lastError: null,
            continuacao: null,
          }
        : { lastDailyAtUs: nowUs, lastError: null, continuacao: null };
  }
  await estoqueMercadoLivreSyncCollection.merge(db, {}, integracaoId, patch);

  return { integracaoId, enqueued, skipped, pages, truncated, paused: false };
}

/* -------------------------------- whole tick -------------------------------- */

/**
 * The whole sweep tick: enumerate every ACTIVE Mercado Livre `integracao`
 * (the exact `orderBackfill` enumeration — the `(tipo, ativo)` index exists),
 * guard each conta (depósito configured, not 429-paused, NOT multiorigin),
 * sweep it, all failure-isolated per conta. Returns the summary the wrapper
 * logs. The flag check comes first — off ⇒ NOTHING is read or enqueued.
 */
export async function runStockSweep(
  db: Firestore,
  mode: StockSweepMode,
  deps: StockSweepDeps,
): Promise<StockSweepResult> {
  if (!isStockSyncEnabled()) {
    console.info(
      `[mercado-livre] stock-sweep (${mode}) desabilitado (${STOCK_SYNC_FLAG_ENV} != '1') — no-op`,
    );
    return { enabled: false, contas: [] };
  }

  const nowMs = deps.nowMs;
  const nowUs = millisToMicros(nowMs);
  const fetchFamilies = deps.fetchFamilies ?? fetchStockFamilies;
  const getMe = deps.getMe ?? defaultGetMe;

  const snap = await integracaoCollection
    .ref(db, {})
    .where('tipo', '==', INTEGRACAO_TIPO.mercadoLivre)
    .where('ativo', '==', true)
    .get();

  const contas: StockSweepContaResult[] = [];
  for (const doc of snap.docs) {
    const integracaoId = doc.id;
    // Read the depósito ref raw off the enumerated doc (only this one field is
    // needed — a soft parseRead of every conta would warn-spam each tick on
    // legacy partial docs, the orderBackfill `user_id` precedent).
    const depositoRef = (doc.data() as Record<string, unknown>).depositoOuterRef;
    const depositoId =
      typeof depositoRef === 'string' && depositoRef !== '' ? idFromRef(depositoRef) : '';
    if (depositoId === '') {
      contas.push(await recordContaError(db, integracaoId, nowUs, SEM_DEPOSITO_ERROR));
      continue;
    }

    try {
      // State doc read ONCE per conta per tick — it feeds the 429 pause gate,
      // the stored continuation and the window derivation alike.
      const stateSnap = await estoqueMercadoLivreSyncCollection.docRef(db, {}, integracaoId).get();
      const stateRaw = (stateSnap.exists ? (stateSnap.data() ?? {}) : {}) as Record<
        string,
        unknown
      >;

      // 429 pause gate (module doc): while the pause the send handler stamped
      // is still live this conta is skipped WHOLE — no ML probe, no discovery,
      // no enqueue — and neither `cursorUs` nor `continuacao` is touched, so
      // the next unpaused tick resumes exactly where this one would have.
      const pausedUntilUs = finiteNumber(stateRaw.pausedUntilUs);
      if (pausedUntilUs != null && pausedUntilUs > nowUs) {
        const ate = new Date(Math.floor(pausedUntilUs / 1000)).toISOString();
        console.info(
          `[mercado-livre] stock-sweep: conta pausada por 429 até ${ate} — sweep pulado; cursor mantido`,
          { integracaoId, mode, pausedUntilUs },
        );
        contas.push({
          integracaoId,
          enqueued: 0,
          skipped: 0,
          pages: 0,
          truncated: false,
          paused: true,
          error: null,
        });
        continue;
      }

      // Multiorigin guard (module doc): probe `GET /users/me` BEFORE any
      // discovery — a `warehouse_management` conta gets a loud refusal, never
      // enqueued sends ML would silently drop.
      const ctx = await loadMercadoLivreContext(db, integracaoId);
      const channelCtx = await ctx.resolveChannelContext(nowMs);
      const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });
      const user = await getMe(api);
      if ((user.tags ?? []).includes('warehouse_management')) {
        console.error(
          '[mercado-livre] stock-sweep: conta multiorigem detectada — envio de estoque RECUSADO',
          { integracaoId, mode, userId: user.id },
        );
        contas.push(await recordContaError(db, integracaoId, nowUs, MULTIORIGIN_ERROR));
        continue;
      }

      const result = await sweepConta(
        db,
        deps.scheduler,
        fetchFamilies,
        mode,
        integracaoId,
        depositoId,
        stateRaw,
        nowMs,
        nowUs,
      );
      contas.push({ ...result, error: null });
    } catch (err) {
      // The deliberate per-conta containment boundary (module doc): expected
      // failure families are recorded + the loop continues; anything
      // unclassifiable is a coding bug and rethrows out of the sweep.
      if (!isPerContaContainable(err)) throw err;
      contas.push(await recordContaError(db, integracaoId, nowUs, err.message));
    }
  }

  return { enabled: true, contas };
}

/* --------------------------------- helpers ---------------------------------- */

/** The default multiorigin probe — one `GET /users/me` per conta per tick. */
async function defaultGetMe(api: MercadoLivreApi): Promise<MlUser> {
  return api.getMe();
}

/** Narrow a raw doc field to a finite number (tolerates legacy/missing data). */
function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
