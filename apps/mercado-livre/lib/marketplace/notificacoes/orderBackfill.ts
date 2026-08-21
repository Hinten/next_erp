/**
 * Flag-gated Mercado Livre **order backfill sweep** (Step 9 PR 4, #360) — the
 * core behind the `importMercadoLivreOrders` 15-minute `onSchedule` backstop.
 * Discovers ML orders created/updated since the last sweep and drives every one
 * of them through the EXISTING notification import pipeline by enqueuing a
 * SYNTHETIC `orders_v2` notification per order onto the
 * `processMercadoLivreNotification` queue. The legacy Flutter backend had NO
 * such backfill — this is an approved architecture upgrade (#360), covering the
 * webhook-cutover gap window and any notification ML drops.
 *
 * Flag-gated OFF: the sweep runs ONLY when
 * `MERCADO_LIVRE_ORDER_BACKFILL_ENABLED === '1'` (mirrors
 * `MERCADO_LIVRE_TASKS_DISABLED` in `mlTasks.ts`). Until the flag is flipped
 * the deployed function ticks, logs one info line and does nothing.
 *
 * ---- Durable cursor: ONE admin-only doc per conta at
 * `backfillPedidosMercadoLivre/{integracaoId}` (top-level, NOT in
 * `ALL_DOMAINS` — no client access, no generated rules block; mirrors the
 * `importacoesMercadoLivre` job-doc precedent). `cursorUs` is the high-water
 * mark of `order.date_last_updated` (µs since epoch — project standard;
 * converted to ISO only at the ML API boundary) already covered by a completed
 * sweep. Each tick re-covers `OVERLAP_US` behind the cursor: clock skew between
 * our clock and ML's, plus the race between a sweep and an order updated during
 * it, could otherwise lose an order — re-imports are harmless because the
 * order import is idempotent and staleness-gated, so duplicates converge. A
 * conta with no cursor yet starts `INITIAL_LOOKBACK_US` (24h) back, sized to
 * cover the callback-cutover gap window.
 *
 * ---- Bounded pages per tick: at most `MAX_PAGES_PER_TICK` pages of
 * `PAGE_LIMIT` orders per conta per tick. When the cap is hit with backlog
 * remaining, the cursor STILL advances to the max `date_last_updated` fetched
 * so far and a LOUD `console.warn` fires. This is a BOUNDED-RISK heuristic,
 * not a guarantee: ML's `sort=date_asc` orders by `date_created`, not by
 * `date_last_updated`, so an unfetched page could in principle hold an order
 * whose `date_last_updated` is below the advanced cursor. The risk needs >
 * `MAX_PAGES_PER_TICK × PAGE_LIMIT` orders changed in one window (far beyond
 * this store's volume), fires the warn when it becomes possible, is softened
 * by the 5-minute overlap, and the webhook path — the PRIMARY mechanism this
 * sweep merely backstops — still delivers any skipped order's next event. A
 * truncated tick is a capacity signal, not a correctness problem.
 *
 * ---- Per-conta failure isolation (the deliberate containment boundary, like
 * the mass-import per-item containment): one conta's failure must never starve
 * the others, so the per-conta catch CONTAINS the *expected* failure families —
 * the `MercadoLivreError` hierarchy (HTTP/network/validation/reauth), a
 * mid-sweep `MercadoLivreContaNotConfiguredError` (conta deleted/retyped
 * between enumeration and processing), `MlTasksDisabledError` plus any
 * gRPC-coded transport error from the enqueue, and Admin-SDK Firestore errors
 * (both surface as `Error`s carrying a numeric gRPC status `code` — the same
 * discriminant family as `@delfrance/data/admin`'s gRPC helpers). The contained conta gets
 * `{ lastSweepAtUs, lastError }` merged WITHOUT advancing `cursorUs`, so the
 * next tick retries the same window. Anything unclassifiable is a coding bug
 * and RETHROWS — failing the whole tick loudly instead of burying it in a
 * per-conta error entry.
 *
 * ---- No `scheduleDelaySeconds` on the synthetic notifications: the webhook
 * route delays order-family topics 10s because ML is eventually consistent on
 * FRESH events; backfilled orders are settled, so the delay would only slow
 * the drain. The queue's rateLimits/retries/parking plus the idempotent,
 * staleness-gated import make duplicate/overlapping enqueues harmless.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { coerceToMicros, millisToMicros } from '@delfrance/core/datetime';
import { INTEGRACAO_TIPO, type Integracao } from '@delfrance/schemas';
import { MercadoLivreError, createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';
import {
  backfillPedidosMercadoLivreCollection,
  integracaoCollection,
} from '@delfrance/data/admin/collections';

import { type MlTaskScheduler, MlTasksDisabledError } from './mlTasks';
import {
  MercadoLivreContaNotConfiguredError,
  buildMercadoLivreContext,
} from '../core/mercadoLivre';
import type { MlNotificationPayload } from './notificacao';

/** The env flag gating the sweep — runs ONLY when it is exactly `'1'`. */
export const ORDER_BACKFILL_FLAG_ENV = 'MERCADO_LIVRE_ORDER_BACKFILL_ENABLED';

