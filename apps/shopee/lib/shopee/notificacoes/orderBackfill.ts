/**
 * The Shopee **order backfill** (master-plan step 4, #1512) — the 15-minute
 * safety net behind the push receiver.
 *
 * Shopee's push mechanism is at-most-once in practice: a push that exhausts its
 * retry ladder lands in the 3-day lost-push queue (the sibling sweep), and a
 * push missed while the subscription was SUSPENDED is never resent at all —
 * Shopee's own words, "You will not receive Push Mechanism notifications missed
 * during the period where your subscription was disabled". This sweep is the
 * only documented recovery for that case: it pages `get_order_list` by
 * `update_time` per active conta from a durable cursor and enqueues one
 * SYNTHETIC code-3 notification per `order_sn`, so a recovered order takes the
 * same import path a real push takes.
 *
 * ## ⚠️ It is DOUBLY gated, and the second gate flipped itself in step 5
 *
 * 1. `SHOPEE_ORDER_BACKFILL_ENABLED === '1'`, read at the use site as the FIRST
 *    statement — off ⇒ nothing is read, from Firestore or from Shopee.
 * 2. A **structural** guard: the sweep refuses while `destinoDoCodigo(3)` is
 *    still `'parado'`. Before step 5 a code 3 had no handler, so every
 *    synthesized push would have parked — a TERMINAL dead-letter row per order
 *    per tick, up to {@link MAX_PAGES_PER_TICK} × {@link PAGE_SIZE} of them per
 *    conta, 96 ticks a day. The guard reads the DISPATCH table rather than a
 *    literal, so step 5 flipped it with no change to this file — the flag is
 *    now the only gate an operator can touch.
 *
 * The two guard different mistakes: the flag is the operator's, the structural
 * one is the machine-checkable precondition.
 *
 * ## The window
 *
 * ONE window per conta per tick, `time_range_field: 'update_time'`:
 *
 *     from = cursorMs - OVERLAP_MS      (or nowMs - INITIAL_LOOKBACK_MS)
 *     to   = min(from + MAX_WINDOW_MS, nowMs)
 *
 * ⚠️ The 15-day maximum is measured from `from`, NEVER from the cursor:
 * `cursor + 15 d` plus the overlap exceeds Shopee's bound and comes back as
 * `order.order_list_invalid_time`. Both bounds are floored to seconds at the
 * package boundary.
 *
 * ⚠️ Flooring both does NOT only shrink the difference — it can GROW it by up
 * to 999 ms (`floor(a/1000) − floor(b/1000)` is
 * `(a − b + (b mod 1000) − (a mod 1000))/1000`). What keeps the package's
 * `≤ 15 d` assertion from ever tripping is the BOUND, not the direction: with
 * `ateMs − deMs ≤ MAX_WINDOW_MS`, the floored difference maximises at exactly
 * 1 296 000 s, and `assertOrderListParams` refuses on `>`, so the widened case
 * lands ON the bound and passes. (It matters that this reasoning be the true
 * one: a `ShopeeConfigError` from that assertion RETHROWS and costs every
 * remaining conta its tick.)
 *
 * At 15 days per window per 15-minute tick a conta closes 1 440 days of gap per
 * day, and with a 24-hour initial lookback the only way to be more than 15 days
 * behind is this function having been off for that long.
 *
 * ## Paging, and the advance rule
 *
 * ⚠️ Termination is `more === false`, NEVER the row count — the page's own
 * sample answers 10 rows for `page_size: 20` with `more: true` — and **an EMPTY
 * page with `more: true` keeps paging**, which is the explicit opposite of
 * `apps/mercado-livre`'s `missedFeedsSweep` rule. Do not port that one here by
 * analogy.
 *
 *  - **drained** ⇒ `cursorMs = max(stored, ateMs)` and the pending triple is
 *    cleared. The cursor advances to the WINDOW's upper bound, never to
 *    `nowMs`: `[ateMs, nowMs]` was never queried. (ML advances a drained window
 *    to `now` because its search is open-ended `from`-only; ours is not.)
 *  - **truncated** (the page cap) ⇒ NOTHING advances, and the opaque
 *    `next_cursor` is persisted together with the exact window it belongs to.
 *    Partial advance is inexpressible: `get_order_list` rows carry no timestamp
 *    at all, and the row ordering is undocumented, so neither a `max(update)`
 *    nor a position can resume. Without the pending cursor a conta whose window
 *    exceeds the cap would re-read the same first pages forever.
 *  - **`more: true` with no `next_cursor`** (a provider contradiction) ⇒
 *    treated as truncated, named in `lastError`, and NO pending cursor is
 *    stored. Advancing past a window we could not finish reading is the one
 *    outcome that loses orders silently.
 *
 * ## Writes and races (root rule 7 — tier 0)
 *
 * Exactly ONE `merge` per conta per tick, and this sweep is the cursor
 * document's only writer, so there is nothing to lose a race against and no
 * Firestore transaction anywhere in the module — nothing for the transaction
 * inventory to classify. (Said WITHOUT the API's identifier on purpose: that
 * guard greps every source file for the literal, and a comment-only mention
 * would demand an inventory line for a module that runs no transaction.)
 * Two overlapping ticks of the same schedule interleave to a
 * MONOTONE cursor (`Math.max` on the advance), so the worst case is re-covering
 * a window, never skipping one.
 *
 * ⚠️ Re-covering costs a REPEATED ENQUEUE, and nothing here deduplicates it
 * across ticks: the synthesized code 3 carries the tick's own clock, so
 * `docIdOf` differs per tick and the in-tick `Set` (keyed on `dedupKeyOf`)
 * collapses only what one tick found twice. Idempotence across ticks is
 * entirely step 5's obligation — its handler re-fetches `get_order_detail` and
 * watermarks on ITS `update_time`.
 *
 * ⚠️ An enqueue failure writes NO failure document. The cursor did not advance,
 * so the next tick re-enumerates the order anyway — and a `notificacoesShopee`
 * failure row would be re-driven by the reprocess sweep and then PARKED,
 * manufacturing the exact dead-letter row the structural guard exists to
 * prevent.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  backfillPedidosShopeeCollection,
  integracaoCollection,
} from '@delfrance/data/admin/collections';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import {
  SHOPEE_ORDER_LIST_MAX_WINDOW_SECONDS,
  ShopeeApiError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeSchemaError,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';

import { ShopeeCredencialInvalidaError } from '../core/credentialStore';
import { ShopeeContaNotConfiguredError, loadShopeeContext } from '../core/shopee';
import {
  ShopeeContaSemShopIdError,
  ShopeeRefreshEmAndamentoError,
  ShopeeSemCredencialError,
} from '../core/tokenStore';
import { ShopeeTasksDisabledError, type ShopeeTaskScheduler } from '../shopeeTasks';
import { dedupKeyOf, destinoDoCodigo } from './notificacao';
import { notificacaoSinteticaDePedido } from './notificacaoSintetica';

/** The master flag. Strict `=== '1'`: unset, blank and `true` all leave it OFF. */
export const SHOPEE_ORDER_BACKFILL_FLAG_ENV = 'SHOPEE_ORDER_BACKFILL_ENABLED';

