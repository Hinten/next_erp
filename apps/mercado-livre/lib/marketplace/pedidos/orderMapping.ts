/**
 * Order → `pedido`/`ItemDoPedido` field mapping (ML→ERP, Step 9). Pure functions
 * only — no Firestore, no ML API calls; the IO layer (a future `orderImport.ts`)
 * resolves the produto link + writes the doc, calling these to compute the
 * values.
 *
 * Ported from `OrderML.toPedido` and `OrderML._makeItemDoPedido`
 * (`.old/packages/canais_de_venda/mercado_livre/lib/src/models.dart:3051-3092,
 * 3179-3211`) plus `ItemDoPedido.generateUid`
 * (`.old/packages/pedido/lib/src/models.dart:149-153`). Legacy quotes:
 *
 *   double total = 0;
 *   double valorFreteInicial = 0;
 *   double descontoTotal = 0;
 *   for (MercadoLivrePayment item in payments ?? []){
 *     total += item.transaction_amount;
 *     descontoTotal += item.coupon_amount ?? 0;
 *     valorFreteInicial += item.shipping_cost ?? 0;
 *   }
 *   total += valorFreteInicial - descontoTotal;
 *   // ...
 *   descontoTotal: descontoTotal.duasCasasDecimais,
 *   valorCobrado: total.duasCasasDecimais,
 *
 *   precoDeVenda: (order_item.unit_price + (order_item.discounts?.fold(0,
 *     (previousValue, element) => (previousValue ?? 0) + (element.amounts.full))
 *     ?? 0)).duasCasasDecimais,
 *   descontoUnitario: (order_item.discounts?.fold(0,
 *     (previousValue, element) => (previousValue ?? 0) + (element.amounts.full))
 *     ?? 0),
 *
 * Deviations from the legacy source (see the Step 9 task's "Approved
 * deviations" + notes below for the full rationale):
 *  - legacy's own `toPedido()` has its `valorFreteInicial:` constructor arg
 *    commented out (dead code) even though the local variable is computed.
 *    ⚠️ **DECISION #796/O9 — the field is GONE, so neither side of that
 *    question survives.** The audit read the commented-out line as a design and
 *    concluded the port double-counts freight; the truth was the opposite (the
 *    line was a hole — legacy's own `Pedido.factory` fills the same cache on
 *    every manually-created pedido), and the real defect was that the cache
 *    DRIFTED from the block it caches. Rather than patch the drift, the cache
 *    was deleted: `pedido.valorFreteInicial` and `custoFreteInicial` were pure
 *    functions of `freteInicial.valorCobrado` / `.custoCalculado ?? .custoFinal`
 *    on the SAME document, had no reader, no query, no index and no legacy
 *    Flutter consumer, so they could not be made correct more cheaply than by
 *    not existing. **`freteInicial.valorCobrado` is the freight value.** This
 *    function therefore no longer returns a pedido-level freight figure — the
 *    Σ `payments[].shipping_cost` sum below survives only as a term of
 *    `valorCobrado`, which is a genuine stored field (it backs a server-side
 *    `orderBy` + currency filter on `/pedidos` and two indexes).
 *    ⚠️ Do not reintroduce a pedido-level freight cache to "make reports
 *    easier". Reports sum `pedidoTotal` = Σ item subtotals
 *    (`apps/web/lib/reports/aggregations.ts`), NF-e reads `frete.valorCobrado`
 *    directly, and the pedido footer derives live from watched form state;
 *  - `ordem` is the 0-based `index` of the line within ITS ML order, where
 *    legacy leaves the `ItemDoPedido` constructor default of **1**
 *    (`.old/packages/pedido/lib/src/models.dart:160`; `_makeItemDoPedido` never
 *    sets it). ⚠️ **DECISION #796/O8 — keep 0-based; "restoring parity" would
 *    be a regression.** A constant 1 on every line makes all three legacy sorts
 *    inert (`models.dart:191`, `:2671`, `:3595`), i.e. legacy ML pedidos have no
 *    line order at all; `index` gives them one. Every consumer treats the value
 *    as a RELATIVE sort key — `flattenPedidoItens`
 *    (`packages/schemas/src/pedido/pureLogic/itens.ts`), the web form's copy
 *    (`apps/web/app/(app)/pedidos/_components/flattenItens.ts`) and the print
 *    model (`apps/web/lib/pedido-print/assemble.ts`). NF-e does NOT read it:
 *    `det/@nItem` is the flatten index
 *    (`apps/nfe/lib/nfe/orchestrator/generator-input.ts`). The accepted cost is
 *    cosmetic and single-site: the `#` column renders `ordem` raw
 *    (`apps/web/app/(app)/pedidos/_components/tabs/PrincipalTab.tsx`), so an ML
 *    pedido's first line shows `0` where a manual pedido's shows `1` (the schema
 *    default is 1, `packages/schemas/src/pedido/collection/pedido.ts`, and the
 *    manual editor allocates `max(ordem) + 1`).
 *    ⚠️ **The numbering is PER ML ORDER, and packs therefore COLLIDE.**
 *    `buildItensByOrderId` (`orderImport.ts`) restarts the counter at 0 for each
 *    sibling order and `orderPedidoTx.ts` appends the lines without renumbering,
 *    so a pack pedido holds duplicate `ordem` values and the sort INTERLEAVES
 *    the siblings instead of appending them. That is a separate defect from the
 *    0-vs-1 question, recorded here and deliberately not fixed under #796; the
 *    fix is a continuous 1..N renumber at append time inside `orderPedidoTx`'s
 *    transaction.
 *    ⚠️ `index` also feeds `makeItemEnsureUniqueId(orderId, mktplaceId, index)`,
 *    which IS load-bearing (dedup, append-only merge, incidente doc ids). The
 *    two uses are independent — changing `ordem` must not change what reaches
 *    that function;
 *  - timestamps convert ISO → **microseconds** (project policy — see
 *    `packages/schemas/src/pedido/collection/pedido.ts:119-124`), not the
 *    legacy `DateTime` object;
 *  - `gtin`/`custo` are left `null` on every mapped item — legacy's
 *    `_makeItemDoPedido` never sets either (confirmed by reading the ported
 *    function body: neither field appears in the `ItemDoPedido(...)` call).
 *
 * The ML `GET /orders/{id}` response's `payments[]` (order-embedded payment
 * summaries used for the money math above) and an order line's `discounts[]`
 * are real API fields the plugin's `.passthrough()` schemas already carry at
 * runtime but haven't promoted to named properties on `MlOrder` — read here
 * through an explicit `unknown` cast (`passthroughOrder`/`passthroughOrderItem`)
 * so this file compiles independently of exactly how the plugin's inferred
 * passthrough type is shaped, and keeps working unchanged if the plugin later
 * promotes them to typed fields.
 */
