/**
 * Shopee Open Platform wire schemas — RESPONSE shapes only.
 *
 * ## The envelope, and why `error` has no default
 *
 * Every Shopee response carries `{ request_id, error, message, warning }` at the
 * top level, and **success is `error === ''`, not HTTP 2xx** — a failing call is
 * routinely HTTP 200. So `error` is the load-bearing field, and it is declared
 * `z.string()` with NO `.default('')`: a body that does not carry it is a body we
 * cannot judge, and defaulting it would read that body as a SUCCESS. The other
 * three default to `null` because they are diagnostics.
 *
 * ⚠️ `warning` is a partial-failure channel, not a failure: an operation can
 * succeed and warn in the same breath. Nothing here may throw on it; `api.ts`
 * hands it to an `onWarning` hook and leaves it on the returned object.
 *
 * ## Flat vs wrapped
 *
 * Shopee is not consistent about where the payload lives. The auth endpoints,
 * `get_shop_info` and `get_shops_by_partner` put their fields **flat** beside the
 * envelope; `get_profile` and most business APIs nest them under `response`.
 * {@link flatOp} and {@link wrappedOp} are the two shapes, composed per
 * operation — the operation schema alone decides which, so there is no second
 * source of truth (a "mode" flag on the client) that could disagree with it.
 *
 * ## Numbers
 *
 * Every provider-inbound number goes through `wireInt()` / `wireNumber()` from
 * `@delfrance/core/wire`, never a bare strict number: a serializer that quotes
 * ONE field must not cost the whole resource (#1087). Enforced repo-wide by
 * `packages/config-eslint/rules/integration-response-numbers-tolerant.test.js`.
 *
 * Every object is `.passthrough()`: Shopee adds fields without notice, and an
 * unknown key must never fail a parse.
 */
import { z } from 'zod';

import { wireInt } from '@delfrance/core/wire';

/* -------------------------------------------------------------------------- */
/*                                 The envelope                               */
/* -------------------------------------------------------------------------- */

/**
 * The four common fields, as a spreadable raw shape rather than a schema to
 * `.extend()`, so a flat operation composes them with its own fields in one
 * `z.object` and the result stays a plain object schema.
 */
const envelopeShape = {
  request_id: z.string().nullable().default(null),
  /** ⚠️ NO default — `error === ''` IS the success signal. See the module header. */
  error: z.string(),
  message: z.string().nullable().default(null),
  warning: z.string().nullable().default(null),
} as const;

/** The envelope alone — stage 1 of the two-stage parse in `api.ts`. */
export const shopeeEnvelopeSchema = z.object(envelopeShape).passthrough();
export type ShopeeEnvelope = z.infer<typeof shopeeEnvelopeSchema>;

/** An operation whose payload sits FLAT beside the envelope fields. */
export function flatOp<T extends z.ZodRawShape>(shape: T) {
  return z.object({ ...envelopeShape, ...shape }).passthrough();
}

/** An operation whose payload is nested under `response`. */
export function wrappedOp<S extends z.ZodType>(inner: S) {
  return z.object({ ...envelopeShape, response: inner }).passthrough();
}

/* -------------------------------------------------------------------------- */
/*                                    Enums                                   */
/* -------------------------------------------------------------------------- */

/**
 * A shop's lifecycle state.
 *
 * ⚠️ Strict, deliberately: `.catch('NORMAL')` would read a BANNED shop as healthy
 * and the conta screen would say "connected" while nothing can be sold. This is a
 * low-frequency conta call whose failure is visible to the operator immediately,
 * which is exactly the trade that makes strictness affordable here.
 */
export const shopeeShopStatusSchema = z.enum(['BANNED', 'FROZEN', 'NORMAL']);
export type ShopeeShopStatus = z.infer<typeof shopeeShopStatusSchema>;
export const SHOPEE_SHOP_STATUS = {
  banned: 'BANNED',
  frozen: 'FROZEN',
  normal: 'NORMAL',
} as const satisfies Record<string, ShopeeShopStatus>;

/** Who issues the fiscal document for this shop. */
export const shopeeInvoiceIssuerSchema = z.enum(['Shopee', 'Other']);
export type ShopeeInvoiceIssuer = z.infer<typeof shopeeInvoiceIssuerSchema>;
export const SHOPEE_INVOICE_ISSUER = {
  shopee: 'Shopee',
  other: 'Other',
} as const satisfies Record<string, ShopeeInvoiceIssuer>;

