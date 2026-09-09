import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';

/**
 * `backfillPedidosShopee` (TOP-LEVEL) — the per-conta durable cursor for the
 * flag-gated Shopee order-backfill sweep (master-plan step 4, #1512).
 *
 * The 15-minute `onSchedule` backstop behind the push receiver pages
 * `get_order_list` by `update_time` for every ACTIVE Shopee conta and enqueues
 * one SYNTHETIC code-3 notification per `order_sn`, i.e. the same import path a
 * real push takes. This document — ONE per conta, **doc id = integracaoId** —
 * is where a conta's progress survives across ticks. There is no legacy
 * antecedent: the Flutter app never polled orders at all.
 *
 * ## ⚠️ MILLISECONDS, and the unit is in every field name
 *
 * `apps/shopee/CLAUDE.md` states there is exactly ONE µs module in this
 * channel (`lib/shopee/avisos/autorizacao.ts`) and that everything upstream is
 * milliseconds. The cursor's only comparisons are against `nowMs` and against
 * the wire's SECONDS (`Math.floor(ms / 1000)` at the package boundary), so in
 * ms the sweep holds ONE conversion, in the one place `conta/shops.ts` already
 * establishes. This deliberately does NOT mirror
 * `backfillPedidosMercadoLivre`'s `cursorUs`: root rule 7's own words are that
 * a cross-unit comparison is "a guard that never fires", and the synthesized
 * push's `timestamp` sitting beside this cursor is already ms.
 *
 * ## Write discipline (the sweep's — documented here because the five fields
 * only make sense together)
 *
 * The sweep queries ONE window per conta per tick,
 * `[cursorMs - OVERLAP, min(from + 15 d, nowMs)]`, and pages it on `more`:
 *
 *  - **drained** (`more === false`) ⇒ merge
 *    `{ cursorMs: max(stored, windowTo), pendingCursor: null,
 *       pendingWindowFromMs: null, pendingWindowToMs: null, lastSweepAtMs,
 *       lastError: null }`. The cursor advances to the WINDOW's upper bound,
 *    never to `nowMs`: `[windowTo, nowMs]` was never queried, and claiming it
 *    would skip whatever landed in that gap.
 *  - **truncated** (the per-tick page cap) ⇒ merge the pending triple
 *    `{ pendingCursor, pendingWindowFromMs, pendingWindowToMs, lastSweepAtMs,
 *       lastError }` and advance NOTHING (`lastError` names the provider
 *    contradiction when there is one, and is `null` on a plain page-cap
 *    truncation — a stale message never survives a tick). Partial advance is
 *    INEXPRESSIBLE here:
 *    `get_order_list` rows carry no timestamp of any kind, so there is no
 *    `max(update_time)` to advance to, and the row ordering is undocumented so
 *    position is not a resume key either. Without the pending triple a conta
 *    whose window exceeds the page cap would re-read the same first pages
 *    forever, silently.
 *  - **contained error** ⇒ merge `{ lastSweepAtMs, lastError }` — never the
 *    cursor. The pending triple is left exactly as it was, with ONE narrow
 *    exception keyed on the class: a conta that was RESUMING and failed with a
 *    `ShopeeApiError` has had Shopee look at the stored cursor and refuse it,
 *    so the triple is CLEARED and the next tick restarts the window from page
 *    1. A network / HTTP / schema failure preserves it — we never got an
 *    opinion about the cursor, and dropping a good one on every tick of a
 *    provider outage is how a truncated conta starves.
 *
 * The window starts one OVERLAP before the cursor, so every tick re-covers that
 * band. Nothing deduplicates the repeat across ticks — the synthesized code 3
 * carries the tick's own clock, so its doc id differs — and the cost is one
 * extra enqueue that step 5's `get_order_detail` watermark absorbs.
 *
 * ## Admin-only / default-deny
 *
 * Permissions are `0n` and the schema is deliberately NOT registered in
 * `ALL_DOMAINS` (see the NOTE at the bottom), so the rules generator emits no
 * match block, Firestore default-denies every client read/write, and no rules
 * regeneration is needed. Only the nested `apps/shopee/functions` codebase
 * (Admin SDK) ever touches this collection.
 */

export const backfillPedidosShopeeSchema = z.object({
  /**
   * High-water mark (MS) of `update_time` covered by a fully DRAINED window —
   * the next tick queries from `cursorMs - OVERLAP_MS`. Null until the conta's
   * first drained window (the first tick falls back to the initial lookback).
   */
  cursorMs: millisSinceEpoch().nullable().default(null),
  /**
   * Shopee's OPAQUE `next_cursor` from a TRUNCATED tick, verbatim. Null
   * whenever there is nothing to resume. Never synthesized, and never the
   * drained sentinel `''` — that one means "no more pages", not "resume here".
   */
  pendingCursor: z.string().nullable().default(null),
  /**
   * The exact window {@link pendingCursor} belongs to. A cursor is meaningless
   * without it: applying one to a RECOMPUTED window (the clock has moved) is
   * undefined behaviour at Shopee and a silent skip here. The two bounds are
   * written and cleared together with the cursor, never on their own.
   */
  pendingWindowFromMs: millisSinceEpoch().nullable().default(null),
  pendingWindowToMs: millisSinceEpoch().nullable().default(null),
  /** When the sweep last touched this conta (MS) — set on success AND on a contained error. */
  lastSweepAtMs: millisSinceEpoch().nullable().default(null),
  /** The last contained per-conta sweep error; reset to null on a clean tick. */
  lastError: z.string().nullable().default(null),
});
export type BackfillPedidosShopee = z.infer<typeof backfillPedidosShopeeSchema>;

export const backfillPedidosShopeeMeta: CollectionMetadata = {
  collectionPath: 'backfillPedidosShopee',
  // No client domain grants these bits — placeholder values. Deliberately NOT
  // registered in `ALL_DOMAINS`, so the rules generator emits no match block
  // and Firestore default-denies every client read/write. Only the Admin SDK
  // (apps/shopee nested functions) reaches it. Mirrors
  // `backfillPedidosMercadoLivreMeta`.
  permissions: {
    read: 0n,
    write: 0n,
    delete: 0n,
  },
};

// NOTE: intentionally exported as two BARE constants (`...Schema` + `...Meta`),
// NOT a single `{ schema, meta }` DomainSchema object, and NOT added to
// `ALL_DOMAINS` — `registry.test.ts`'s `isDomainSchema()` only flags a single
// export carrying both a `.schema` and a `.meta` property, so this shape never
// gets swept in by accident. The admin collection handle
// (`backfillPedidosShopeeCollection`) consumes
// `backfillPedidosShopeeMeta.collectionPath` directly.
//
// ⚠️ The collection name deliberately does not start with `notificacoes`:
// `notificationGuardrails`' checks B and C fire on every admin collection path
// with that prefix and would demand a pipeline consumer and a
// `(status, processedAt)` index this cursor doc has neither of.