const MS_POR_SEGUNDO = 1000;

/**
 * How far BEFORE the stored cursor each window starts.
 *
 * Shopee's `update_time` has 1-second resolution, our clock skews against
 * theirs, and an order updated DURING a tick can land just under `time_to`.
 * The band's cost is a repeated enqueue per tick, absorbed by step 5's own
 * watermark and by nothing else (see the module header).
 */
export const OVERLAP_MS = 5 * 60 * 1000;

/**
 * The first window of a conta that has never drained one.
 *
 * 24 hours, matching ML, for three reasons: this is a BACKSTOP for the push
 * stream and not an importer (a conta's first import is step 5/step 9); a
 * 15-day first window is exactly the case that truncates, so a fresh conta
 * would enter the most complex path on its least-tested day; and a conta has
 * just consented, so there is nothing older than the consent to recover.
 */
export const INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Shopee's documented maximum window, in MS — DERIVED from the package
 * constant rather than re-typed, so the bound lives once, on the side that
 * validates it.
 */
export const MAX_WINDOW_MS = SHOPEE_ORDER_LIST_MAX_WINDOW_SECONDS * MS_POR_SEGUNDO;

/**
 * Rows per `get_order_list` call. Shopee allows 100; faq 476's only published
 * guidance is "fewer orders per call, longer intervals" and this endpoint
 * publishes no rate limit at all, so 50 (ML's page size) is the conservative
 * side of an unmeasured bound.
 */
export const PAGE_SIZE = 50;

/**
 * 20 pages ⇒ 1 000 orders and 20 Shopee calls per conta per tick. Sized so the
 * steady state NEVER truncates: 15 minutes of updates on a BR shop is tens of
 * orders, which keeps truncation the anomaly the pending cursor exists for.
 */
