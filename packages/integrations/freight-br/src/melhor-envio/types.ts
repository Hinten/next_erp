/**
 * Melhor Envio API wire types (Zod schemas + inferred TS).
 *
 * Ported from the legacy Flutter package
 * `.old/packages/integracoes_frete/melhor_envio/lib/src/`, kept
 * **byte-faithful** to the live API
 * (https://docs.melhorenvio.com.br). Two deliberate robustness choices
 * over the legacy Dart models:
 *
 *  1. Every non-essential field is `.nullable().optional()` and objects
 *     `.passthrough()`. The legacy `CalculoDeFretesResponse200` marked
 *     `company` (and treated `price`) as **required** — but ME returns
 *     per-service ERROR entries shaped `{ id, name, error }` with no
 *     pricing/company when a carrier can't quote, which crashed the
 *     Dart decoder. Here an errored option parses cleanly and carries
 *     its `error` string.
 *  2. Monetary fields stay **strings** exactly as ME sends them
 *     (`"37.79"`); a caller parses to number at the edge — through
 *     `parseMePrice`, never a local `Number()`.
 *
 * ## ⚠️ Numbers on the wire — the convention, because this file has BOTH
 * directions in it
 *
 * A provider quoting a number is serializer-level drift, and a `z.number()`
 * that meets a quoted value rejects the WHOLE resource rather than that one
 * field. #1087 is the worked example: one quoted `order_id` stopped a payment
 * importing at all, and the notification parked. The repo's answer (#1249,
 * #1251) is `wireNumber()` / `wireInt()` from `@delfrance/core/wire` — tolerance
 * that never invents a value.
 *
 * ⚠️ But that sweep is only safe on a shape we READ. This file — unlike the
 * Mercado Livre and Mercado Pago `types.ts`, which hold response schemas
 * exclusively — **models both directions**, so it is split by direction below
 * and each half gets the opposite rule:
 *
 *  - **RESPONSE** shapes (`calculateOptionSchema`, `agencySchema`,
 *    `shipmentServiceSchema`, `balanceSchema`, `tokenResponseSchema`, …) go
 *    through `wireNumber()`. Three of their ids are REQUIRED, which is the
 *    sharp edge: one quoted `id` would discard the entire quote list, and a
 *    freight quote that fails is an order nobody can ship.
 *  - **REQUEST** shapes (`dimensionsWeightSchema`, `calculateRequestSchema`,
 *    `cartInsertRequestSchema`) keep a strict `z.number()`. Tolerance is the
 *    WRONG direction outbound: we must not send ME a stringified number
 *    because we accepted one. Those six lines are carve-outs in
 *    `packages/config-eslint/rules/integration-response-numbers-tolerant.test.js`,
 *    each with its reason.
 *
 * ⚠️ And ME's monetary fields are a THIRD answer, kept on purpose: they are
 * `z.union([z.string(), z.number()])` rather than either of the above. ME types
 * them inconsistently BY ENDPOINT and says so in this repo already — strings in
 * `calculate`, numbers in the cart 201 (see `cartItemSchema`). Coercing to a
 * number would change what every consumer holds; leaving them `z.string()` had
 * the MIRROR of the #1087 bug, because the day `calculate` answers with a JSON
 * number the whole option array fails to parse. The union accepts both and
 * `parseMePrice` is the one place the reading happens.
 */
import { z } from 'zod';

import { parseWireDecimal, wireNumber } from '@delfrance/core/wire';

/* -------------------------------------------------------------------------- */
/*                              OAuth token                                   */
/* -------------------------------------------------------------------------- */

/** `POST /oauth/token` success body (authorization_code or refresh_token). */
export const tokenResponseSchema = z
  .object({
    token_type: z.string().nullable().optional(),
    /** Seconds until the access token expires (ME: 2592000 = 30 days). */
    expires_in: wireNumber(),
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
  })
  .passthrough();
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

/**
 * `POST /oauth/token` failure body. ME returns RFC-6749 style
 * `{ error, error_description, hint }`; some paths add a Laravel
 * `message`. All optional — we surface whatever is present.
 */
export const tokenErrorSchema = z
  .object({
    error: z.string().nullable().optional(),
    error_description: z.string().nullable().optional(),
    hint: z.string().nullable().optional(),
    message: z.string().nullable().optional(),
  })
  .passthrough();
export type TokenError = z.infer<typeof tokenErrorSchema>;

/* -------------------------------------------------------------------------- */
/*                          shipment/calculate                                */
/* -------------------------------------------------------------------------- */

/**
 * A single volume / package: dimensions in cm, weight in kg.
 *
 * ⚠️ REQUEST shape — strict `z.number()` is CORRECT here and the four lines
 * below are carve-outs in the repo guard. This is what we SEND to ME, built by
 * `normalizeVolume`; accepting a stringified dimension would mean forwarding
 * one, and ME answers a bad body with an opaque 422. Nothing outside this
 * package ever feeds it a provider value.
 */