import type { MlOrder } from '@delfrance/integrations-mercado-livre';
import type { EstadoPedido, ItemDoPedido } from '@delfrance/schemas';
import { roundReais } from '@delfrance/core/money';
import { coerceToMicros } from '@delfrance/core/datetime';
import { estadoPedidoFromOrderStatus } from './orderStatusMaps';
import { makeItemEnsureUniqueId } from './orderIds';

/** One `order.order_items[]` line, exactly as `MlOrder` types it. */
type MlOrderItemLine = NonNullable<MlOrder['order_items']>[number];

/* ------------------------- passthrough field access ------------------------ */

interface MlOrderPaymentSummary {
  transaction_amount?: number | null;
  coupon_amount?: number | null;
  shipping_cost?: number | null;
}

/** Fields the order carries on the wire that aren't (yet) named on `MlOrder`. */
interface MlOrderPassthroughFields {
  payments?: MlOrderPaymentSummary[] | null;
  comment?: string | null;
}

function passthroughOrder(order: MlOrder): MlOrderPassthroughFields {
  return order as unknown as MlOrderPassthroughFields;
}

interface MlOrderItemDiscount {
  amounts?: { full?: number | null } | null;
}

/** Fields an order-item line carries on the wire that aren't (yet) named. */
interface MlOrderItemPassthroughFields {
  discounts?: MlOrderItemDiscount[] | null;
}

function passthroughOrderItem(line: MlOrderItemLine): MlOrderItemPassthroughFields {
  return line as unknown as MlOrderItemPassthroughFields;
}

/** `Σ discounts[].amounts.full` for one order-item line — 0 when there are none. */
function lineDiscountTotal(line: MlOrderItemLine): number {
  const discounts = passthroughOrderItem(line).discounts;
  if (!discounts || discounts.length === 0) return 0;
  return discounts.reduce((sum, d) => sum + (d.amounts?.full ?? 0), 0);
}

/* ------------------------------- core fields -------------------------------- */

export interface PedidoCoreFields {
  estado: EstadoPedido;
  numero: string;
  descontoTotal: number;
  valorCobrado: number;
  timestamp: number | null;
  ultimaModificacao: number | null;
  observacoesInternas: string | null;
}

/**
 * `numero`/`estado`/money-fields/timestamps for the `pedido` doc, from one ML
 * order. `packId` is passed in separately (rather than read off `order.pack_id`)
 * because the caller already resolved it while deciding the pedido's
 * deterministic id (`makePedidoIdMercadoLivre`) — see `orderIds.ts`.
 */
