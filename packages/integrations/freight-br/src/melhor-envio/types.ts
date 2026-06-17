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
 *     (`"37.79"`); the UI parses to number at the edge.
 */
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*                              OAuth token                                   */
/* -------------------------------------------------------------------------- */

/** `POST /oauth/token` success body (authorization_code or refresh_token). */
export const tokenResponseSchema = z
  .object({
    token_type: z.string().nullable().optional(),
    /** Seconds until the access token expires (ME: 2592000 = 30 days). */
    expires_in: z.number(),
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

/** A single volume / package: dimensions in cm, weight in kg. */
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
  .object({ min: z.number().nullable().optional(), max: z.number().nullable().optional() })
  .passthrough();

export const companySchema = z
  .object({
    id: z.number(),
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
    id: z.number(),
    name: z.string(),
    price: z.string().nullable().optional(),
    custom_price: z.string().nullable().optional(),
    discount: z.string().nullable().optional(),
    currency: z.string().nullable().optional(),
    delivery_time: z.number().nullable().optional(),
    delivery_range: deliveryRangeSchema.nullable().optional(),
    custom_delivery_time: z.number().nullable().optional(),
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
    balance: z.number().nullable().optional(),
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