export const dimensionsWeightSchema = z.object({
  width: z.number(),
  height: z.number(),
  length: z.number(),
  weight: z.number(),
});
export type DimensionsWeight = z.infer<typeof dimensionsWeightSchema>;

/**
 * `POST /api/v2/me/shipment/calculate` request. Per the legacy
 * `calcularFretePacote`: a single `package` object when there's one
 * volume, a `volumes` array when there are several. `options` carries
 * insurance/receipt/own_hand; `services` optionally limits the carriers
 * quoted (CSV of service ids).
 *
 * ⚠️ REQUEST shape — `insurance_value` stays a strict `z.number()`. It is a
 * declared value we send, derived from the pedido, never read off a provider.
 */
export const calculateRequestSchema = z
  .object({
    from: z.object({ postal_code: z.string().min(1) }).passthrough(),
    to: z.object({ postal_code: z.string().min(1) }).passthrough(),
    package: dimensionsWeightSchema.optional(),
    volumes: z.array(dimensionsWeightSchema).optional(),
    options: z
      .object({
        insurance_value: z.number().optional(),
        receipt: z.boolean().optional(),
        own_hand: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    services: z.string().optional(),
  })
  .passthrough();
export type CalculateRequest = z.infer<typeof calculateRequestSchema>;

export const deliveryRangeSchema = z
  .object({ min: wireNumber().nullable().optional(), max: wireNumber().nullable().optional() })
  .passthrough();

export const companySchema = z
  .object({
    id: wireNumber(),
    name: z.string(),
    picture: z.string().nullable().optional(),
  })
  .passthrough();
export type Company = z.infer<typeof companySchema>;

/**
 * One quote option in the calculate response array. A quotable option
 * carries `price`/`company`/`delivery_time`; an UNquotable one carries
 * only `id`/`name`/`error`. Everything pricing-related is therefore
 * nullable+optional (the fix over the legacy required-`company` crash).
 */
export const calculateOptionSchema = z
  .object({
    id: wireNumber(),
    name: z.string(),
    // ⚠️ A union, and deliberately neither of the other two answers — see the
    // file header. `z.string()` alone is the MIRROR of #1087: ME is documented
    // (in `cartItemSchema` below) to send these as NUMBERS on the cart 201, so
    // the day `calculate` does the same, `z.array(calculateOptionSchema)`
    // rejects every option and the operator gets no quotes at all. And
    // `wireNumber()` would change what every consumer holds. Read them through
    // `parseMePrice`, which is the one place the rule lives.
    price: z.union([z.string(), z.number()]).nullable().optional(),
    custom_price: z.union([z.string(), z.number()]).nullable().optional(),
    discount: z.union([z.string(), z.number()]).nullable().optional(),
    currency: z.string().nullable().optional(),
    delivery_time: wireNumber().nullable().optional(),
    delivery_range: deliveryRangeSchema.nullable().optional(),
    custom_delivery_time: wireNumber().nullable().optional(),
    custom_delivery_range: deliveryRangeSchema.nullable().optional(),
    company: companySchema.nullable().optional(),
    /** Present (with no pricing/company) when the carrier can't quote. */
    error: z.string().nullable().optional(),
  })
  .passthrough();
export type CalculateOption = z.infer<typeof calculateOptionSchema>;

export const calculateResponseSchema = z.array(calculateOptionSchema);
export type CalculateResponse = z.infer<typeof calculateResponseSchema>;

/** `true` when this option is a non-quotable error entry (has `error`, no price). */
export function isErroredOption(o: CalculateOption): boolean {
  return o.error != null || (o.price == null && o.company == null);
}

/**
 * A Melhor Envio monetary field (`price`, `custom_price`, `discount`) as a
 * number, or `null` when it is not one.
 *
 * ⚠️ **The one place ME's money is read.** It lives here rather than in the
 * screen that renders a quote because that screen had a private
 * `Number(s)` — which answers **0** for `''`, **31** for `'0x1F'` and **1000**
 * for `'1e3'`, on a value the operator then saves onto the pedido as the freight
 * they will be charged. `parseWireDecimal` is the repo's rule for exactly this
 * (#810: a coerced-from-garbage value is worse than a refused one), and a
 * private second copy of it is the bug that rule exists to prevent.
 *
 * The `number` branch is not hypothetical: `price` is a
 * `z.union([z.string(), z.number()])` precisely because ME types it by endpoint.
 *
 * Returns `null` — never `0` — for anything it cannot read. ⚠️ A caller that
 * turns that `null` into `0` is choosing to quote free shipping; make that
 * choice explicitly, at the call site, where it is visible.
 */
export function parseMePrice(v: string | number | null | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return parseWireDecimal(v);
}

/* -------------------------------------------------------------------------- */
/*                     shipment/services  and  agencies                        */
/* -------------------------------------------------------------------------- */

/** Coerce ME list endpoints (bare array, `{ data: [...] }` envelope, or an
 *  empty body) to a plain array before validating. */
function toArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v != null && typeof v === 'object' && Array.isArray((v as { data?: unknown }).data)) {
    return (v as { data: unknown[] }).data;
  }
  return [];
}

