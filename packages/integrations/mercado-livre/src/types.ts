import { z } from 'zod';

/**
 * Zod shapes for Mercado Livre payloads (OAuth + REST resources). Tolerant by
 * design (user point #3 — ML silently changes fields): unknown keys ride through
 * `.passthrough()`, response fields are mostly `.nullable().optional()`, and only
 * the identifiers we actually key on are required. A field ML renames or drops
 * therefore degrades gracefully instead of throwing.
 */

/**
 * Response of `POST /oauth/token` for both `authorization_code` and
 * `refresh_token` grants. `expires_in` is in **seconds** (ML sends 21600 = 6h).
 * ML returns a fresh `refresh_token` on every call (single-use rotation).
 * See: developers.mercadolivre.com.br — Autenticação e Autorização.
 */
export const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().min(1),
    expires_in: z.number(),
    scope: z.string().nullable().optional(),
    user_id: z.number().int().nullable().optional(),
    refresh_token: z.string().min(1),
  })
  .passthrough();
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

/**
 * OAuth error body (`400`/`401`). We surface `error` / `error_description` /
 * `message` / `status`; any other keys ML sends (e.g. a `cause` array) ride
 * through `.passthrough()` untyped. `invalid_grant` means the authorization
 * code / refresh token is expired, revoked, or already used → re-consent needed.
 */
export const tokenErrorSchema = z
  .object({
    error: z.string().optional(),
    error_description: z.string().optional(),
    message: z.string().optional(),
    status: z.number().optional(),
  })
  .passthrough();
export type TokenError = z.infer<typeof tokenErrorSchema>;

/* -------------------------------------------------------------------------- */
/*                              REST resources                                */
/* -------------------------------------------------------------------------- */

/** `GET /users/me` (and `/users/{id}`) — only the fields we key on. */
export const userSchema = z
  .object({
    id: z.number().int(),
    nickname: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    site_id: z.string().nullable().optional(),
    // Account capability tags — `warehouse_management` marks multiorigin
    // accounts, whose stock cannot be sent via PUT /items.
    tags: z.array(z.string()).nullable().optional(),
  })
  .passthrough();
export type MlUser = z.infer<typeof userSchema>;

/**
 * One embedded item/variation attribute (`attributes[]` /
 * `attribute_combinations[]`). Every field is optional so a single odd entry
 * (or ML drift) never fails the whole item parse; the import mapper filters by
 * `id` (`SELLER_SKU`, `WEIGHT`, `SELLER_PACKAGE_*`, `SIZE`, `COLOR`…).
 */
export const itemAttributeSchema = z
  .object({
    id: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    value_id: z.string().nullable().optional(),
    value_name: z.string().nullable().optional(),
    attribute_group_id: z.string().nullable().optional(),
    attribute_group_name: z.string().nullable().optional(),
    unit_id: z.string().nullable().optional(),
  })
  .passthrough();
export type MlItemAttribute = z.infer<typeof itemAttributeSchema>;

/** One item picture (`pictures[]`). `secure_url` carries a size-code suffix. */
export const itemPictureSchema = z
  .object({
    id: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    secure_url: z.string().nullable().optional(),
    size: z.string().nullable().optional(),
    max_size: z.string().nullable().optional(),
  })
  .passthrough();
export type MlItemPicture = z.infer<typeof itemPictureSchema>;

/** A variation inside an item (`variations[]`). */
export const itemVariationSchema = z
  .object({
    // ML has sent numeric and (rarely) string ids over time — accept both.
    id: z.union([z.number(), z.string()]).nullable().optional(),
    available_quantity: z.number().nullable().optional(),
    price: z.number().nullable().optional(),
    seller_custom_field: z.string().nullable().optional(),
    /** User-Products model: each variation is its own item. */
    item_relations: z.array(z.unknown()).nullable().optional(),
    attribute_combinations: z.array(itemAttributeSchema).nullable().optional(),
    attributes: z.array(itemAttributeSchema).nullable().optional(),
    picture_ids: z.array(z.string()).nullable().optional(),
  })
  .passthrough();
export type MlItemVariation = z.infer<typeof itemVariationSchema>;

