/**
 * Shopee's request signature: `sign = HMAC-SHA256(partner_key, base_string)`,
 * lowercase hex.
 *
 * ## The facts that are easy to get wrong
 *
 * - ⚠️ **The base string has NO separators.** The parts are concatenated
 *   directly: `partner_id` + `path` + `timestamp` (+ `access_token` + `shop_id`
 *   for a shop call). Joining them with `|` or `&` produces a well-formed,
 *   wrong signature and Shopee answers `error_sign` — a failure that reads like
 *   a credential problem. A near-miss test pins it.
 *   ⚠️ The PUSH signature is a different base string, WITH a `|` separator; it
 *   belongs with the receiver and is deliberately not in this module.
 * - ⚠️ **The signature covers neither the other query parameters nor the request
 *   body.** That is why {@link signedQuery} takes no body: adding one would
 *   suggest it is signed. Two requests with different bodies have the same
 *   `sign`, which a test asserts so nobody "fixes" it later.
 * - ⚠️ **The common parameters go in the QUERY STRING for GET and POST alike.**
 *   `partner_id`, `timestamp`, `sign`, plus `access_token` and `shop_id` (or
 *   `merchant_id`) for a signed-with-token call. A POST still carries them in
 *   the query; the JSON body carries only the operation's own parameters.
 * - `timestamp` is Unix SECONDS and Shopee accepts a ±5-minute window
 *   ({@link SHOPEE_SIGN_WINDOW_SECONDS}). The clock is injected (`nowMs`), never
 *   read here, so a test can pin an exact signature.
 *
 * ⚠️ **This module contains no `console.*` and must not grow one.** The shop
 * base string embeds the access token, so logging a base string — or a partial
 * one while debugging — writes a live credential to the log (#1015).
 */
import { createHmac } from 'node:crypto';

/** Shopee rejects a `timestamp` further than this from its own clock. */
export const SHOPEE_SIGN_WINDOW_SECONDS = 300;

export interface PublicSignParams {
  readonly partnerId: number;
  /** The API path alone, e.g. `/api/v2/shop/get_shop_info` — never a full URL. */
  readonly path: string;
  /** Unix SECONDS. */
  readonly timestamp: number;
}

export interface ShopSignParams extends PublicSignParams {
  readonly accessToken: string;
  readonly shopId: number;
}

export interface MerchantSignParams extends PublicSignParams {
  readonly accessToken: string;
  readonly merchantId: number;
}

/** `partner_id + path + timestamp` — no separators. */
export function publicBaseString(p: PublicSignParams): string {
  return `${String(p.partnerId)}${p.path}${String(p.timestamp)}`;
}

/** The public base string + `access_token` + `shop_id` — no separators. */
export function shopBaseString(p: ShopSignParams): string {
  return `${publicBaseString(p)}${p.accessToken}${String(p.shopId)}`;
}

/** The public base string + `access_token` + `merchant_id` — no separators. */
export function merchantBaseString(p: MerchantSignParams): string {
  return `${publicBaseString(p)}${p.accessToken}${String(p.merchantId)}`;
}

/**
 * HMAC-SHA256 of the base string under the partner key, LOWERCASE hex.
 *
 * Shopee compares the hex case-insensitively on the push side, but the request
 * signature is documented as lowercase and there is nothing to gain from
 * discovering whether the API agrees.
 */
export function signBaseString(base: string, partnerKey: string): string {
  return createHmac('sha256', partnerKey).update(base, 'utf8').digest('hex');
}

/** Which of the three base strings a call uses, and the ids it needs. */
export type SignedCall =
  | { readonly class: 'public' }
  | { readonly class: 'shop'; readonly accessToken: string; readonly shopId: number }
  | { readonly class: 'merchant'; readonly accessToken: string; readonly merchantId: number };

/** Unix seconds, floored — `…431_999` ms is still second `…431`. */
export function shopeeTimestamp(nowMs: number): number {
  return Math.floor(nowMs / 1000);
}

export interface SignedQueryParams {
  readonly partnerId: number;
  readonly partnerKey: string;
  readonly path: string;
  readonly call: SignedCall;
  /** Injected clock, in milliseconds. */
  readonly nowMs: number;
  /** Operation parameters that belong in the query. `undefined` values are dropped. */
  readonly extra?: Readonly<Record<string, string | number | undefined>>;
}

function baseStringFor(p: SignedQueryParams, timestamp: number): string {
  const common: PublicSignParams = {
    partnerId: p.partnerId,
    path: p.path,
    timestamp,
  };
  switch (p.call.class) {
    case 'public':
      return publicBaseString(common);
    case 'shop':
      return shopBaseString({
        ...common,
        accessToken: p.call.accessToken,
        shopId: p.call.shopId,
      });
    case 'merchant':
      return merchantBaseString({
        ...common,
        accessToken: p.call.accessToken,
        merchantId: p.call.merchantId,
      });
  }
}

/**
 * The complete query string for a signed call: the common parameters, then the
 * id parameters the call's class requires, then the operation's own extras.
 *
 * ⚠️ No body parameter, on purpose — see the module header.
 */
export function signedQuery(p: SignedQueryParams): URLSearchParams {
  const timestamp = shopeeTimestamp(p.nowMs);
  const sign = signBaseString(baseStringFor(p, timestamp), p.partnerKey);

  const qs = new URLSearchParams();
  qs.set('partner_id', String(p.partnerId));
  qs.set('timestamp', String(timestamp));
  qs.set('sign', sign);

  if (p.call.class === 'shop') {
    qs.set('access_token', p.call.accessToken);
    qs.set('shop_id', String(p.call.shopId));
  } else if (p.call.class === 'merchant') {
    qs.set('access_token', p.call.accessToken);
    qs.set('merchant_id', String(p.call.merchantId));
  }

  for (const [key, value] of Object.entries(p.extra ?? {})) {
    if (value !== undefined) qs.set(key, String(value));
  }
  return qs;
}