/**
 * `GET /api/v2/me/shipment/services` — one carrier service and its company.
 * Used to resolve which carrier a `service` id belongs to (so we can query
 * that carrier's drop-off agencies).
 */
export const shipmentServiceSchema = z
  .object({
    id: wireNumber(),
    name: z.string().nullable().optional(),
    company: companySchema.nullable().optional(),
  })
  .passthrough();
export type ShipmentService = z.infer<typeof shipmentServiceSchema>;

export const shipmentServicesResponseSchema = z.preprocess(toArray, z.array(shipmentServiceSchema));

/**
 * `GET /api/v2/me/shipment/agencies` — a carrier drop-off agency. Only `id` is
 * needed for the cart `agency`; the rest passes through. Drop-off carriers
 * (Jadlog, etc.) require one — ME returns an opaque 500 without it.
 */
export const agencySchema = z
  .object({
    id: wireNumber(),
    name: z.string().nullable().optional(),
    company: companySchema.nullable().optional(),
  })
  .passthrough();
export type Agency = z.infer<typeof agencySchema>;

export const agenciesResponseSchema = z.preprocess(toArray, z.array(agencySchema));

/** `422` validation body — `{ message, errors: { field: [msg, …] } }`. */
export const validationErrorSchema = z
  .object({
    message: z.string().nullable().optional(),
    errors: z.record(z.string(), z.array(z.string())).nullable().optional(),
  })
  .passthrough();
export type ValidationErrorBody = z.infer<typeof validationErrorSchema>;

/* -------------------------------------------------------------------------- */
/*                          /me  and  /me/balance                             */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/v2/me` — only the fields the ContaPanel shows. `.passthrough()`
 * keeps the rest of ME's large payload without us having to model it.
 */
export const meSchema = z
  .object({
    id: z.string().nullable().optional(),
    firstname: z.string().nullable().optional(),
    lastname: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    document: z.string().nullable().optional(),
  })
  .passthrough();
export type Me = z.infer<typeof meSchema>;

/** `GET /api/v2/me/balance` — wallet balance in BRL. */
export const balanceSchema = z
  .object({
    balance: wireNumber().nullable().optional(),
  })
  .passthrough();
export type Balance = z.infer<typeof balanceSchema>;

/* -------------------------------------------------------------------------- */
/*                          Etiqueta (label) flow                             */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/v2/me/orders/{id}` — a Melhor Envio order/label. Only the fields
 * the buy pipeline + the webhook status map read are modeled; `.passthrough()`
 * keeps ME's large payload (from/to/service/invoice/…). The lifecycle is
 * encoded as nullable timestamp strings: a non-null `paid_at`/`generated_at`
 * means that step is done; `canceled_at`/`suspended_at` are terminal.
 */
export const orderSchema = z
  .object({
    id: z.string(),
    protocol: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    tracking: z.string().nullable().optional(),
    self_tracking: z.string().nullable().optional(),
    paid_at: z.string().nullable().optional(),
    generated_at: z.string().nullable().optional(),
    posted_at: z.string().nullable().optional(),
    delivered_at: z.string().nullable().optional(),
    canceled_at: z.string().nullable().optional(),
    suspended_at: z.string().nullable().optional(),
    expired_at: z.string().nullable().optional(),
  })
  .passthrough();
export type Order = z.infer<typeof orderSchema>;

/**
 * `POST /api/v2/me/cart` (201) — the inserted cart item. The pipeline only
 * needs `id` (the label/order id it then checks out, generates and prints).
 * Monetary fields (`price`/`quote`) are intentionally NOT modeled: Melhor Envio
 * types them inconsistently across endpoints (strings in `calculate`, numbers
 * in the cart 201), so a fixed type would risk a parse failure — `.passthrough()`
 * keeps them available untyped for any caller that wants them.
 */
export const cartItemSchema = z
  .object({
    id: z.string(),
    protocol: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
  })
  .passthrough();
export type CartItem = z.infer<typeof cartItemSchema>;

/**
 * `POST /api/v2/me/cart` request. The full body (from/to/products/volumes/
 * options) is a domain mapping built server-side from the pedido + frete — the
 * package stays domain-neutral, so only the `service` ME requires is modeled
 * and the rest passes through.
 *
 * ⚠️ REQUEST shape — `service` stays a strict `z.number()`. It is the carrier
 * service id we picked, and ME rejects the cart insert if it arrives quoted.
 */
export const cartInsertRequestSchema = z
  .object({
    service: z.number(),
  })
  .passthrough();
export type CartInsertRequest = z.infer<typeof cartInsertRequestSchema>;

/** `POST /api/v2/me/shipment/print` → `{ url }` (the printable label URL). */
export const printResponseSchema = z.object({ url: z.string() }).passthrough();
export type PrintResponse = z.infer<typeof printResponseSchema>;

/**
 * Checkout / generate / tracking responses are keyed by order id (or wrap a
 * `purchase`) and the buy pipeline reads none of their body — it only needs
 * the call to succeed (a non-2xx throws upstream). Parsed permissively.
 */
export const opaqueResponseSchema = z.unknown();
