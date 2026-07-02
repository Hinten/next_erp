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
  })
  .passthrough();
export type MlUser = z.infer<typeof userSchema>;

/** A variation inside an item (`variations[]`). */
export const itemVariationSchema = z
  .object({
    // ML has sent numeric and (rarely) string ids over time — accept both.
    id: z.union([z.number(), z.string()]).nullable().optional(),
    available_quantity: z.number().nullable().optional(),
    seller_custom_field: z.string().nullable().optional(),
    attribute_combinations: z.array(z.unknown()).nullable().optional(),
  })
  .passthrough();

/** `GET /items/{id}` — the listing (anúncio). */
export const itemSchema = z
  .object({
    id: z.string(),
    title: z.string().nullable().optional(),
    category_id: z.string().nullable().optional(),
    price: z.number().nullable().optional(),
    available_quantity: z.number().nullable().optional(),
    status: z.string().nullable().optional(),
    listing_type_id: z.string().nullable().optional(),
    seller_id: z.number().int().nullable().optional(),
    seller_custom_field: z.string().nullable().optional(),
    variations: z.array(itemVariationSchema).nullable().optional(),
  })
  .passthrough();
export type MlItem = z.infer<typeof itemSchema>;

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
