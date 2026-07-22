/**
 * Builds the `pedidos/{pedidoId}/orderML/{order.id}` mirror-doc wire object —
 * a byte-faithful copy of what the legacy Dart `OrderML.toJson()` writes when
 * fed the SAME raw ML order payload (`OrderML.fromMercadoLivre(data, ...)` then
 * `.toJson()`). Ported from `_$OrderMLToJson` / `_$OrderItemToJson` /
 * `_$ItemToJson` / `_$BuyerToJson`
 * (`.old/packages/canais_de_venda/mercado_livre/lib/src/models.g.dart:598-687,
 * 454-583`) plus the payment sub-shape (`_$MercadoLivrePaymentToJson`,
 * `.old/packages/canais_de_venda/mercado_livre/lib/src/models.g.dart:1093-1164`).
 *
 * Unlike every other pedido/pagamento/frete field in this app (µs since epoch —
 * project policy, see `packages/schemas/src/pedido/collection/pedido.ts:119-124`),
 * this mirror doc keeps the LEGACY wire convention: the five top-level dates are
 * **milliseconds** since epoch (`maybeDateTimeToJson`), because it's a
 * byte-faithful read-model of the raw ML order, not a new-app-shaped field
 * (approved deviation #1). Nested dates (inside `payments[]`) stay ISO strings —
 * legacy never applies `maybeDateTimeToJson` to those, only the five order-level
 * fields carry the `@JsonKey(toJson: maybeDateTimeToJson)` override.
 *
 * `MlOrder`'s tolerant Zod schema (`packages/integrations/mercado-livre/src/types.ts`)
 * only names the fields the PRODUCT-import side needs today, so several fields
 * this mirror doc requires (`payments`, `comment`, `coupon`, `buying_mode`,
 * `paid_amount`, `pickup_id`, `expiration_date`, `date_closed`,
 * `manufacturing_ending_date`, and the richer `order_items[]`/`buyer` sub-fields)
 * are read through a local passthrough cast — same pattern `orderMapping.ts`
 * uses for `payments`/`comment`/`discounts`. The raw ML payload carries them
 * (Zod `.passthrough()` lets them through at runtime); they just aren't
 * promoted to named properties on the plugin's inferred type yet.
 */
import { coerceToMillis } from '@delfrance/core/datetime';
import { toOuterRef } from '@delfrance/schemas';
import type { MlOrder } from '@delfrance/integrations-mercado-livre';

type MlOrderItemLine = NonNullable<MlOrder['order_items']>[number];

/* -------------------------------------------------------------------------- */
/*                    passthrough access — order-level fields                 */
/* -------------------------------------------------------------------------- */

interface MlOrderWireExtras {
  status_detail?: string | null;
  date_closed?: string | null;
  expiration_date?: string | null;
  manufacturing_ending_date?: string | null;
  comment?: string | null;
  pickup_id?: number | null;
  buying_mode?: string | null;
  shipping_cost?: number | null;
  paid_amount?: number | null;
  coupon?: Record<string, unknown> | null;
  payments?: ReadonlyArray<Record<string, unknown>> | null;
}

function orderExtras(order: MlOrder): MlOrderWireExtras {
  return order as unknown as MlOrderWireExtras;
}

