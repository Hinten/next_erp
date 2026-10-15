/**
 * The SYNTHETIC push contracts — one builder per push code, each shared by
 * every producer that discovers the work without a push having arrived.
 *
 *  - **Code 3, an ORDER** ({@link notificacaoSinteticaDePedido}). Its producers
 *    are the {@link OrigemSintetica} members, each documented there — the
 *    sweeps that walk orders or settlements, plus two that hold a PACKAGE whose
 *    pedido does not exist yet: the shipment arm (driven by a push) and step
 *    15b's package sweep (a poll). All of them hand the notification pipeline a
 *    payload shaped exactly like a parsed `push 1`, so an order found by any of
 *    them takes the SAME import path as one Shopee pushed.
 *  - **Code 30, a PACKAGE** ({@link notificacaoSinteticaDePacote}, step 15b,
 *    #1744). Shaped like a parsed `push 33`, so a package found by POLLING
 *    takes the same shipment path — `alvoDoPushDeFrete`, then
 *    `rastrearPedidoShopee` — as one Shopee pushed. It is built for a producer
 *    that lists packages rather than receiving them: the moment a package
 *    becomes eligible for the automatic arrange has no DOCUMENTED push.
 *  - **Code 29, a RETURN** ({@link notificacaoSinteticaDeDevolucao}, step 17,
 *    #1525). Shaped like a parsed `push 32` without its diary, so a return
 *    found by the returns POLL — or touched by a seller action in the ERP —
 *    takes the same path as one Shopee pushed: the code-29 arm, which re-reads
 *    `get_return_detail` and writes through the one importer. Push 32 reports
 *    four fields; negotiation, compensation and every due date change
 *    silently, and an action's own effect is never pushed back at all.
 *
 * And ONE helper every day-bounded producer stamps with,
 * {@link carimboDoDiaUtcMs} (its section below).
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
 * ## What the code-29 payload deliberately does NOT carry
 *
 * A real `push 32` carries `data.updated_values[]` — per changed field, its
 * name, the old and new value, and a per-field `update_time` (SECONDS) — and
 * no `data.update_time` at all. Nothing of it is synthesized:
 *
 *  - ⚠️ **`updated_values`**, because it is a DIARY of a transition the
 *    producer never witnessed: the poll read a list row, the route performed
 *    an action. The code-29 reader turns it into a LOG-only diary (the changed
 *    field names, the push's own clock) printed beside the pulled return's, and
 *    an entry copied from the producer's own read would make that comparison
 *    agree by construction — the code-30 `fulfillment_status` reason.
 *  - ⚠️ **No status and no clock**: the push is a POINTER, and the importer's
 *    watermark is `get_return_detail.update_time`, never a push — real or
 *    synthetic.
 *
 * The envelope `timestamp` is the SYNTHESIS moment, in MILLISECONDS, on every
 * code: legal for logging and for the doc id, never as a watermark.
 */
import type { ShopeeNotificationPayload } from './notificacao';

/**
 * Which PRODUCER synthesized the push — a sweep for every member but
 * `'rastreio'`, which a push drives. It rides inside `data` and is NOT part of
 * the identity, so two producers finding the same order share ONE dedup key —
 * and, on one shared clock reading, one create-only document.
 *
 * ⚠️ The producers do NOT collapse onto one row across runs: the carimbo is
 * the synthesis clock (`docIdOf` → `3:<shop>:<ordersn>:<nowMs>`), and two
 * producers never share a clock read. Dedup is per-RUN only — whatever bound
 * the producer keeps itself (the backfill's in-tick `Set`, `'rastreio'`'s
 * per-delivery bound) — so every producer owes its own idempotence; what it
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
 *
 * ⚠️ `'arranjo-automatico'` (#1744, step 15b) is the automatic-arrange package
 * sweep (`pedidos/arranjoAutomaticoSweep.ts`), and the one literal that sits in
 * BOTH unions: it lists PACKAGES, and a candidate whose pedido exists becomes
 * the code 30 below. A candidate whose pedido does NOT exist here yet becomes
 * one code 3 per `order_sn` instead — `'rastreio'`'s situation reached by a
 * poll rather than a push — so the import creates the pedido and a later tick
 * enqueues the package. Neither package read carries an `order_status`, so it
 * supplies none. Its bound is per conta per tick
 * (`MAX_ENFILEIRADOS_ARRANJO_POR_CONTA`, in that module).
 *
 * ⚠️ `'devolucao'` (#1525, step 17) is a code-29 delivery — pushed, polled or
 * after a seller action — whose pedido does not exist here yet: `'rastreio'`'s
 * situation on the returns side. The returns importer defers the delivery and
 * synthesizes ONE code 3 for its `order_sn`, with ZERO Shopee calls, stamped
 * with {@link carimboDoDiaUtcMs} — so a delivery the pipeline keeps re-driving
 * through the day lands on ONE failure row per order, never one per attempt. A
 * return names no `order_status`, so it supplies none. Its bound is per
 * delivery (`devolucoes/importarDevolucao.ts`).
 */
export type OrigemSintetica =
  | 'backfill'
  | 'reserva-travada'
  | 'liquidacao'
  | 'rastreio'
  | 'arranjo-automatico'
  | 'devolucao';

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
 * MAY sit in both unions — an origem names a producer, and
 * `'arranjo-automatico'` is the producer that synthesizes both codes — but
 * membership is declared per builder.
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