/**
 * Re-covered window behind the stored cursor (µs): absorbs clock skew between
 * our clock and ML's `date_last_updated`, and the sweep-vs-update race. Safe to
 * re-cover because imports are idempotent + staleness-gated (they converge).
 */
export const OVERLAP_US = 5 * 60 * 1_000_000;

/**
 * First-sweep lookback for a conta with no cursor doc yet (µs): 24h, sized to
 * cover the webhook callback-cutover gap window (#360).
 */
export const INITIAL_LOOKBACK_US = 24 * 60 * 60 * 1_000_000;

/** `GET /orders/search` page size. */
export const PAGE_LIMIT = 50;

/**
 * Page cap per conta per tick — bounds one tick's ML API usage. Hitting it
 * with backlog remaining truncates the sweep (loud warn; the cursor still
 * advances over what WAS fetched — see the module doc's bounded-risk note).
 */
export const MAX_PAGES_PER_TICK = 10;

/** The sweep's injectable dependencies — production defaults live in the FUNCTIONS wrapper. */
export interface OrderBackfillDeps {
  /** The notification-queue enqueue seam (`createMlTaskScheduler()` in prod). */
  scheduler: MlTaskScheduler;
  /** ONE clock read for the whole tick (`Date.now()` in prod, never re-read here). */
  nowMs: number;
}

/** Per-conta outcome of one sweep tick. */
export interface BackfillContaResult {
  integracaoId: string;
  /** Orders returned by the paged search (each one was enqueued unless the conta errored). */
  ordersFound: number;
  /** Synthetic `orders_v2` notifications enqueued onto the processing queue. */
  enqueued: number;
  /** `true` when `MAX_PAGES_PER_TICK` was hit with backlog remaining. */
  truncated: boolean;
  /** The contained per-conta error message (`null` on success). */
  error: string | null;
}

/** Whole-tick summary (the `onSchedule` wrapper logs it). */
export interface BackfillSweepResult {
  /** `false` ⇒ the flag is off — nothing was read, nothing was enqueued. */
  enabled: boolean;
  contas: BackfillContaResult[];
}

/** Recorded (and stamped) for an active conta missing the denormalized ML seller id. */
const SEM_USER_ID_ERROR = 'integração sem user_id — reconecte a conta';