/** `GET /items/{id}` (and the `POST/PUT /items` response) — the listing. */
export const itemSchema = z
  .object({
    id: z.string(),
    title: z.string().nullable().optional(),
    /** User-Products model — ML titles the listing from the family. */
    family_name: z.string().nullable().optional(),
    /** User-Products model — groups sibling items (one MLB item per variation, #521). */
    family_id: z.union([z.string(), z.number()]).nullable().optional(),
    user_product_id: z.string().nullable().optional(),
    /** User-Products model — the variation identity lives at the item ROOT (no `variations[]`). */
    attribute_combinations: z.array(itemAttributeSchema).nullable().optional(),
    category_id: z.string().nullable().optional(),
    price: z.number().nullable().optional(),
    /** Normal price (promo/`price` may be lower); import uses `base_price ?? price`. */
    base_price: z.number().nullable().optional(),
    available_quantity: z.number().nullable().optional(),
    condition: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    /** ML sub-status (`deleted`/`suspended`/`freezed`/`out_of_stock`…) — bot filtering. */
    sub_status: z.array(z.string()).nullable().optional(),
    listing_type_id: z.string().nullable().optional(),
    seller_id: z.number().int().nullable().optional(),
    seller_custom_field: z.string().nullable().optional(),
    permalink: z.string().nullable().optional(),
    date_created: z.string().nullable().optional(),
    video_id: z.string().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
    shipping: z
      .object({ free_shipping: z.boolean().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    attributes: z.array(itemAttributeSchema).nullable().optional(),
    pictures: z.array(itemPictureSchema).nullable().optional(),
    variations: z.array(itemVariationSchema).nullable().optional(),
  })
  .passthrough();
export type MlItem = z.infer<typeof itemSchema>;

/**
 * `conditions` of one `GET /items/{id}/prices` entry — the applicability
 * window plus channel restrictions. `context_restrictions` values include
 * `channel_marketplace` and legacy `channel_mshops` (Mercado Shops is
 * discontinued — mshops-restricted entries are ignored by the handler).
 */
export const itemPricesConditionsSchema = z
  .object({
    context_restrictions: z.array(z.string()).nullable().optional(),
    start_time: z.string().nullable().optional(),
    end_time: z.string().nullable().optional(),
  })
  .passthrough();
export type MlItemPricesConditions = z.infer<typeof itemPricesConditionsSchema>;

/**
 * One `prices[]` entry of `GET /items/{id}/prices` — `type` is
 * `'standard' | 'promotion'` in practice but stays a plain string (ML adds
 * price types without notice).
 */
export const itemPricesEntrySchema = z
  .object({
    id: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
    amount: z.number().nullable().optional(),
    regular_amount: z.number().nullable().optional(),
    currency_id: z.string().nullable().optional(),
    last_updated: z.string().nullable().optional(),
    conditions: itemPricesConditionsSchema.nullable().optional(),
  })
  .passthrough();
export type MlItemPricesEntry = z.infer<typeof itemPricesEntrySchema>;

/**
 * `GET /items/{id}/prices` — the listing's full price set, consulted on the
 * `items_prices` webhook topic. Tolerance is deliberate (ML drifts fields
 * silently): only the entries the price handler keys on are typed.
 */
export const itemPricesSchema = z
  .object({
    id: z.string().nullable().optional(),
    prices: z.array(itemPricesEntrySchema).nullable().default([]),
  })
  .passthrough();
export type MlItemPrices = z.infer<typeof itemPricesSchema>;

/**
 * One `order_items[]` line. Lines have NO stable per-line id — identity is
 * `item.id` + `variation_id` + `seller_sku` (+ `element_id` in carts), and the
 * same publication can legitimately repeat, so reconciliation must never drop or
 * duplicate a line.
 */
export const orderItemSchema = z
  .object({
    item: z
      .object({
        id: z.string().nullable().optional(),
        title: z.string().nullable().optional(),
        variation_id: z.union([z.number(), z.string()]).nullable().optional(),
        seller_sku: z.string().nullable().optional(),
        seller_custom_field: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    quantity: z.number().nullable().optional(),
    unit_price: z.number().nullable().optional(),
    currency_id: z.string().nullable().optional(),
    element_id: z.union([z.number(), z.string()]).nullable().optional(),
  })
  .passthrough();

/** `GET /orders/{id}`. Can arrive `206 Partial Content` with `order_items` empty. */
export const orderSchema = z
  .object({
    id: z.number().int(),
    status: z.string().nullable().optional(),
    date_created: z.string().nullable().optional(),
    last_updated: z.string().nullable().optional(),
    pack_id: z.number().int().nullable().optional(),
    order_items: z.array(orderItemSchema).nullable().optional(),
    total_amount: z.number().nullable().optional(),
    currency_id: z.string().nullable().optional(),
    buyer: z
      .object({ id: z.number().int().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    shipping: z
      .object({ id: z.number().int().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    tags: z.array(z.string()).nullable().optional(),
  })
  .passthrough();
export type MlOrder = z.infer<typeof orderSchema>;

/** `GET /orders/search` — paged results. */
export const orderSearchSchema = z
  .object({
    results: z.array(orderSchema).default([]),
    paging: z
      .object({
        total: z.number().nullable().optional(),
        offset: z.number().nullable().optional(),
        limit: z.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type MlOrderSearch = z.infer<typeof orderSearchSchema>;

/** `GET /categories/{id}` — one category node. */
export const categorySchema = z
  .object({
    id: z.string(),
    name: z.string().nullable().optional(),
    path_from_root: z
      .array(z.object({ id: z.string(), name: z.string().nullable().optional() }).passthrough())
      .nullable()
      .optional(),
    settings: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();
export type MlCategory = z.infer<typeof categorySchema>;

/** One entry of `GET /categories/{id}/attributes`. */
export const categoryAttributeSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable().optional(),
    value_type: z.string().nullable().optional(),
    values: z
      .array(
        z
          .object({ id: z.string().nullable().optional(), name: z.string().nullable().optional() })
          .passthrough(),
      )
      .nullable()
      .optional(),
    tags: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();
export const categoryAttributesSchema = z.array(categoryAttributeSchema);
export type MlCategoryAttribute = z.infer<typeof categoryAttributeSchema>;

/** One entry of `GET /sites/MLB/domain_discovery/search?q=` (category suggestion). */
export const domainDiscoverySchema = z.array(
  z
    .object({
      domain_id: z.string().nullable().optional(),
      domain_name: z.string().nullable().optional(),
      category_id: z.string(),
      category_name: z.string().nullable().optional(),
      attributes: z.array(z.unknown()).nullable().optional(),
    })
    .passthrough(),
);
export type MlDomainDiscovery = z.infer<typeof domainDiscoverySchema>;

/** `POST /pictures/items/upload` — the uploaded picture's ML id. */
export const pictureUploadSchema = z
  .object({
    id: z.string(),
    variations: z.array(z.unknown()).nullable().optional(),
  })
  .passthrough();
export type MlPictureUpload = z.infer<typeof pictureUploadSchema>;

/** `GET/POST/PUT /items/{id}/description` — plain-text description. */
export const itemDescriptionSchema = z
  .object({
    plain_text: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    last_updated: z.string().nullable().optional(),
  })
  .passthrough();
export type MlItemDescription = z.infer<typeof itemDescriptionSchema>;

/** `GET /packs/{id}` — a cart grouping N orders (1 item-variation each). */
export const packSchema = z
  .object({
    id: z.number().int(),
    status: z.string().nullable().optional(),
    orders: z.array(z.object({ id: z.number().int() }).passthrough()).default([]),
    shipment: z
      .object({ id: z.number().int().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type MlPack = z.infer<typeof packSchema>;

/* --------------------- Order payments + shipments (Step 9 order import) --------------------- */

/** One entry of `payment.charge_details`/`charges_details[]` — fee/charge line items (legacy `ChargeDetailsMercadoLivre`, models.dart:4941-4979). Only the fields `toPagamento`'s tarifas calc reads are typed. */
export const mlPaymentChargeDetailSchema = z
  .object({
    accounts: z
      .object({ from: z.string().nullable().optional(), to: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    amounts: z
      .object({
        original: z.number().nullable().optional(),
        refunded: z.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type MlPaymentChargeDetail = z.infer<typeof mlPaymentChargeDetailSchema>;

/** One entry of `payment.fee_details[]` (legacy `FeeDetailsMercadoLivrePayment`, models.dart:4787-4800) — only `amount` feeds `toPagamento`'s tarifas total; `fee_payer`/`type` ride through `.passthrough()` untyped. */
export const mlPaymentFeeDetailSchema = z
  .object({
    amount: z.number().nullable().optional(),
  })
  .passthrough();
export type MlPaymentFeeDetail = z.infer<typeof mlPaymentFeeDetailSchema>;

/** One entry of `payment.refunds[]` (legacy `MercadoLivreRefund`, models.dart:4813-4845) — only `amount` feeds `toPagamento`'s refund total. */
export const mlPaymentRefundSchema = z
  .object({
    amount: z.number().nullable().optional(),
  })
  .passthrough();
export type MlPaymentRefund = z.infer<typeof mlPaymentRefundSchema>;

/**
 * `GET /collections/{paymentId}` (legacy `get_payment`, api.dart:1446-1454) — a
 * Mercado Pago payment tied to an ML order. Tolerant: only the fields
 * `MercadoLivrePayment.toPagamento` (legacy models.dart:4455-4693) consumes are
 * typed — `payer` is unused by the mapper and rides through `.passthrough()`
 * untyped, and `card` is typed only down to `last_four_digits`.
 */
export const mlPaymentSchema = z
  .object({
    id: z.number().int(),
    date_created: z.string().nullable().optional(),
    date_approved: z.string().nullable().optional(),
    date_last_updated: z.string().nullable().optional(),
    last_modified: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    transaction_amount: z.number().nullable().optional(),
    total_paid_amount: z.number().nullable().optional(),
    shipping_cost: z.number().nullable().optional(),
    coupon_amount: z.number().nullable().optional(),
    status: z.string().nullable().optional(),
    /** Consumed by the payments-topic handler (legacy tasks.dart:1172/1176 — NONE-marketplace skip + order-key resolution). */
    marketplace: z.string().nullable().optional(),
    /** Consumed by the payments-topic handler for order-key resolution (legacy tasks.dart:1176). */
    external_reference: z.string().nullable().optional(),
    /** Consumed by the payments-topic handler for order-key resolution (legacy tasks.dart:1176). */
    order_id: z.number().int().nullable().optional(),
    installments: z.number().nullable().optional(),
    payment_type: z.string().nullable().optional(),
    payment_type_id: z.string().nullable().optional(),
    payment_method_id: z.string().nullable().optional(),
    card_id: z.number().nullable().optional(),
    card: z
      .object({ last_four_digits: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    authorization_code: z.string().nullable().optional(),
    marketplace_fee: z.number().nullable().optional(),
    fee_details: z.array(mlPaymentFeeDetailSchema).nullable().optional(),
    charge_details: z.array(mlPaymentChargeDetailSchema).nullable().optional(),
    charges_details: z.array(mlPaymentChargeDetailSchema).nullable().optional(),
    refunds: z.array(mlPaymentRefundSchema).nullable().optional(),
  })
  .passthrough();
export type MlPayment = z.infer<typeof mlPaymentSchema>;

/** One `shipping_option.estimated_*` sub-object — every variant is `{ date: string|null, ... }`; only `date` is consumed. */
const mlShipmentEstimatedDateSchema = z
  .object({ date: z.string().nullable().optional() })
  .passthrough();

/** `shipment.shipping_option` (legacy `ShippingOption`, models.dart:6052-6127) — only the dispatch/delivery-window fields `_getPrazoDespacho`/`toFrete` read. */
export const mlShipmentOptionSchema = z
  .object({
    list_cost: z.number().nullable().optional(),
    estimated_handling_limit: mlShipmentEstimatedDateSchema.nullable().optional(),
    estimated_delivery_limit: mlShipmentEstimatedDateSchema.nullable().optional(),
    estimated_delivery_time: mlShipmentEstimatedDateSchema.nullable().optional(),
  })
  .passthrough();
export type MlShipmentOption = z.infer<typeof mlShipmentOptionSchema>;

/**
 * `GET /shipments/{shipmentId}` (legacy `get_shipment`, api.dart:1635-1641) — a
 * shipment tied to an ML order. Tolerant: only the fields
 * `MercadoLivreShipping.toFrete`/`toEstadoFrete` (legacy models.dart:5340-5394)
 * consume are typed (address fields are resolved from billing_info instead, so
 * `receiver_address`/`sender_address` are left untyped on `.passthrough()`).
 */
export const mlShipmentSchema = z
  .object({
    id: z.number().int(),
    order_id: z.number().int().nullable().optional(),
    status: z.string().nullable().optional(),
    substatus: z.string().nullable().optional(),
    tracking_number: z.string().nullable().optional(),
    last_updated: z.string().nullable().optional(),
    base_cost: z.number().nullable().optional(),
    logistic_type: z.string().nullable().optional(),
    shipping_option: mlShipmentOptionSchema.nullable().optional(),
  })
  .passthrough();
export type MlShipment = z.infer<typeof mlShipmentSchema>;

/**
 * One entry of `GET /shipments/{shipmentId}/payments` — **the endpoint returns
 * a bare JSON ARRAY**, not `{ results: [...] }` (legacy `get_shipment_payments`,
 * api.dart:1652-1661, returns `List<Map<String,dynamic>>`). Only `status` +
 * `amount` are consumed (legacy `toFrete`, models.dart:5372-5378); `amount` has
 * been observed as both a JSON number and a numeric string in the wild, hence
 * the union.
 */
export const mlShipmentPaymentSchema = z
  .object({
    status: z.string().nullable().optional(),
    amount: z.union([z.number(), z.string()]).nullable().optional(),
  })
  .passthrough();
export type MlShipmentPayment = z.infer<typeof mlShipmentPaymentSchema>;
/** The array wrapper for `getShipmentPayments` — see `mlShipmentPaymentSchema`. */
export const mlShipmentPaymentsSchema = z.array(mlShipmentPaymentSchema);

/**
 * One entry of `GET /shipments/{shipmentId}/orders` — "Vendas associadas a um
 * envio" (ML docs, *Gerenciamento de Envios*). **The endpoint returns a bare
 * JSON ARRAY** and requires the `X-New-Domain: true` header. One row per
 * (order, listing, variation) covered by the shipment, carrying the units the
 * buyer asked for.
 *
 * This is the modern replacement for legacy's `get_shipment_items`
 * (`GET /shipments/{id}/items`, api.dart:1679-1685), used by the
 * shipment↔pedido item cross-check (`applyFreteStep`, #669). Chosen over
 * `/items` on three counts:
 *  - `requested_quantity` is the quantity the buyer ORDERED, which is what
 *    `ItemDoPedido.quantidade` holds (it comes from `order_items[].quantity`);
 *    `/items`' `quantity` is the quantity in THIS shipment, which legitimately
 *    differs on a partial shipment and would flag correct orders.
 *  - `variation_id` here is a documented nullable Long. `/items` uses `0` as
 *    its "no variation" sentinel, which does not exist on the order side — an
 *    asymmetry that silently mismatches variation sales.
 *  - ML declared `order_id`/`external_reference` discontinued in the shipments
 *    resources as of 2025-10-12; `/items` carries them, this resource is the
 *    one ML is steering toward.
 *
 * Tolerant per house style: the docs type `order_id`/`pack_id` as String and
 * `variation_id`/`seller_id` as Long, but ML has sent ids both ways across this
 * API, so every id takes the number|string union. Everything not consumed by
 * the cross-check rides through `.passthrough()`.
 */
export const mlShipmentOrderSchema = z
  .object({
    order_id: z.union([z.number(), z.string()]).nullable().optional(),
    pack_id: z.union([z.number(), z.string()]).nullable().optional(),
    item_id: z.string().nullable().optional(),
    variation_id: z.union([z.number(), z.string()]).nullable().optional(),
    user_product_id: z.string().nullable().optional(),
    seller_id: z.union([z.number(), z.string()]).nullable().optional(),
    requested_quantity: z.union([z.number(), z.string()]).nullable().optional(),
  })
  .passthrough();
export type MlShipmentOrder = z.infer<typeof mlShipmentOrderSchema>;

/**
 * The array wrapper for `getShipmentOrders` — see `mlShipmentOrderSchema`.
 *
 * ⚠️ The `.nullish().transform()` is load-bearing, not cosmetic. The docs list
 * `204 No Content` ("Shipment não possui pedidos") as a normal response, and
 * `parseOk` leaves the parsed body `null` when it is empty — which a bare
 * `z.array(...)` rejects, turning a documented 204 into a
 * `MercadoLivreValidationError` and a parked import. Callers must therefore
 * treat `[]` as "ML told us nothing", never as "the shipment covers no items".
 */
export const mlShipmentOrdersSchema = z
  .array(mlShipmentOrderSchema)
  .nullish()
  .transform((v) => v ?? []);

/** `GET /shipments/{shipmentId}/sla` (legacy `get_shipment_sla`, api.dart:1671-1677) — only `expected_date` is consumed (legacy `_getPrazoDespacho`, tasks.dart:38-43). */
export const mlShipmentSlaSchema = z
  .object({
    expected_date: z.string().nullable().optional(),
  })
  .passthrough();
export type MlShipmentSla = z.infer<typeof mlShipmentSlaSchema>;

/**
 * `POST/GET /shipments/{shipmentId}/invoice_data` — the saved invoice record
 * (JSON) ML keeps for a shipment after the NF-e XML upload (Step 12, #739).
 * Tolerant: only the identifiers + `status` the caller keys on are typed; every
 * other field ML sends (`invoice_number`, `fiscal_key`…) rides through
 * `.passthrough()` untyped.
 */
export const mlShipmentInvoiceSchema = z
  .object({
    id: z.number().int().nullable().optional(),
    shipment_id: z.number().int().nullable().optional(),
    status: z.string().nullable().optional(),
  })
  .passthrough();
export type MlShipmentInvoice = z.infer<typeof mlShipmentInvoiceSchema>;

/** One weekday entry of the seller shipping schedule (legacy `_getPrazoDespacho`, tasks.dart:112-133: `schedule[day]['work']` / `schedule[day]['detail'][0]['cutoff']`). */
export const mlSellerShippingScheduleDaySchema = z
  .object({
    work: z.boolean().nullable().optional(),
    detail: z
      .array(z.object({ cutoff: z.string().nullable().optional() }).passthrough())
      .nullable()
      .optional(),
  })
  .passthrough();
export type MlSellerShippingScheduleDay = z.infer<typeof mlSellerShippingScheduleDaySchema>;

/**
 * `GET /users/{sellerId}/shipping/schedule/{logisticType}` (legacy
 * `get_horarios_despacho`, api.dart:1687-1693) — the seller's weekly dispatch
 * window, keyed by lowercase English weekday name (`monday`…`sunday`).
 */
export const mlSellerShippingScheduleSchema = z
  .object({
    schedule: z.record(z.string(), mlSellerShippingScheduleDaySchema).nullable().optional(),
  })
  .passthrough();
export type MlSellerShippingSchedule = z.infer<typeof mlSellerShippingScheduleSchema>;

/**
 * `GET /orders/{orderId}/billing_info` sent with header `x-version: 2` (legacy
 * `get_billing_info_v2`, api.dart:1432-1444) — the buyer's fiscal identity +
 * address for NF-e emission. Tolerant: only the fields `BillingInfoResponse`'s
 * `toEndereco`/`toCliente` (legacy api_types/billing_info.dart:74-113) consume
 * are typed; `seller` and `attributes` ride through `.passthrough()` untyped.
 */
export const mlBillingInfoSchema = z
  .object({
    site_id: z.string().nullable().optional(),
    buyer: z
      .object({
        cust_id: z.union([z.string(), z.number()]).nullable().optional(),
        billing_info: z
          .object({
            name: z.string().nullable().optional(),
            last_name: z.string().nullable().optional(),
            identification: z
              .object({
                type: z.string().nullable().optional(),
                number: z.string().nullable().optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
            taxes: z
              .object({
                inscriptions: z
                  .object({ state_registration: z.string().nullable().optional() })
                  .passthrough()
                  .nullable()
                  .optional(),
                taxpayer_type: z
                  .object({ description: z.string().nullable().optional() })
                  .passthrough()
                  .nullable()
                  .optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
            address: z
              .object({
                street_name: z.string().nullable().optional(),
                street_number: z.string().nullable().optional(),
                city_name: z.string().nullable().optional(),
                comment: z.string().nullable().optional(),
                neighborhood: z.string().nullable().optional(),
                state: z
                  .object({ name: z.string().nullable().optional() })
                  .passthrough()
                  .nullable()
                  .optional(),
                zip_code: z.string().nullable().optional(),
                country_id: z.string().nullable().optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type MlBillingInfo = z.infer<typeof mlBillingInfoSchema>;

/* --------------------- User-Products family fan-out (#521) --------------------- */

/**
 * `GET /sites/{siteId}/user-products-families/{familyId}` — the sibling
 * User-Product ids (`UPtin…`) of a family, keyed by `user_products_ids`
 * (legacy `providers/importacao.dart:174`: `familySearch['user_products_ids']`).
 */
export const userProductFamilySchema = z
  .object({
    user_products_ids: z.array(z.string()).default([]),
  })
  .passthrough();
export type MlUserProductFamily = z.infer<typeof userProductFamilySchema>;

/**
 * `GET /users/{sellerId}/items/search?user_product_id=<csv>` — the MLB item
 * ids for a batch of User-Product ids, keyed by `results` (legacy
 * `providers/importacao.dart:179`: `mlbIdSearch['results']`).
 */
export const userProductItemsSearchSchema = z
  .object({
    results: z.array(z.string()).default([]),
  })
  .passthrough();
export type MlUserProductItemsSearch = z.infer<typeof userProductItemsSearchSchema>;

/* --------------------- Mass import seller scan (#621) --------------------- */

/**
 * `GET /users/{sellerId}/items/search?search_type=scan[&scroll_id=]` — the
 * seller's full listing set, one page (up to ~100 ids) per call. Keyed by
 * `results` (MLB item ids) + `scroll_id` (legacy `importacao.dart:119-188`:
 * `resultado['results']` / `resultado['scroll_id']`); the caller stops paging
 * once `results` is empty OR `scroll_id` comes back absent/empty — there is no
 * `limit` param on this endpoint (unlike `searchItemsByUserProduct`).
 */
export const sellerItemsScanSchema = z
  .object({
    scroll_id: z.string().nullable().optional(),
    results: z.array(z.string()).default([]),
    paging: z
      .object({ total: z.number().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type MlSellerItemsScan = z.infer<typeof sellerItemsScanSchema>;

/* --------------------- User-Products migration (#441) --------------------- */

/**
 * One entry of `GET /items/{id}/migration_live_listing` — only the two fields
 * the migration handler consumes (legacy `tasks.dart:871-1036`):
 * `new_item_id` (the new User-Products member's MLB item id) and
 * `variation_id` (the OLD numeric legacy variation id it replaces). ML has
 * sent both as string and number over time — accept either.
 */
export const migrationNewItemSchema = z
  .object({
    new_item_id: z.union([z.string(), z.number()]).nullable().optional(),
    variation_id: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .passthrough();
export type MlMigrationNewItem = z.infer<typeof migrationNewItemSchema>;

/**
 * `GET /items/{id}/migration_live_listing` — the new User-Products items a
 * legacy `variations[]` listing was migrated to, keyed by `new_items`
 * (legacy `tasks.dart:871-1036`).
 */
export const migrationLiveListingSchema = z
  .object({
    new_items: z.array(migrationNewItemSchema).default([]),
  })
  .passthrough();
export type MlMigrationLiveListing = z.infer<typeof migrationLiveListingSchema>;

/* ------------------------------ Size charts ------------------------------ */

/**
 * `GET /domains/{id}/technical_specs` and the `?section=grids` POST variant —
 * the spec tree the chart-cadastro UI renders (groups → components →
 * attributes with tags like `grid_template_required` / `grid_filter` /
 * `main_attribute_candidate`). Deliberately near-opaque: the shape is deep,
 * ML-owned and consumed by the UI, so every level is passthrough.
 */
export const technicalSpecsSchema = z
  .object({
    attributes: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
    groups: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  })
  .passthrough();
export type MlTechnicalSpecs = z.infer<typeof technicalSpecsSchema>;

/** One row of a chart API response (`rows[].id` = `'<chartId>:<n>'`). */
export const sizeChartApiRowSchema = z
  .object({
    id: z.union([z.string(), z.number()]).nullable().optional(),
    attributes: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  })
  .passthrough();

/**
 * `POST /catalog/charts` / `PUT /catalog/charts/{id}` / row endpoints — the
 * full chart the API echoes back (create AND row calls return the whole
 * chart; the legacy write-back reads `id`, `main_attribute_id` and the
 * per-index `rows[].id`).
 */
export const sizeChartApiSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    main_attribute_id: z.string().nullable().optional(),
    rows: z.array(sizeChartApiRowSchema).nullable().optional(),
  })
  .passthrough();
export type MlSizeChartApi = z.infer<typeof sizeChartApiSchema>;

/** `GET /catalog/charts/{site}/configurations/active_domains`. */
export const activeChartDomainsSchema = z
  .object({
    domains: z.array(z.object({ domain_id: z.string() }).passthrough()).default([]),
  })
  .passthrough();
export type MlActiveChartDomains = z.infer<typeof activeChartDomainsSchema>;

/** `GET /catalog_domains/{id}` — human label for the domain picker. */
export const catalogDomainSchema = z
  .object({
    id: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
  })
  .passthrough();
export type MlCatalogDomain = z.infer<typeof catalogDomainSchema>;

/* --------------------- Claims / reclamações (Step 14) --------------------- */

/**
 * One `players[]` entry of a claim (legacy `_Players`, models.dart:4007-4034).
 * `role` is `complainant`/`respondent`/`mediator` and `type` is the per-resource
 * party name (`buyer`/`seller`, `payer`/`collector`, `receiver`/`sender`,
 * `internal`) — both stay plain strings (NEVER enums): ML adds vocabulary
 * without notice and an unknown value must not fail the claim parse.
 * `available_actions` rides through `.passthrough()` untyped.
 */
export const mlClaimPlayerSchema = z
  .object({
    role: z.string().nullable().default(null),
    type: z.string().nullable().default(null),
    user_id: z.number().int().nullable().default(null),
  })
  .passthrough();
export type MlClaimPlayer = z.infer<typeof mlClaimPlayerSchema>;

/**
 * `claim.resolution` (legacy `_Resolution`, models.dart:4105-4135) — how the
 * claim was closed. Every field tolerates null AND absence (→ null): the legacy
 * DTO required `reason`/`closed_by`, but ML has drifted fields before and a
 * missing one must not fail the whole claim parse. `benefited` rides through
 * `.passthrough()` untyped (only `decision` feeds the legacy comment line).
 */
export const mlClaimResolutionSchema = z
  .object({
    reason: z.string().nullable().default(null),
    date_created: z.string().nullable().default(null),
    decision: z.array(z.string()).nullable().default(null),
    closed_by: z.string().nullable().default(null),
  })
  .passthrough();
export type MlClaimResolution = z.infer<typeof mlClaimResolutionSchema>;

/**
 * `GET /post-purchase/v1/claims/{claimId}` (legacy `Claims` DTO,
 * models.dart:3827-3951; a verbatim payload sample sits at models.dart:3762-3825).
 * Only the identifiers are required; every vocabulary field (`type`, `stage`,
 * `status`, `reason_id`) is a plain nullable string — the legacy Dart enums
 * (`_typeClaims`/`_StageClaims`/`_StatusClaims`) THREW on unknown values, which
 * is exactly the failure mode this schema avoids. `labels`, `coverages`,
 * `fulfilled`, `site_id`… ride through `.passthrough()` untyped.
 */
export const mlClaimSchema = z
  .object({
    id: z.number().int(),
    type: z.string().nullable().default(null),
    stage: z.string().nullable().default(null),
    status: z.string().nullable().default(null),
    /** The complained-about resource id — an order/pack/shipment/payment id depending on `resource`. */
    resource_id: z.number().int(),
    /** `order`/`pack`/`shipment`/`payment`/`purchase` (legacy `_ResourceClaims`, models.dart:3724-3755). */
    resource: z.string(),
    reason_id: z.string().nullable().default(null),
    players: z
      .array(mlClaimPlayerSchema)
      .nullish()
      .transform((v) => v ?? []),
    resolution: mlClaimResolutionSchema.nullable().default(null),
    date_created: z.string(),
    last_updated: z.string().nullable().default(null),
  })
  .passthrough();
export type MlClaim = z.infer<typeof mlClaimSchema>;

/**
 * One `attachments[]` entry of a claim message (legacy `_Attachment`,
 * models.dart:3611-3634). `filename` is the download key
 * (`…/attachments/{filename}/download`); everything else is display-only.
 */
export const mlClaimMessageAttachmentSchema = z
  .object({
    filename: z.string(),
    original_filename: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
    size: z.number().nullable().optional(),
    date_created: z.string().nullable().optional(),
  })
  .passthrough();
export type MlClaimMessageAttachment = z.infer<typeof mlClaimMessageAttachmentSchema>;

/**
 * One entry of `GET /post-purchase/v1/claims/{claimId}/messages` — **the
 * endpoint returns a bare JSON ARRAY** (legacy `getClaimMessages`,
 * api.dart:1505-1511, returns `List<Map<String,dynamic>>`; DTO `ClaimsMessage`,
 * models.dart:3540-3600). The role/stage vocabulary stays plain strings and the
 * legacy doc-id recipe hashes `sender_role`+`receiver_role`+`stage`+
 * `date_created`+`message` — so those five drive dedup, not display.
 */
export const mlClaimMessageSchema = z
  .object({
    sender_role: z.string().nullable().default(null),
    receiver_role: z.string().nullable().default(null),
    stage: z.string().nullable().default(null),
    message: z.string().default(''),
    date_created: z.string(),
    attachments: z
      .array(mlClaimMessageAttachmentSchema)
      .nullish()
      .transform((v) => v ?? []),
  })
  .passthrough();
export type MlClaimMessage = z.infer<typeof mlClaimMessageSchema>;
/** The array wrapper for `getClaimMessages` — see `mlClaimMessageSchema`. */
export const mlClaimMessagesSchema = z.array(mlClaimMessageSchema);

/**
 * `GET /post-purchase/v1/claims/reasons/{reasonId}` (legacy `getClaimReason`,
 * api.dart:1496-1503) — the human-readable claim reason. The legacy handler
 * reads `detail ?? name` for the motivo text (tasks.dart:1778) and `id`/
 * `date_created`/`last_updated` for the motivo message doc — all tolerated
 * missing so an ML drift degrades to "unknown reason", never a parse failure.
 */
export const mlClaimReasonSchema = z
  .object({
    id: z.union([z.string(), z.number()]).nullable().optional(),
    detail: z.string().nullable().default(null),
    name: z.string().nullable().default(null),
    date_created: z.string().nullable().optional(),
    last_updated: z.string().nullable().optional(),
  })
  .passthrough();
export type MlClaimReason = z.infer<typeof mlClaimReasonSchema>;

/**
 * `GET /post-purchase/v1/claims/search` (legacy `searchClaims`,
 * api.dart:1478-1494) — paged claims, keyed by `data` (NOT the `results`
 * envelope other ML searches use) + `paging`. Both default when absent so a
 * degenerate response yields an empty page instead of a parse failure.
 */
export const mlClaimSearchSchema = z
  .object({
    paging: z
      .object({
        total: z.number().nullable().optional(),
        offset: z.number().nullable().optional(),
        limit: z.number().nullable().optional(),
      })
      .passthrough()
      .default({}),
    data: z.array(mlClaimSchema).default([]),
  })
  .passthrough();
export type MlClaimSearch = z.infer<typeof mlClaimSearchSchema>;