/* -------------------------------------------------------------------------- */
/*                              The auth endpoints                            */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/v2/auth/token/get` — the code exchange. FLAT.
 *
 * ⚠️ `principal_id_list` is deliberately NOT declared: no page documents its
 * element shape, and a guessed shape is a parse failure waiting for the day
 * Shopee sends one. `.passthrough()` carries it through untouched.
 *
 * ⚠️ `expire_in` is read defensively by `expiresAtFrom` in `oauth.ts` — the docs
 * say seconds (samples 13859 / 14400) while one API sample looks like an absolute
 * epoch. The schema takes it verbatim; the interpretation lives in one function.
 */
export const shopeeTokenResponseSchema = flatOp({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expire_in: wireInt(),
  shop_id_list: z.array(wireInt()).nullable().default(null),
  merchant_id_list: z.array(wireInt()).nullable().default(null),
  supplier_id_list: z.array(wireInt()).nullable().default(null),
  user_id_list: z.array(wireInt()).nullable().default(null),
});
export type ShopeeTokenResponse = z.infer<typeof shopeeTokenResponseSchema>;

/**
 * `POST /api/v2/auth/access_token/get` — the refresh. FLAT.
 *
 * Refresh tokens ROTATE and are single-use, so the caller must persist what comes
 * back. The echoed id is whichever id class the refresh was keyed on.
 */
export const shopeeRefreshResponseSchema = flatOp({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expire_in: wireInt(),
  partner_id: wireInt().nullable().default(null),
  shop_id: wireInt().nullable().default(null),
  merchant_id: wireInt().nullable().default(null),
});
export type ShopeeRefreshResponse = z.infer<typeof shopeeRefreshResponseSchema>;

/* -------------------------------------------------------------------------- */
/*                              The read endpoints                            */
/* -------------------------------------------------------------------------- */

/** `GET /api/v2/shop/get_shop_info` — FLAT (no `response` wrapper). */
export const shopeeShopInfoSchema = flatOp({
  shop_name: z.string(),
  region: z.string(),
  status: shopeeShopStatusSchema,
  is_cb: z.boolean(),
  /** Seconds — when the seller granted the authorization. */
  auth_time: wireInt(),
  /** Seconds — when the AUTHORIZATION lapses (7–365 days), not the access token. */
  expire_time: wireInt(),
  merchant_id: wireInt().nullable().default(null),
  is_sip: z.boolean().nullable().default(null),
  shop_fulfillment_flag: z.string().nullable().default(null),
});
export type ShopeeShopInfo = z.infer<typeof shopeeShopInfoSchema>;

/** One row of `get_shops_by_partner.authed_shop_list`. */
export const shopeeAuthedShopSchema = z
  .object({
    region: z.string().nullable().default(null),
    shop_id: wireInt(),
    auth_time: wireInt(),
    expire_time: wireInt(),
    sip_affi_shop_list: z.array(z.unknown()).nullable().default(null),
  })
  .passthrough();
export type ShopeeAuthedShop = z.infer<typeof shopeeAuthedShopSchema>;

/**
 * `GET /api/v2/public/get_shops_by_partner` — FLAT, PUBLIC-signed.
 *
 * The token-free connection oracle: it answers with `auth_time`/`expire_time` per
 * authorized shop even when the access token has long lapsed, which is what lets
 * the conta screen tell "authorization revoked" from "token expired".
 */
export const shopeeShopsByPartnerSchema = flatOp({
  authed_shop_list: z.array(shopeeAuthedShopSchema),
  more: z.boolean(),
});
export type ShopeeShopsByPartner = z.infer<typeof shopeeShopsByPartnerSchema>;

/** The inner payload of `get_profile` — the shape callers actually receive. */
export const shopeeProfilePayloadSchema = z
  .object({
    shop_logo: z.string().nullable().default(null),
    description: z.string().nullable().default(null),
    shop_name: z.string().nullable().default(null),
    invoice_issuer: shopeeInvoiceIssuerSchema.nullable().default(null),
  })
  .passthrough();
export type ShopeeProfile = z.infer<typeof shopeeProfilePayloadSchema>;

/** `GET /api/v2/shop/get_profile` — WRAPPED under `response`. */
export const shopeeProfileSchema = wrappedOp(shopeeProfilePayloadSchema);
export type ShopeeProfileResponse = z.infer<typeof shopeeProfileSchema>;