/** Narrow a raw doc field to a finite number (tolerates legacy/missing data). */
function numericField(data: Record<string, unknown> | undefined, key: string): number | null {
  const v = data?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Admin-SDK Firestore and Cloud Tasks enqueue transport failures surface as
 * `Error`s carrying a numeric gRPC status `code` — the same discriminant
 * family `@delfrance/data/admin` uses for ALREADY_EXISTS/NOT_FOUND. Narrowed to the
 * actual gRPC status range (integers 1–16; 0 = OK never rides an error): a
 * coding-bug `Error` that happens to expose some other numeric `code` must NOT
 * be contained — it has to fail the tick loudly (the whole point of the
 * containment boundary's rethrow arm).
 */
function isGrpcCodedError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' && Number.isInteger(code) && code >= 1 && code <= 16;
}

/**
 * The per-conta containment boundary (see the module doc): the expected
 * failure families are contained and recorded on the conta's cursor doc;
 * anything else is a coding bug and must rethrow out of the sweep loop.
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
 * Record a contained per-conta failure: `lastSweepAtUs` + `lastError` are
 * merged WITHOUT `cursorUs`, so the next tick retries the same window. A
 * secondary failure while stamping (a correlated Firestore outage) is
 * tolerated-but-logged when it is itself classifiable (mirrors the
 * final-attempt persist tolerance in `notificacao.ts`/`massImport.ts`);
 * an unclassifiable one still rethrows.
 */
async function recordContaError(
  db: Firestore,
  integracaoId: string,
  nowUs: number,
  message: string,
): Promise<BackfillContaResult> {
  console.error('[mercado-livre] order-backfill: conta contida — cursor NÃO avançado', {
    integracaoId,
    error: message,
  });
  try {
    await backfillPedidosMercadoLivreCollection.merge(db, {}, integracaoId, {
      lastSweepAtUs: nowUs,
      lastError: message,
    });
  } catch (stampErr) {
    if (!isPerContaContainable(stampErr)) throw stampErr;
    console.error('[mercado-livre] order-backfill: falha secundária ao registrar lastError', {
      integracaoId,
      cause: message,
      stampError: stampErr.message,
    });
  }
  return { integracaoId, ordersFound: 0, enqueued: 0, truncated: false, error: message };
}

/**
 * Sweep ONE conta: read its cursor, page `GET /orders/search` from the
 * computed window start (`date_asc`), enqueue a synthetic `orders_v2`
 * notification per order, then advance the cursor. Throws on any failure —
 * the caller's containment boundary classifies it.
 */
async function sweepConta(
  db: Firestore,
  scheduler: MlTaskScheduler,
  integracaoId: string,
  userId: number,
  conta: Integracao,
  nowMs: number,
  nowUs: number,
): Promise<Omit<BackfillContaResult, 'error'>> {
  // (a) Durable cursor → window start. `cursorUs - OVERLAP_US` re-covers the
  // skew/race window; a cursor-less conta starts 24h back (see module doc).
  const cursorSnap = await backfillPedidosMercadoLivreCollection.docRef(db, {}, integracaoId).get();
  const cursorUs = numericField(cursorSnap.exists ? cursorSnap.data() : undefined, 'cursorUs');
  const fromUs = cursorUs != null ? cursorUs - OVERLAP_US : nowUs - INITIAL_LOOKBACK_US;
  // µs → ISO only at the ML API boundary (project standard keeps µs elsewhere).
  const isoFrom = new Date(Math.floor(fromUs / 1000)).toISOString();

  // (b) Account context → live ML API (exact chain from `runOrderImport`), built
  // from the conta the enumeration already fetched rather than re-reading it.
  const ctx = buildMercadoLivreContext(db, integracaoId, conta);
  const channelCtx = await ctx.resolveChannelContext();
  const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

  // (c) Page through the window, oldest-first, enqueuing every order.
  let offset = 0;
  let pages = 0;
  let ordersFound = 0;
  let enqueued = 0;
  let truncated = false;
  let maxLastUpdatedUs: number | null = null;

  for (;;) {
    const page = await api.searchOrders({
      seller: userId,
      'order.date_last_updated.from': isoFrom,
      sort: 'date_asc',
      limit: PAGE_LIMIT,
      offset,
    });
    pages += 1;
    const results = page.results ?? [];
    if (results.length === 0) break; // backlog drained

    ordersFound += results.length;
    for (const order of results) {
      // (d) Synthetic notification — must satisfy `mlNotificationTaskSchema`.
      // NO `scheduleDelaySeconds`: backfilled orders are settled (module doc).
      // ⚠️ `id: null` is DELIBERATE and must stay: no ML event stands behind a
      // backfilled order, so claiming an id here would be a lie. The failure doc
      // still dedups — `docIdOf` derives `<topic>:<resource>` when ML sent no id
      // (#807, `notificacao.ts`). Do not "fix" this to a synthetic id.
      const payload: MlNotificationPayload = {
        id: null,
        resource: `/orders/${order.id}`,
        topic: 'orders_v2',
        user_id: userId,
        application_id: null,
        attempts: null,
        sent: null,
        received: nowMs,
        // Synthesised here, so there is no ML subtopic array to carry.
        actions: null,
      };
      await scheduler.enqueue(payload);
      enqueued += 1;

      // (e) Track the high-water mark of `date_last_updated` (tolerate null).
      const us = coerceToMicros(order.last_updated ?? null);
      if (us != null && (maxLastUpdatedUs == null || us > maxLastUpdatedUs)) {
        maxLastUpdatedUs = us;
      }
    }

    offset += results.length;
    const total = page.paging?.total ?? null;
    if (total != null && offset >= total) break; // backlog fully covered
    if (pages >= MAX_PAGES_PER_TICK) {
      // Cap hit with backlog remaining: LOUD warn, cursor still advances over
      // what WAS fetched (`date_asc` + the overlap bound the re-cover risk —
      // the bounded-risk decision documented in the module doc).
      truncated = true;
      console.warn('[mercado-livre] order-backfill TRUNCADO — backlog restante após o cap', {
        integracaoId,
        pages,
        ordersFound,
        isoFrom,
        maxLastUpdatedUs,
      });
      break;
    }
  }

  // (f) Advance the cursor ONLY after every page + enqueue succeeded. A fully
  // drained empty window advances to `nowUs`; a truncated tick advances only
  // to the max `date_last_updated` actually fetched (never past the backlog —
  // and defensively not at all if no order carried a parseable timestamp).
  const drainedCursorUs = maxLastUpdatedUs ?? nowUs;
  const nextCursorUs = truncated ? maxLastUpdatedUs : drainedCursorUs;
  const patch: Record<string, unknown> = { lastSweepAtUs: nowUs, lastError: null };
  if (nextCursorUs != null) patch.cursorUs = nextCursorUs;
  await backfillPedidosMercadoLivreCollection.merge(db, {}, integracaoId, patch);

  return { integracaoId, ordersFound, enqueued, truncated };
}

/**
 * The whole sweep tick: enumerate every ACTIVE Mercado Livre `integracao`
 * (the enumeration inverse of `resolveIntegracaoByUserId`) and sweep each,
 * failure-isolated per conta. Returns the summary the wrapper logs. The flag
 * check comes first — off ⇒ NOTHING is read or enqueued.
 */
export async function runOrderBackfillSweep(
  db: Firestore,
  deps: OrderBackfillDeps,
): Promise<BackfillSweepResult> {
  if (process.env[ORDER_BACKFILL_FLAG_ENV] !== '1') {
    return { enabled: false, contas: [] };
  }

  const nowMs = deps.nowMs;
  const nowUs = millisToMicros(nowMs);

  const snap = await integracaoCollection
    .ref(db, {})
    .where('tipo', '==', INTEGRACAO_TIPO.mercadoLivre)
    .where('ativo', '==', true)
    .get();

  const contas: BackfillContaResult[] = [];
  for (const doc of snap.docs) {
    const integracaoId = doc.id;
    // The denormalized ML seller id (stamped at OAuth exchange). Read raw off
    // the enumerated doc — only this one field is needed, and a soft parseRead
    // of every conta would warn-spam each tick on legacy partial docs.
    const userId = numericField(doc.data(), 'user_id');
    if (userId == null) {
      // Never connected via the new flow (no `user_id` denormalized) — no API
      // call is possible for it; record and move on (cursor untouched).
      contas.push(await recordContaError(db, integracaoId, nowUs, SEM_USER_ID_ERROR));
      continue;
    }

    try {
      // The enumeration already fetched this document, and it satisfies both
      // guards `loadMercadoLivreContext` performs — the doc EXISTS (the query
      // returned it) and `tipo === mercadoLivre` (a query predicate) — so
      // `sweepConta` builds its context from the snapshot instead of
      // point-reading the same doc again. Parsed here, past the `user_id` guard,
      // for the same reason that guard reads raw: a soft parseRead of every
      // enumerated conta would warn-spam each tick on legacy partial docs.
      const conta = integracaoCollection.parseRead(
        doc.data(),
        integracaoCollection.docPath({}, integracaoId),
      );
      const result = await sweepConta(
        db,
        deps.scheduler,
        integracaoId,
        userId,
        conta,
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