export function mlOrderToPedidoCoreFields(args: {
  order: MlOrder;
  packId: number | null;
}): PedidoCoreFields {
  const { order, packId } = args;
  const { payments, comment } = passthroughOrder(order);

  let total = 0;
  let valorFreteInicial = 0;
  let descontoTotal = 0;
  for (const payment of payments ?? []) {
    total += payment.transaction_amount ?? 0;
    descontoTotal += payment.coupon_amount ?? 0;
    valorFreteInicial += payment.shipping_cost ?? 0;
  }
  total += valorFreteInicial - descontoTotal;

  return {
    estado: estadoPedidoFromOrderStatus(order.status ?? ''),
    numero: String(packId ?? order.id),
    descontoTotal: roundReais(descontoTotal),
    valorCobrado: roundReais(total),
    timestamp: coerceToMicros(order.date_created),
    ultimaModificacao: coerceToMicros(order.last_updated),
    observacoesInternas: comment ?? null,
  };
}

/**
 * One `order_items[]` line → an `ItemDoPedido`. `produtoUid` is resolved by the
 * caller (marketplace-link → sku lookup, same cascade as the product-import
 * flow) and passed in — null is a legitimate "no ERP produto matched yet".
 */
export function mlOrderItemToItemDoPedido(args: {
  orderId: number;
  orderItem: MlOrderItemLine;
  index: number;
  produtoUid: string | null;
  timestampUs: number;
}): ItemDoPedido {
  const { orderId, orderItem, index, produtoUid, timestampUs } = args;

  const item = orderItem.item;
  const itemId = item?.id ?? '';
  const variationId = item?.variation_id ?? null;
  const mktplaceId = variationId != null ? String(variationId) : itemId;

  const discountTotal = lineDiscountTotal(orderItem);
  const unitPrice = orderItem.unit_price ?? 0;

  return {
    produtoUid,
    ordem: index,
    ensureUniqueId: makeItemEnsureUniqueId(orderId, mktplaceId, index),
    mktplaceId,
    sku: item?.seller_sku ?? null,
    gtin: null,
    nomeDeVenda: item?.title ?? null,
    precoDeVenda: roundReais(unitPrice + discountTotal),
    descontoUnitario: discountTotal,
    quantidade: orderItem.quantity ?? 0,
    custo: null,
    timestamp: timestampUs,
    imposto: null,
  };
}

/* --------------------------- completeness guard ----------------------------- */

export interface IncompleteOrderItemLine {
  itemId: string | null;
  variationId: string | number | null;
  sellerSku: string | null;
  elementId: string | number | null;
}

/**
 * Thrown when `order.order_items` is null/empty, or when any line is missing
 * `item.id` — the ML API can return `206 Partial Content` for a still-processing
 * order with lines dropped. Issue #362: the message lists every incomplete
 * line's `(item.id, variation_id, seller_sku, element_id)` tuple so the failure
 * is diagnosable from the log line alone, unlike legacy (which threw with no
 * detail — `.old` has no equivalent guard at all).
 */
export class OrderItemsIncompleteError extends Error {
  constructor(
    readonly orderId: number,
    readonly missing: readonly IncompleteOrderItemLine[],
  ) {
    super(OrderItemsIncompleteError.buildMessage(orderId, missing));
    this.name = 'OrderItemsIncompleteError';
  }

  private static buildMessage(
    orderId: number,
    missing: readonly IncompleteOrderItemLine[],
  ): string {
    if (missing.length === 0) {
      return `Pedido Mercado Livre ${orderId}: order_items vazio ou ausente (possível resposta parcial 206 da API do Mercado Livre).`;
    }
    const tuples = missing
      .map(
        (m) =>
          `(item.id=${m.itemId ?? 'null'}, variation_id=${m.variationId ?? 'null'}, ` +
          `seller_sku=${m.sellerSku ?? 'null'}, element_id=${m.elementId ?? 'null'})`,
      )
      .join('; ');
    return `Pedido Mercado Livre ${orderId}: ${missing.length} item(ns) sem item.id — linhas incompletas: ${tuples}`;
  }
}

/** Throws `OrderItemsIncompleteError` — see its docstring. No-op when the order is complete. */
export function assertOrderItemsComplete(order: MlOrder): void {
  const items = order.order_items;
  if (!items || items.length === 0) {
    throw new OrderItemsIncompleteError(order.id, []);
  }

  const missing: IncompleteOrderItemLine[] = [];
  for (const line of items) {
    if (!line.item?.id) {
      missing.push({
        itemId: line.item?.id ?? null,
        variationId: line.item?.variation_id ?? null,
        sellerSku: line.item?.seller_sku ?? null,
        elementId: line.element_id ?? null,
      });
    }
  }
  if (missing.length > 0) {
    throw new OrderItemsIncompleteError(order.id, missing);
  }
}
