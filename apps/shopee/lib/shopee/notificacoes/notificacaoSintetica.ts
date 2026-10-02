/**
 * The SYNTHETIC push contracts — one builder per push code, each shared by
 * every producer that discovers the work without a push having arrived.
 *
 *  - **Code 3, an ORDER** ({@link notificacaoSinteticaDePedido}). Its producers
 *    are the {@link OrigemSintetica} members, each documented there — the
 *    sweeps that walk orders, and the shipment arm when a package push names a
 *    pedido that does not exist yet. All of them hand the notification
 *    pipeline a payload shaped exactly like a parsed `push 1`, so an order
 *    found by a sweep takes the SAME import path as one Shopee pushed.
 *  - **Code 30, a PACKAGE** ({@link notificacaoSinteticaDePacote}, step 15b,
 *    #1744). Shaped like a parsed `push 33`, so a package found by POLLING
 *    takes the same shipment path — `alvoDoPushDeFrete`, then
 *    `rastrearPedidoShopee` — as one Shopee pushed. It is built for a producer
 *    that lists packages rather than receiving them: the moment a package
 *    becomes eligible for the automatic arrange has no DOCUMENTED push.
 *
 * ⚠️ No count, on purpose: the counted sentence this header used to carry said
 * three producers while four existed, and nothing failed.
 *
 * ## Why it is a sibling file and not a function inside `notificacao.ts`
 *
 * `notificacao.ts` is the pipeline binding the receiver, the task handler and
 * the reprocess sweep all read. This is a PRODUCER, written by scheduled
 * sweeps (and the one push-driven fallback above): keeping it out means a
 * change to the synthetic contract cannot red the receiver's suite. The
 * coupling it does have — the exact `data` keys `identidadeDoPush` reads — is
 * pinned by this module's own test, which imports `docIdOf`/`dedupKeyOf` and
 * asserts the strings.
 *
 * ## What the code-3 payload deliberately does NOT carry
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
 * ## What the code-30 payload deliberately does NOT carry
 *
 * A real `push 33` carries `data.update_time` (SECONDS) and
 * `data.fulfillment_status`. Neither is synthesized:
 *
 *  - ⚠️ **`update_time`, for the same cross-unit reason as on code 3** — and a
 *    synthetic package push witnessed no transition, so it has no event clock
 *    to give. `alvoDoPushDeFrete` would carry it as the push's own clock
 *    (`relogioDoPushS`), which `rastrearPedido.ts` logs beside the pulled
 *    package's — a clock nobody can source.
 *  - ⚠️ **`fulfillment_status`**, because the push is a POINTER: the handler
 *    pulls `get_package_detail` and acts on THAT. The push's token feeds only
 *    `rastrearPedido.ts`'s push-vs-pull diagnostic (settle-live register item
 *    28), and a token copied from the producer's own read would make that
 *    comparison agree by construction.
 *
 * The envelope `timestamp` is the SYNTHESIS moment, in MILLISECONDS, on both
 * codes: legal for logging and for the doc id, never as a watermark.
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
 *
 * ⚠️ `'rastreio'` (#1515, step 7) is a code 4/30/47 delivery that found no
 * pedido — the race the docs guarantee is possible, since no page anywhere
 * states an ordering between push codes and `push_guarantee = 0`. It is the one
 * producer driven by a PUSH rather than by a sweep, so it synthesizes at most
 * once per delivery per lane run; the bound is in `rastrearPedido.ts`'s
 * docblock.
 */
export type OrigemSintetica = 'backfill' | 'reserva-travada' | 'liquidacao' | 'rastreio';

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

/* -------------------------------------------------------------------------- */
/*                      code 30 — a package (step 15b)                         */
/* -------------------------------------------------------------------------- */

/**
 * Which producer synthesized a code-30 push. Like {@link OrigemSintetica} it
 * names the PRODUCER, rides inside `data` and is NOT part of the identity.
 *
 * ⚠️ Its OWN type, never an alias of {@link OrigemSintetica}: the two builders
 * describe different resources (an order vs a package), so an order sweep's
 * origem (`'backfill'`, `'liquidacao'`, …) must not type-check here. A literal
 * MAY sit in both unions — an origem names a producer, and one producer can
 * synthesize both codes — but membership is declared per builder.
 *
 * `'arranjo-automatico'` (#1744, step 15b) — the automatic-arrange path's
 * package poll: a package on an automatic-arrange channel that became eligible
 * with no documented push saying so.
 */
export type OrigemSinteticaDePacote = 'arranjo-automatico';

export interface NotificacaoSinteticaDePacoteParams {
  /** The conta's `shop_id` — top level on a real code 30. */
  readonly shopId: number;
  /** Shopee's `order_sn`, verbatim off the wire. */
  readonly orderSn: string;
  /** Shopee's `package_number`, verbatim off the wire — the resource. */
  readonly packageNumber: string;
  /**
   * The SYNTHESIS moment, MILLISECONDS — ONE clock read per tick, exactly as on
   * the code-3 builder.
   */
  readonly nowMs: number;
  readonly origem: OrigemSinteticaDePacote;
}

/**
 * Build the parsed code-30 payload for one package.
 *
 * The parsed payload (ms), never a wire envelope — the code-3 builder's reason.
 * `data` carries EXACTLY three keys: `ordersn`, `package_number`, `origem`.
 *
 * Identity, traced through `identidadeDoPush` case 30 (no `update_time` ⇒ the
 * carimbo is the envelope stamp; the order key is NOT part of it — the package
 * is the resource):
 *
 *  - `docIdOf`    → `30:<shopId>:<packageNumber>:<nowMs>`
 *  - `dedupKeyOf` → `30:<shopId>:<packageNumber>`
 *
 * ⚠️ Per TICK, like every synthetic: two ticks are two documents, so the
 * producer owes its own idempotence (one package per tick — its own `Set`).
 */
export function notificacaoSinteticaDePacote(
  p: NotificacaoSinteticaDePacoteParams,
): ShopeeNotificationPayload {
  return {
    code: 30,
    shopId: p.shopId,
    timestamp: p.nowMs,
    data: {
      // ⚠️ `ordersn`, no underscore: `dataPush30Schema` reads the documented
      // spelling first, and it is the spelling the code-3 builder uses too.
      ordersn: p.orderSn,
      package_number: p.packageNumber,
      origem: p.origem,
    },
  };
}