/* -------------------------------------------------------------------------- */
/*                       code 29 — a return (step 17)                          */
/* -------------------------------------------------------------------------- */

/**
 * Which producer synthesized a code-29 push. Like the other two unions it
 * names the PRODUCER, rides inside `data` and is NOT part of the identity —
 * and it is its OWN type: an order sweep's origem must not type-check here.
 *
 * - `'reconciliacao'` — the returns poll (`devolucoes/devolucoesSweep.ts`): a
 *   `get_return_list` row that is absent here, newer than the stored
 *   watermark, divergent from the stored block, or breaking an importer
 *   invariant. It stamps {@link carimboDoDiaUtcMs}, so a return keeps ≤ 1
 *   failure row per UTC day (re-creating that doc id is a no-op — the step-15b
 *   bound), and ONE read of it lets the poller skip a return whose import
 *   today PARKED, or DEFERRED while its pedido is still absent.
 * - `'acao-vendedor'` — the `reclamacao/acao` route, after Shopee accepted a
 *   seller action: the action's own effect (an offer moves
 *   `negotiation_status`) is never pushed, so the route hands the importer —
 *   the single writer — a pointer. Its stamp is the click's own ms.
 *
 * ⚠️ `'push'` is deliberately NOT a member: it is what the code-29 reader
 * answers for a delivery that carries no origem — a real push is never
 * synthesized.
 */
export type OrigemSinteticaDeDevolucao = 'reconciliacao' | 'acao-vendedor';

export interface NotificacaoSinteticaDeDevolucaoParams {
  /** The conta's `shop_id` — top level on a real code 29. */
  readonly shopId: number;
  /** Shopee's `order_sn`, verbatim off the wire. */
  readonly orderSn: string;
  /** Shopee's `return_sn`, verbatim off the wire — the resource. ALPHANUMERIC. */
  readonly returnSn: string;
  /**
   * The SYNTHESIS moment, MILLISECONDS: the day's stamp for the poll, the
   * click for an action (see {@link OrigemSinteticaDeDevolucao}).
   */
  readonly nowMs: number;
  readonly origem: OrigemSinteticaDeDevolucao;
}

/**
 * Build the parsed code-29 payload for one return.
 *
 * The parsed payload (ms), never a wire envelope — the code-3 builder's reason.
 * `data` carries EXACTLY three keys: `order_sn`, `return_sn`, `origem`.
 *
 * Identity, traced through `identidadeDoPush` case 29 (push 32 has no
 * top-level clock, so the carimbo is ALWAYS the envelope stamp; the order is
 * NOT part of it — the return is the resource):
 *
 *  - `docIdOf`    → `29:<shopId>:<returnSn>:<nowMs>`
 *  - `dedupKeyOf` → `29:<shopId>:<returnSn>`
 *
 * ⚠️ Unlike codes 3 and 30, a REAL code 29 is stamped in the same unit (the
 * envelope's seconds, parsed to ms), so a real push delivered in the very
 * second a UTC day starts shares the poll's doc id for that return. Accepted:
 * both are the same POINTER ("re-read this return"), and either one's failure
 * row is a true answer to the poll's question "did today's import fail?".
 *
 * ⚠️ Per TICK, like every synthetic: the producer owes its own idempotence.
 */
export function notificacaoSinteticaDeDevolucao(
  p: NotificacaoSinteticaDeDevolucaoParams,
): ShopeeNotificationPayload {
  return {
    code: 29,
    shopId: p.shopId,
    timestamp: p.nowMs,
    data: {
      // ⚠️ `order_sn` WITH the underscore — push 32's own spelling, and the
      // OPPOSITE of the code-3/30 builders' `ordersn`. Code 29's identity reads
      // only `return_sn`, and the code-29 reader takes `order_sn` first; a test
      // asserts the literal key.
      order_sn: p.orderSn,
      return_sn: p.returnSn,
      origem: p.origem,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                               the day's stamp                               */
/* -------------------------------------------------------------------------- */

/** One UTC day in milliseconds — epoch arithmetic, no zone involved. */
const DIA_MS = 86_400_000;

/**
 * The START of the UTC day `nowMs` falls in — the stamp of a producer that
 * synthesizes every tick yet must leave at most ONE failure row per resource
 * per UTC day (the step-15b review's bound, `3685867cc`): with it the doc id is
 * stable for the day, so ONE read of `notificacoesShopee/<docIdOf(p)>` says
 * whether today's delivery is still failing — the store deletes a row once it
 * resolves.
 *
 * Moved here from `pedidos/arranjoAutomaticoSweep.ts` (its two call sites
 * switched) when step 17 became its second module: ONE copy, beside the
 * builders whose `nowMs` it feeds.
 *
 * ⚠️ Flooring is safe only where the arm never reads the envelope stamp as a
 * clock — codes 3 (the importer's watermark is `get_order_detail.update_time`),
 * 30 (the package's own `update_time`) and 29 (the detail's `update_time`).
 *
 * ⚠️ UTC by epoch arithmetic, NEVER a local-time floor: `apps/nfe` runs
 * `TZ=America/Sao_Paulo` while every other backend runs UTC, so a floor through
 * the process zone would move the day's boundary by three hours with the
 * service that ran it.
 */
export function carimboDoDiaUtcMs(nowMs: number): number {
  return Math.floor(nowMs / DIA_MS) * DIA_MS;
}