interface MlOrderBuyerExtras {
  nickname?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

function buyerExtras(order: MlOrder): MlOrderBuyerExtras {
  return (order.buyer ?? null) as unknown as MlOrderBuyerExtras;
}

/* -------------------------------------------------------------------------- */
/*                 passthrough access — order_items[] line fields             */
/* -------------------------------------------------------------------------- */

interface MlOrderItemLineExtras {
  item?: {
    category_id?: string | null;
    seller_custom_field?: string | null;
    variation_attributes?: ReadonlyArray<Record<string, unknown>> | null;
    warranty?: string | null;
    condition?: string | null;
    global_price?: number | null;
    net_weight?: number | null;
  } | null;
  requested_quantity?: { value?: number | null; measure?: string | null } | null;
  picked_quantity?: number | null;
  manufacturing_days?: number | null;
  sale_fee?: number | null;
  listing_type_id?: string | null;
  discounts?: ReadonlyArray<{
    amounts?: { full?: number | null; seller?: number | null } | null;
  }> | null;
}

function itemLineExtras(line: MlOrderItemLine): MlOrderItemLineExtras {
  return line as unknown as MlOrderItemLineExtras;
}

/* -------------------------------------------------------------------------- */
/*                              order_items wire                              */
/* -------------------------------------------------------------------------- */

/**
 * `AttributesVariationsML.toJson` — `id` always written, every other key
 * omitted when null (legacy `writeNotNull`, models.g.dart:465-483).
 */
function buildVariationAttributeWire(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { id: raw.id ?? null };
  if (raw.value_id != null) out.value_id = raw.value_id;
  if (raw.name != null) out.name = raw.name;
  if (raw.value_name != null) out.value_name = raw.value_name;
  if (raw.attribute_group_id != null) out.attribute_group_id = raw.attribute_group_id;
  if (raw.attribute_group_name != null) out.attribute_group_name = raw.attribute_group_name;
  return out;
}

/**
 * One `order_items[]` entry — reproduces `_$OrderItemToJson`/`_$ItemToJson`
 * key-for-key (models.g.dart:485-570), including the `discounts` key being
 * OMITTED entirely when there are none (the one `writeNotNull` in `_OrderItem`).
 * `full_unit_price`, present on the raw ML payload but not a Dart-declared
 * field, is intentionally dropped — legacy's `fromJson`/`toJson` round trip
 * drops it too.
 */
function buildOrderItemWire(line: MlOrderItemLine): Record<string, unknown> {
  const item = line.item ?? null;
  const ex = itemLineExtras(line);
  const itemEx = ex.item ?? null;

  const itemWire = {
    id: item?.id ?? null,
    title: item?.title ?? null,
    category_id: itemEx?.category_id ?? null,
    variation_id: item?.variation_id ?? null,
    seller_custom_field: itemEx?.seller_custom_field ?? null,
    variation_attributes: (itemEx?.variation_attributes ?? []).map(buildVariationAttributeWire),
    warranty: itemEx?.warranty ?? null,
    condition: itemEx?.condition ?? null,
    seller_sku: item?.seller_sku ?? null,
    global_price: itemEx?.global_price ?? null,
    net_weight: itemEx?.net_weight ?? null,
  };

  const wire: Record<string, unknown> = {
    item: itemWire,
    quantity: line.quantity ?? null,
    requested_quantity: {
      value: ex.requested_quantity?.value ?? null,
      measure: ex.requested_quantity?.measure ?? null,
    },
    picked_quantity: ex.picked_quantity ?? null,
    unit_price: line.unit_price ?? null,
    // `currency_id` is already typed at the line level on `orderItemSchema`.
    currency_id: line.currency_id ?? null,
    manufacturing_days: ex.manufacturing_days ?? null,
    sale_fee: ex.sale_fee ?? null,
    listing_type_id: ex.listing_type_id ?? null,
  };
  if (ex.discounts != null) {
    wire.discounts = ex.discounts.map((d) => ({
      amounts: { full: d.amounts?.full ?? null, seller: d.amounts?.seller ?? null },
    }));
  }
  return wire;
}

/* -------------------------------------------------------------------------- */
/*                                 buyer wire                                  */
/* -------------------------------------------------------------------------- */

/**
 * `_$BuyerToJson` — all 4 keys always written for a NON-NULL buyer, none
 * omitted (models.g.dart:591-596); a buyer-less order serializes `buyer: null`
 * (the generated nullable-toJson short-circuits), NOT an all-null object.
 */
function buildBuyerWire(order: MlOrder): Record<string, unknown> | null {
  const buyer = order.buyer ?? null;
  if (buyer == null) return null;
  const ex = buyerExtras(order);
  return {
    id: buyer.id ?? null,
    nickname: ex.nickname ?? null,
    first_name: ex.first_name ?? null,
    last_name: ex.last_name ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/*                                payments wire                               */
/* -------------------------------------------------------------------------- */

function asNumber(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

function asMaybeString(v: unknown): string | null {
  return v == null ? null : String(v);
}

/**
 * One `orderML.payments[]` entry — reproduces every key
 * `_$MercadoLivrePaymentToJson` writes (legacy `MercadoLivrePayment`,
 * `.old/packages/canais_de_venda/mercado_livre/lib/src/models.dart:4267-4349`,
 * `models.g.dart:1093-1164`) by reading the SAME key name off the raw
 * `order.payments[]` entry Dart's `fromJson` would read — so a field ML's
 * order-embedded payment summary happens to omit naturally comes through as
 * `null` here too, exactly like it would through the legacy round trip,
 * without this function having to hard-code which fields the (necessarily
 * non-exhaustive) sample payload does or doesn't carry.
 *
 * Exactly THREE keys are the exception, hard-`null`led on purpose: the raw
 * order-embedded payment carries them under a DIFFERENT key than the Dart
 * field reads, so legacy's OWN `fromJson` would ALSO produce `null` for these
 * — this reproduces a pre-existing legacy quirk, not a new bug:
 *   - `collector_id` — raw carries `collector: { id }`, not a flat `collector_id`.
 *   - `payer`        — raw carries a flat `payer_id`, not a `payer` object.
 *   - `date_last_updated` — raw carries `date_last_modified`.
 */
function buildPaymentWire(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    id: raw.id ?? null,
    site_id: raw.site_id ?? null,
    // Nested payment dates stay ISO strings — unlike the 5 top-level order
    // dates, legacy never runs these through `maybeDateTimeToJson`.
    date_created: raw.date_created ?? null,
    date_approved: raw.date_approved ?? null,
    date_last_updated: null, // key mismatch — raw carries `date_last_modified`
    date_of_expiration: raw.date_of_expiration ?? null,
    money_release_date: raw.money_release_date ?? null,
    money_release_status: raw.money_release_status ?? null,
    notification_url: raw.notification_url ?? null,
    last_modified: raw.last_modified ?? null,
    reason: raw.reason ?? null,
    card_id: raw.card_id ?? null,
    currency_id: raw.currency_id ?? null,
    transaction_amount: asNumber(raw.transaction_amount),
    total_paid_amount: asNumber(raw.total_paid_amount),
    shipping_cost: asNumber(raw.shipping_cost),
    coupon_amount: asNumber(raw.coupon_amount) ?? 0,
    coupon_id: raw.coupon_id ?? null,
    status: raw.status ?? null,
    status_detail: raw.status_detail ?? null,
    installments: raw.installments ?? null,
    installment_amount: raw.installment_amount ?? null,
    payment_type: raw.payment_type ?? null,
    payment_type_id: raw.payment_type_id ?? null,
    payment_method_id: raw.payment_method_id ?? null,
    marketplace: raw.marketplace ?? null,
    operation_type: raw.operation_type ?? null,
    deduction_schema: raw.deduction_schema ?? null,
    description: raw.description ?? null,
    differential_pricing_id: raw.differential_pricing_id ?? null,
    amount_refunded: raw.amount_refunded ?? null,
    api_version: raw.api_version ?? null,
    concept_id: raw.concept_id ?? null,
    concept_amount: raw.concept_amount ?? null,
    sponsor_id: raw.sponsor_id ?? null,
    overpaid_amount: asNumber(raw.overpaid_amount),
    external_reference: raw.external_reference ?? null,
    order_id: asMaybeString(raw.order_id),
    merchant_order_id: raw.merchant_order_id ?? null,
    tags: raw.tags ?? null,
    refunds: raw.refunds ?? null,
    deferred_period: raw.deferred_period ?? null,
    status_code: raw.status_code ?? null,
    account_money_amount: raw.account_money_amount ?? null,
    transaction_order_id: raw.transaction_order_id ?? null,
    additional_info: raw.additional_info ?? null,
    issuer_id: asMaybeString(raw.issuer_id),
    live_mode: raw.live_mode ?? null,
    net_received_amount: raw.net_received_amount ?? null,
    mercadopago_fee: raw.mercadopago_fee ?? null,
    marketplace_fee: raw.marketplace_fee ?? null,
    discount_fee: raw.discount_fee ?? null,
    coupon_fee: raw.coupon_fee ?? null,
    finance_fee: raw.finance_fee ?? null,
    released: raw.released ?? null,
    collector_id: null, // key mismatch — raw carries `collector: { id }`
    payer: null, // key mismatch — raw carries a flat `payer_id`
    authorization_code: raw.authorization_code ?? null,
    binary_mode: raw.binary_mode ?? null,
    captured: raw.captured ?? null,
    card: raw.card ?? null,
    charge_details: raw.charge_details ?? null,
    charges_details: raw.charges_details ?? null,
    fee_details: raw.fee_details ?? null,
    transaction_details: raw.transaction_details ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/*                                   entrypoint                               */
/* -------------------------------------------------------------------------- */

/**
 * Build the full `orderML` wire object for one Mercado Livre order. Pure — no
 * IO, no `Date.now()`. `contaOuterRef` is normalized to the canonical
 * `documents/integracao/<id>` form via `toOuterRef` (no leading slash — NOT the
 * same convention as `makePagamentoIdMercadoLivre`'s sha1 preimage, which needs
 * a leading slash; see `orderIds.ts`).
 */
export function buildOrderMLWire(args: {
  order: MlOrder;
  contaOuterRef: string;
}): Record<string, unknown> {
  const { order, contaOuterRef } = args;
  const ex = orderExtras(order);
  const shippingId = order.shipping?.id ?? null;

  const wire: Record<string, unknown> = {
    id: order.id,
    contaMercadoLivreOuterRef: toOuterRef(contaOuterRef),
    status: order.status ?? null,
    date_created: coerceToMillis(order.date_created),
    date_closed: coerceToMillis(ex.date_closed),
    last_updated: coerceToMillis(order.last_updated),
    expiration_date: coerceToMillis(ex.expiration_date),
    manufacturing_ending_date: coerceToMillis(ex.manufacturing_ending_date),
    order_items: (order.order_items ?? []).map(buildOrderItemWire),
    payments: ex.payments != null ? ex.payments.map(buildPaymentWire) : null,
    buyer: buildBuyerWire(order),
    pack_id: order.pack_id ?? null,
    pickup_id: ex.pickup_id ?? null,
    buying_mode: ex.buying_mode ?? null,
    shipping_cost: ex.shipping_cost ?? null,
    total_amount: order.total_amount ?? null,
    paid_amount: ex.paid_amount ?? null,
    coupon: ex.coupon ?? null,
    shipping: shippingId != null ? { id: shippingId } : null,
  };

  // Omit-when-null keys (legacy `writeNotNull`): status_detail, tags, comment.
  if (ex.status_detail != null) wire.status_detail = ex.status_detail;
  if (order.tags != null) wire.tags = order.tags;
  if (ex.comment != null) wire.comment = ex.comment;

  return wire;
}