export const MAX_PAGES_PER_TICK = 20;

export const MOTIVO_FLAG_DESLIGADA = 'flag-desligada';
export const MOTIVO_CODE3_PARADO = 'code 3 sem handler';
export const MOTIVO_SEM_SHOP_ID =
  'conta conectada por conta principal (sem shop_id) — nada a assinar';
export const MOTIVO_MORE_SEM_CURSOR = 'more=true sem next_cursor — janela não avançada';
export const MOTIVO_JANELA_DEGENERADA = 'janela menor que 1 s após o floor — nada a consultar';

export interface BackfillLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface OrderBackfillDeps {
  readonly scheduler: ShopeeTaskScheduler;
  /** ONE clock read for the whole tick, MILLISECONDS. Never re-read in here. */
  readonly nowMs: number;
  readonly logger?: BackfillLogger;
  /**
   * The client seam — ONE thing, because one thing is all the sweep needs from
   * a conta's context. Default: `loadShopeeContext(db, id).createShopClient()`.
   */
  readonly clientFor?: (db: Firestore, integracaoId: string) => Promise<ShopeeClient>;
}

export interface BackfillContaResult {
  readonly integracaoId: string;
  readonly shopId: number | null;
  /** `null` ⇒ processed; a named reason ⇒ skipped without any Shopee call. */
  readonly pulada: string | null;
  readonly janela: { deMs: number; ateMs: number } | null;
  readonly paginas: number;
  readonly ordersFound: number;
  readonly enqueued: number;
  readonly duplicadas: number;
  /** The tick replayed a window a previous tick could not finish. */
  readonly retomada: boolean;
  readonly drenada: boolean;
  readonly truncada: boolean;
  readonly error: string | null;
}

export interface OrderBackfillResult {
  readonly enabled: boolean;
  /** Why the tick did not run (`null` when it did). */
  readonly motivo: string | null;
  /** Active contas skipped for having no `shop_id` — counted, never written. */
  readonly semShopId: number;
  readonly contas: readonly BackfillContaResult[];
}

/**
 * Admin-SDK Firestore and Cloud Tasks enqueue failures surface as `Error`s
 * carrying a numeric gRPC status `code`. Narrowed to the actual status range
 * (integers 1–16; 0 = OK never rides an error) so a coding-bug `Error` that
 * happens to expose some other numeric `code` is NOT contained. Verbatim from
 * `conta/expiracaoSweep.ts`.
 */
function isGrpcCodedError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' && Number.isInteger(code) && code >= 1 && code <= 16;
}

/**
 * The per-conta containment boundary: an expected failure family is recorded on
 * the conta's cursor document and the loop moves on; anything else rethrows and
 * fails the tick loudly.
 *
 * ⚠️ It names the five classes, NOT the `ShopeeError` base — because
 * `ShopeeConfigError` extends that base and must RETHROW. A missing partner id
 * or key is OUR misconfiguration, and the execution that names the missing
 * binding is the one that has to fail (#778); containing it would turn a broken
 * deploy into N identical `lastError` strings and a green tick.
 * `conta/expiracaoSweep.ts` can safely catch the base class only because
 * nothing inside its loop can raise a config error.
 *
 * `ShopeeReauthRequiredError` and `ShopeeRateLimitError` extend
 * `ShopeeApiError`, so they are contained by that arm. Reauth is deliberately
 * NOT escalated into an aviso here: the dead-grant aviso has exactly one
 * producer (`avisos/autorizacao.ts`), and a second one would fork the row.
 *
 * `ShopeeContaSemShopIdError` cannot fire today — the raw `shop_id` guard
 * already skipped those contas — and it stays because the boundary names a
 * FAMILY, not today's call graph: a conta whose `shop_id` is cleared between
 * the enumeration and `loadShopeeContext` must not cost every other conta its
 * tick.
 *
 * ⚠️ The three CREDENTIAL classes are here for that same reason, and they are
 * the ones this sweep can actually raise: the client carries the token as a
 * FUNCTION, so `getOrRefreshAccessToken` runs INSIDE `client.getOrderList` —
 * inside this loop. `ShopeeRefreshEmAndamentoError` is another instance holding
 * the refresh lease past the poll budget (transient by construction, and the
 * route answers it 503 + Retry-After); `ShopeeSemCredencialError` and
 * `ShopeeCredencialInvalidaError` are per-conta STATES the conta route already
 * renders. All three are about ONE conta's grant, never about our deployment,
 * so each belongs on that conta's `lastError` rather than costing every other
 * conta its tick. `ShopeeConfigError` still rethrows: that one IS ours.
 */
