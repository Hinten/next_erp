/**
 * The SYNTHETIC code-3 contract — one builder, shared by every producer that
 * discovers an order without a push having arrived.
 *
 * Three of them exist: master-plan **step 4**'s `orderBackfill` (`get_order_list`
 * by `update_time`, the 15-minute backstop behind the receiver), **step 6**'s
 * weekly settlement sweep (`get_escrow_list` named an order whose pedido or
 * pagamento is not here yet) and, when it lands, **step 8**'s stuck-reservation
 * sweep. All of them hand the notification pipeline a payload shaped exactly
 * like a parsed `push 1`, so an order found by a sweep takes the SAME import
 * path as one Shopee pushed.
 *
 * ## Why it is a sibling file and not a function inside `notificacao.ts`
 *
 * `notificacao.ts` is the pipeline binding the receiver, the task handler and
 * the reprocess sweep all read. This is a PRODUCER, written by scheduled
 * sweeps only: keeping it out means a change to the synthetic contract cannot
 * red the receiver's suite. The coupling it does have — the exact `data` key
 * `identidadeDoPush` reads — is pinned by this module's own test, which
 * imports `docIdOf`/`dedupKeyOf` and asserts the strings.
 *
 * ## What it deliberately does NOT carry
 *
 * A real `push 1` carries `data.update_time` (SECONDS), `data.items` and
 * `data.completed_scenario`. `get_order_list` returns none of them, so none is
 * synthesized:
 *
 *  - ⚠️ **`update_time` is absent, and that is load-bearing.** A handler written
 *    as `d.update_time ?? envelope.timestamp` would silently take a
 *    MILLISECOND value where a SECOND one is expected — root rule 7's cross-unit
 *    trap in its purest form, and `identidadeDoPush`'s case 3 already documents
 *    that the two clocks are in different units on purpose and are never
 *    compared. **Step 5's watermark comes from `get_order_detail.update_time`,
 *    never from a push — real or synthetic.**
 *  - `items` is undocumented (observed on the wire); nothing may depend on it.
 *  - `completed_scenario` would be a claim about the money side we never read.
 *
 * The envelope `timestamp` is the SYNTHESIS moment, in MILLISECONDS: legal for
 * logging and for the doc id, never as a watermark.
 */
import type { ShopeeNotificationPayload } from './notificacao';

/**
 * Which sweep synthesized the push. It rides inside `data` and is NOT part of
 * the identity, so two sweeps finding the same order share ONE dedup key — and,
 * WITHIN one tick, one create-only document.
 *
 * ⚠️ The producers do NOT collapse onto one row across ticks: the carimbo is
 * the synthesis clock (`docIdOf` → `3:<shop>:<ordersn>:<nowMs>`), and two
 * schedules never share a `Date.now()` read. The dedup key is per-RUN only
 * (each sweep's own `Set`), so every producer owes its own idempotence; what it
 * gets from this module is a payload shaped exactly like step 4's.
 *
 * ⚠️ `'liquidacao'` (#1514, step 6) is the WEEKLY settlement sweep, and it is
 * the one producer that synthesizes from the MONEY side rather than from an
 * order walk: `get_escrow_list` named an order whose released escrow we can see
 * and whose pedido (or pagamento) does not exist here yet. It carries no
 * `orderStatus` — the settlement listing has no such field — so the importer
 * re-reads `get_order_detail` for it exactly as it does for every other code 3.
 */
export type OrigemSintetica = 'backfill' | 'reserva-travada' | 'liquidacao';

export interface NotificacaoSinteticaDePedidoParams {
  /** The conta's `shop_id` — top level on a real code 3. */
  readonly shopId: number;
  /** Shopee's `order_sn`, verbatim off the wire. */
  readonly orderSn: string;
  /**
   * The SYNTHESIS moment, MILLISECONDS. ONE clock read per tick: every order in
   * a tick then shares the stamp, so a re-run within the tick collapses onto
   * the same create-only document.
   */
  readonly nowMs: number;
  readonly origem: OrigemSintetica;
  /**
   * `get_order_list`'s optional `order_status`, when Shopee returned it.
   * Present-or-absent, never null — an absent optional and a null are different
   * things, and a null would claim we read a status and got none.
   */
  readonly orderStatus?: string;
}

/**
 * Build the parsed code-3 payload for one order.
 *
 * ⚠️ It returns the PARSED payload (ms), not a wire envelope run through
 * `parseNotificationBody`. There is no real wire body here, and encoding
 * `nowMs` as seconds only to multiply it back would be a lossy round trip
 * through the one function whose entire job is "the wire is seconds".
 *
 * Identity, traced through `identidadeDoPush` case 3 (no `update_time` ⇒ the
 * carimbo is the envelope stamp):
 *
 *  - `docIdOf`    → `3:<shopId>:<orderSn>:<nowMs>`
 *  - `dedupKeyOf` → `3:<shopId>:<orderSn>`
 */
export function notificacaoSinteticaDePedido(
  p: NotificacaoSinteticaDePedidoParams,
): ShopeeNotificationPayload {
  return {
    code: 3,
    shopId: p.shopId,
    timestamp: p.nowMs,
    data: {
      // ⚠️ THIS spelling. `identidadeDoPush` reads `d.ordersn` (no underscore),
      // while `get_order_list` answers `order_sn`. The rename happens HERE and
      // nowhere else; a test asserts the literal key.
      ordersn: p.orderSn,
      origem: p.origem,
      ...(p.orderStatus == null ? {} : { status: p.orderStatus }),
    },
  };
}