function contidoPorConta(err: unknown): err is Error {
  return (
    err instanceof ShopeeApiError ||
    err instanceof ShopeeNetworkError ||
    err instanceof ShopeeHttpError ||
    err instanceof ShopeeSchemaError ||
    err instanceof ShopeeContaNotConfiguredError ||
    err instanceof ShopeeContaSemShopIdError ||
    err instanceof ShopeeSemCredencialError ||
    err instanceof ShopeeRefreshEmAndamentoError ||
    err instanceof ShopeeCredencialInvalidaError ||
    err instanceof ShopeeTasksDisabledError ||
    isGrpcCodedError(err)
  );
}

function loggerDe(deps: OrderBackfillDeps): BackfillLogger {
  return (
    deps.logger ?? {
      warn: (msg: string, meta?: Record<string, unknown>): void => {
        if (meta === undefined) console.warn(msg);
        else console.warn(msg, meta);
      },
    }
  );
}

function numericField(data: Record<string, unknown> | undefined, key: string): number | null {
  const v = data?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function textField(data: Record<string, unknown> | undefined, key: string): string | null {
  const v = data?.[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

/** A stored pending window is only usable with BOTH of its bounds. */
interface Pendencia {
  readonly cursor: string;
  readonly deMs: number;
  readonly ateMs: number;
}

function pendenciaValida(st: Record<string, unknown> | undefined): Pendencia | null {
  const cursor = textField(st, 'pendingCursor');
  const deMs = numericField(st, 'pendingWindowFromMs');
  const ateMs = numericField(st, 'pendingWindowToMs');
  if (cursor == null || deMs == null || ateMs == null) return null;
  return { cursor, deMs, ateMs };
}

async function clienteDaConta(
  db: Firestore,
  deps: OrderBackfillDeps,
  integracaoId: string,
): Promise<ShopeeClient> {
  if (deps.clientFor !== undefined) return deps.clientFor(db, integracaoId);
  // The documented chain, verbatim. `readConta` is a 15-minute cached reader,
  // so re-reading the conta the enumeration already fetched costs nothing and
  // keeps both guards `loadShopeeContext` performs.
  const ctx = await loadShopeeContext(db, integracaoId);
  return ctx.createShopClient();
}

interface VarreduraDaConta {
  readonly janela: { deMs: number; ateMs: number } | null;
  readonly pulada: string | null;
  readonly paginas: number;
  readonly ordersFound: number;
  readonly enqueued: number;
  readonly duplicadas: number;
  readonly retomada: boolean;
  readonly drenada: boolean;
  readonly truncada: boolean;
}

/** The cursor document, read once per conta per tick. */
async function lerEstado(
  db: Firestore,
  integracaoId: string,
): Promise<Record<string, unknown> | undefined> {
  const snap = await backfillPedidosShopeeCollection.docRef(db, {}, integracaoId).get();
  return snap.exists ? (snap.data() as Record<string, unknown> | undefined) : undefined;
}

async function varrerConta(
  db: Firestore,
  deps: OrderBackfillDeps,
  logger: BackfillLogger,
  integracaoId: string,
  shopId: number,
  st: Record<string, unknown> | undefined,
): Promise<VarreduraDaConta> {
  const cursorMs = numericField(st, 'cursorMs');
  const pendencia = pendenciaValida(st);

  // ⚠️ A pending window is REPLAYED verbatim, never recomputed: `nowMs` has
  // moved, and Shopee's cursor belongs to the window it was issued for.
  const deMs =
    pendencia?.deMs ??
    (cursorMs != null ? cursorMs - OVERLAP_MS : deps.nowMs - INITIAL_LOOKBACK_MS);
  const ateMs = pendencia?.ateMs ?? Math.min(deMs + MAX_WINDOW_MS, deps.nowMs);

  // ms → s ONCE, and floored on BOTH sides (see the module header).
  const timeFromS = Math.floor(deMs / MS_POR_SEGUNDO);
  const timeToS = Math.floor(ateMs / MS_POR_SEGUNDO);
  if (timeToS <= timeFromS) {
    // Reachable only with a clock that moved backwards or a cursor from the
    // future. Named here rather than handed to the package, whose
    // `ShopeeConfigError` would be a rethrow — and would read like a Shopee
    // problem if it were not.
    logger.warn('[shopee/backfill] janela degenerada — conta pulada', {
      integracaoId,
      deMs,
      ateMs,
    });
    return {
      janela: null,
      pulada: MOTIVO_JANELA_DEGENERADA,
      paginas: 0,
      ordersFound: 0,
      enqueued: 0,
      duplicadas: 0,
      retomada: pendencia != null,
      drenada: false,
      truncada: false,
    };
  }

  const client = await clienteDaConta(db, deps, integracaoId);

  let cursor: string | undefined = pendencia?.cursor;
  let paginas = 0;
  let ordersFound = 0;
  let enqueued = 0;
  let duplicadas = 0;
  let drenada = false;
  let truncada = false;
  let motivoTruncagem: string | null = null;
  let proximoCursor: string | null = null;
  // In-tick dedup on `dedupKeyOf` — the same order seen twice (the overlap, or
  // two pages) is ONE job.
  // ⚠️ Honest note: `docIdOf` would partition IDENTICALLY today, because
  // `nowMs` is one clock read for the whole tick and the carimbo is therefore
  // constant — no test can tell the two apart here. `dedupKeyOf` is still the
  // right name: it is the key that means "the same work", and it stays correct
  // the day a producer stamps per order instead of per tick.
  const vistos = new Set<string>();

  for (;;) {
    const page = await client.getOrderList({
      timeRangeField: 'update_time',
      timeFromS,
      timeToS,
      pageSize: PAGE_SIZE,
      // ⚠️ Spread-or-nothing: the FIRST page sends no `cursor` at all. The
      // package REFUSES a `''` rather than normalizing it away.
      ...(cursor === undefined ? {} : { cursor }),
      // ALWAYS — without it Shopee falls back to "old logic" and PENDING
      // orders never appear.
      requestOrderStatusPending: true,
      responseOptionalFields: 'order_status',
      // ⚠️ No `order_status` FILTER is available on purpose: Shopee's filter
      // omits PENDING/RETRY_SHIP/TO_CONFIRM_RECEIVE/TO_RETURN.
    });
    paginas += 1;

    for (const row of page.order_list) {
      ordersFound += 1;
      const payload = notificacaoSinteticaDePedido({
        shopId,
        orderSn: row.order_sn,
        nowMs: deps.nowMs,
        origem: 'backfill',
        ...(row.order_status == null ? {} : { orderStatus: row.order_status }),
      });
      const chave = dedupKeyOf(payload);
      if (chave != null && vistos.has(chave)) {
        duplicadas += 1;
        continue;
      }
      if (chave != null) vistos.add(chave);
      await deps.scheduler.enqueue(payload);
      enqueued += 1;
    }

    if (!page.more) {
      drenada = true;
      break;
    }
    const proximo = page.next_cursor;
    if (proximo == null || proximo === '') {
      // Shopee contradicted itself. Replaying the window next tick is loud and
      // lossless; advancing past it is the one silent loss.
      truncada = true;
      motivoTruncagem = MOTIVO_MORE_SEM_CURSOR;
      logger.warn('[shopee/backfill] more=true sem next_cursor — janela será relida', {
        integracaoId,
        paginas,
      });
      break;
    }
    cursor = proximo;
    if (paginas >= MAX_PAGES_PER_TICK) {
      truncada = true;
      proximoCursor = proximo;
      break;
    }
  }

  const patch: Record<string, unknown> = { lastSweepAtMs: deps.nowMs, lastError: motivoTruncagem };
  if (drenada) {
    // Monotone by construction: two overlapping ticks can only re-cover.
    patch.cursorMs = cursorMs == null ? ateMs : Math.max(cursorMs, ateMs);
    patch.pendingCursor = null;
    patch.pendingWindowFromMs = null;
    patch.pendingWindowToMs = null;
  } else if (proximoCursor != null) {
    patch.pendingCursor = proximoCursor;
    patch.pendingWindowFromMs = deMs;
    patch.pendingWindowToMs = ateMs;
  }
  await backfillPedidosShopeeCollection.merge(db, {}, integracaoId, patch);

  return {
    janela: { deMs, ateMs },
    pulada: null,
    paginas,
    ordersFound,
    enqueued,
    duplicadas,
    retomada: pendencia != null,
    drenada,
    truncada,
  };
}

/**
 * Record a contained per-conta failure: `lastSweepAtMs` + `lastError`, and
 * NEITHER the cursor nor (in general) the pending triple.
 *
 * ⚠️ ONE narrow exception, keyed on the class: a conta that was RESUMING and
 * failed with a `ShopeeApiError` has had Shopee look at our stored cursor and
 * refuse it, so the pending triple is cleared and the next tick restarts the
 * window from page 1. A network/HTTP/schema failure PRESERVES it — we never got
 * an opinion about the cursor, and dropping a good cursor on every tick of a
 * Shopee outage is how a truncated conta starves.
 */
async function registrarErro(
  db: Firestore,
  logger: BackfillLogger,
  integracaoId: string,
  nowMs: number,
  err: Error,
  retomada: boolean,
): Promise<void> {
  logger.warn('[shopee/backfill] conta contida após falha — cursor NÃO avançado', {
    integracaoId,
    erro: err.message,
  });
  const patch: Record<string, unknown> = { lastSweepAtMs: nowMs, lastError: err.message };
  if (retomada && err instanceof ShopeeApiError) {
    patch.pendingCursor = null;
    patch.pendingWindowFromMs = null;
    patch.pendingWindowToMs = null;
  }
  await backfillPedidosShopeeCollection.merge(db, {}, integracaoId, patch);
}

/**
 * One tick: both gates, then every ACTIVE Shopee integração, failure-isolated
 * per conta.
 */
export async function runShopeeOrderBackfill(
  db: Firestore,
  deps: OrderBackfillDeps,
): Promise<OrderBackfillResult> {
  // (1) The master flag, FIRST — off ⇒ nothing is read at all.
  if (process.env[SHOPEE_ORDER_BACKFILL_FLAG_ENV] !== '1') {
    return { enabled: false, motivo: MOTIVO_FLAG_DESLIGADA, semShopId: 0, contas: [] };
  }

  // (2) The structural gate. It reads the dispatch table, so it flips itself
  // when step 5 gives code 3 a handler — and the test that pins it says so.
  if (destinoDoCodigo(3) === 'parado') {
    return { enabled: false, motivo: MOTIVO_CODE3_PARADO, semShopId: 0, contas: [] };
  }

  const logger = loggerDe(deps);
  // The `(tipo, ativo)` composite already exists in `firestore.indexes.json`
  // (root rule 1: an unindexed query does not throw on Enterprise, it
  // full-scans and bills the scan).
  const snap = await integracaoCollection
    .ref(db, {})
    .where('tipo', '==', INTEGRACAO_TIPO.shopee)
    .where('ativo', '==', true)
    .get();

  const contas: BackfillContaResult[] = [];
  let semShopId = 0;

  for (const doc of snap.docs) {
    const integracaoId = doc.id;
    // Read RAW off the enumerated document: only this one field is needed, and
    // a soft `parseRead` of every conta would warn-spam each tick on legacy
    // partial documents.
    const shopId = numericField(doc.data() as Record<string, unknown>, 'shop_id');
    if (shopId == null) {
      // A main-account-only conta is a DOCUMENTED, renderable state in this
      // channel (the conta route answers 200 `connected: false`), not a
      // failure: it is counted and named, and NOTHING is written — 96 rows a
      // day of "this is fine" would be noise on a cursor doc that can never
      // get a cursor.
      semShopId += 1;
      contas.push({
        integracaoId,
        shopId: null,
        pulada: MOTIVO_SEM_SHOP_ID,
        janela: null,
        paginas: 0,
        ordersFound: 0,
        enqueued: 0,
        duplicadas: 0,
        retomada: false,
        drenada: false,
        truncada: false,
        error: null,
      });
      continue;
    }

    // Read the cursor document HERE, outside `varrerConta`, so the failure
    // branch knows whether this conta was resuming without a second read.
    let retomada = false;
    try {
      const st = await lerEstado(db, integracaoId);
      retomada = pendenciaValida(st) != null;
      const r = await varrerConta(db, deps, logger, integracaoId, shopId, st);
      contas.push({ integracaoId, shopId, ...r, error: null });
    } catch (err) {
      // The per-conta containment boundary (see `contidoPorConta`): one conta's
      // Shopee or Firestore failure must not cost every other conta its tick;
      // anything unclassifiable is a coding bug and fails the tick loudly.
      if (!contidoPorConta(err)) throw err;
      await registrarErro(db, logger, integracaoId, deps.nowMs, err, retomada);
      contas.push({
        integracaoId,
        shopId,
        pulada: null,
        janela: null,
        paginas: 0,
        ordersFound: 0,
        enqueued: 0,
        duplicadas: 0,
        retomada,
        drenada: false,
        truncada: false,
        error: err.message,
      });
    }
  }

  return { enabled: true, motivo: null, semShopId, contas };
}
