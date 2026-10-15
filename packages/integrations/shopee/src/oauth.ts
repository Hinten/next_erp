/**
 * Shopee's consent flow and the two token endpoints — **SERVER-SIDE ONLY**.
 * Every call here signs with the `partner_key`, so importing this module into
 * browser code would bundle the secret.
 *
 * ## What Shopee's "OAuth" is not
 *
 * It is authorization-code SHAPED and is not RFC 6749. There is no
 * `client_secret` in any request (the HMAC `sign` stands in for it), no `scope`
 * (the app's immutable App Category fixes the permission set), and **no PKCE** —
 * `guide 20` has no `code_challenge` anywhere. `apps/shopee` therefore stores a
 * permanently-null `codeVerifier`; that is deliberate, not an omission.
 *
 * ⚠️ `state` is consequently the ONLY trust anchor on the callback. The legacy
 * Flutter app had none at all.
 */
import { shopeeCall, type ShopeeTransport } from './call';
import { SHOPEE_SURFACE, ShopeeConfigError } from './errors';
import type { ShopeeHosts } from './hosts';
import { shopeeRefreshResponseSchema, shopeeTokenResponseSchema } from './types';

/** `POST` — exchange the consent `code` for the first pair. */
export const SHOPEE_TOKEN_PATH = '/api/v2/auth/token/get';
/** `POST` — rotate the (single-use) refresh token. */
export const SHOPEE_REFRESH_PATH = '/api/v2/auth/access_token/get';

export interface ShopeeOAuthConfig {
  readonly partnerId: number;
  readonly partnerKey: string;
  readonly hosts: ShopeeHosts;
  readonly fetch?: typeof globalThis.fetch;
  /** Injected clock, milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface BuildAuthorizeUrlParams {
  readonly partnerId: number;
  readonly redirectUri: string;
  /** Opaque, signed, single-use. The only thing the callback can trust. */
  readonly state: string;
  readonly hosts: ShopeeHosts;
}

/**
 * The BR consent URL — `guide 20` "Format A", five parameters, **unsigned**.
 *
 * ⚠️ No `timestamp` and no `sign`. The legacy app built the obsolete signed
 * `/api/v2/shop/auth_partner?…&redirect=` link instead, and omitted three
 * parameters `guide 20` marks Required. A near-miss test pins the absence.
 */
export function buildAuthorizeUrl(p: BuildAuthorizeUrlParams): string {
  return consentUrl(p.hosts.authorizeUrlBase, p);
}

/** The de-authorization page — same five parameters, different path. */
export function buildCancelAuthUrl(p: BuildAuthorizeUrlParams): string {
  return consentUrl(p.hosts.cancelAuthUrlBase, p);
}

function consentUrl(base: string, p: BuildAuthorizeUrlParams): string {
  const url = new URL(base);
  // `URL.searchParams` percent-encodes each value, so a `state` carrying `&`,
  // `=` or a space round-trips instead of splitting the query.
  url.searchParams.set('partner_id', String(p.partnerId));
  url.searchParams.set('auth_type', 'seller');
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', p.state);
  return url.toString();
}

/* -------------------------------------------------------------------------- */
/*                                  Subjects                                  */
/* -------------------------------------------------------------------------- */

/**
 * Who the consent was for. Shopee's callback carries `shop_id` **or**
 * `main_account_id`, never both.
 *
 * ⚠️ The union is enforced again at RUNTIME, because `apps/shopee` builds this
 * from query parameters a browser supplied.
 */
export type ShopeeAuthSubject =
  | { readonly kind: 'shop'; readonly shopId: number }
  | { readonly kind: 'main_account'; readonly mainAccountId: number };

export type ShopeeAuthSubjectKind = ShopeeAuthSubject['kind'];
export const SHOPEE_AUTH_SUBJECT_KIND = {
  shop: 'shop',
  mainAccount: 'main_account',
} as const satisfies Record<string, ShopeeAuthSubjectKind>;

/**
 * Which id class a refresh is keyed on.
 *
 * ⚠️ NOT the same union as {@link ShopeeAuthSubject}: `main_account_id` is a
 * consent-time identity and is never a refresh key. Token pairs exist per id
 * class (`shop_id` / `merchant_id` / …) and are refreshed separately.
 */
export type ShopeeRefreshSubject =
  | { readonly kind: 'shop'; readonly shopId: number }
  | { readonly kind: 'merchant'; readonly merchantId: number };

export type ShopeeRefreshSubjectKind = ShopeeRefreshSubject['kind'];
export const SHOPEE_REFRESH_SUBJECT_KIND = {
  shop: 'shop',
  merchant: 'merchant',
} as const satisfies Record<string, ShopeeRefreshSubjectKind>;

/**
 * ⚠️ `Number.isSafeInteger`, not `> 0` alone. Shop ids run to eight digits today
 * but the guard is about `parseInt('123abc')` → `123` and `Number('')` → `0`
 * reaching us from a callback query string: a truncated id signs cleanly and
 * comes back `error_sign` or, worse, authorises the WRONG shop.
 */
function assertId(value: number, wireName: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ShopeeConfigError(
      `${wireName} deve ser um inteiro positivo (recebido: ${JSON.stringify(value)}).`,
    );
  }
}

function authSubjectBody(s: ShopeeAuthSubject): Record<string, number> {
  switch (s.kind) {
    case 'shop':
      assertId(s.shopId, 'shop_id');
      return { shop_id: s.shopId };
    case 'main_account':
      assertId(s.mainAccountId, 'main_account_id');
      return { main_account_id: s.mainAccountId };
  }
}

function refreshSubjectBody(s: ShopeeRefreshSubject): Record<string, number> {
  switch (s.kind) {
    case 'shop':
      assertId(s.shopId, 'shop_id');
      return { shop_id: s.shopId };
    case 'merchant':
      assertId(s.merchantId, 'merchant_id');
      return { merchant_id: s.merchantId };
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Expiry                                    */
/* -------------------------------------------------------------------------- */

/**
 * Above this, `expire_in` is read as an absolute epoch in seconds rather than a
 * duration.
 *
 * ⚠️ The docs say seconds-from-now (samples `13859`, `14400`) but one API sample
 * carries what can only be an absolute epoch. `1e9` seconds is 2001-09-09, so no
 * plausible DURATION reaches it (that would be 31 years) and every plausible
 * absolute epoch exceeds it. The two readings are pinned by a near-miss pair.
 */
export const SHOPEE_EPOCH_THRESHOLD_SECONDS = 1_000_000_000;

/** The documented access-token lifetime. Nothing longer is ever trusted. */
export const SHOPEE_MAX_ACCESS_TOKEN_MS = 4 * 60 * 60 * 1000;

/**
 * When the access token stops being usable, in epoch milliseconds.
 *
 * `nowMs` must be the instant the RESPONSE was received, never the instant the
 * request was sent: the difference is the round trip, and it is spent from the
 * token's four hours.
 *
 * ⚠️ Clamped DOWNWARDS only. A Shopee answer promising more than four hours is
 * capped; one promising less is believed.
 */
export function expiresAtFrom(expireIn: number, nowMs: number): number {
  const candidate =
    expireIn > SHOPEE_EPOCH_THRESHOLD_SECONDS ? expireIn * 1000 : nowMs + expireIn * 1000;
  return Math.min(candidate, nowMs + SHOPEE_MAX_ACCESS_TOKEN_MS);
}

/* -------------------------------------------------------------------------- */
/*                              The token endpoints                           */
/* -------------------------------------------------------------------------- */

export interface ShopeeTokenPair {
  readonly accessToken: string;
  /** Single-use and rotating — the caller MUST persist this one. */
  readonly refreshToken: string;
  readonly expiresAtMs: number;
  readonly requestId: string | null;
  /** Present on the code exchange; `null` on a refresh. */
  readonly shopIdList: readonly number[] | null;
  /** Present on the code exchange; `null` on a refresh. */
  readonly merchantIdList: readonly number[] | null;
}

function transportFrom(c: ShopeeOAuthConfig): ShopeeTransport {
  return {
    partnerId: c.partnerId,
    partnerKey: c.partnerKey,
    apiHost: c.hosts.apiHost,
    fetch: c.fetch ?? globalThis.fetch,
    now: c.now ?? (() => Date.now()),
  };
}

/**
 * Exchange the consent `code` for the first token pair.
 *
 * ⚠️ Public-signed — the base string carries no token, because there is none
 * yet — and yet `partner_id` still travels TWICE: once in the signed query, once
 * in the JSON body. That is Shopee's shape, not a mistake here.
 *
 * ⚠️ `sensitive: true`: this response body IS the credential, so a parse failure
 * logs the status and the byte count and never the body (#1015).
 */
export async function exchangeCode(
  config: ShopeeOAuthConfig,
  code: string,
  subject: ShopeeAuthSubject,
): Promise<ShopeeTokenPair> {
  const transport = transportFrom(config);
  const res = await shopeeCall(transport, {
    method: 'POST',
    path: SHOPEE_TOKEN_PATH,
    call: { class: 'public' },
    schema: shopeeTokenResponseSchema,
    surface: SHOPEE_SURFACE.auth,
    sensitive: true,
    body: { code, partner_id: config.partnerId, ...authSubjectBody(subject) },
  });

  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    // The RESPONSE-received instant, so the round trip is charged to the token.
    expiresAtMs: expiresAtFrom(res.expire_in, transport.now()),
    requestId: res.request_id,
    shopIdList: res.shop_id_list,
    merchantIdList: res.merchant_id_list,
  };
}

/**
 * Rotate the refresh token.
 *
 * ⚠️ A pure wire call, deliberately. The transactional store, the per-id lease
 * with an expiry, and the weekly authorization-expiry sweep are step 2 of the
 * master plan. The legacy app's `isRefreshing` flag stuck forever because its
 * rollback was commented out; nothing here holds a lock that could.
 */
export async function refreshAccessToken(
  config: ShopeeOAuthConfig,
  refreshToken: string,
  subject: ShopeeRefreshSubject,
): Promise<ShopeeTokenPair> {
  const transport = transportFrom(config);
  const res = await shopeeCall(transport, {
    method: 'POST',
    path: SHOPEE_REFRESH_PATH,
    call: { class: 'public' },
    schema: shopeeRefreshResponseSchema,
    surface: SHOPEE_SURFACE.auth,
    sensitive: true,
    body: {
      refresh_token: refreshToken,
      partner_id: config.partnerId,
      ...refreshSubjectBody(subject),
    },
  });

  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    expiresAtMs: expiresAtFrom(res.expire_in, transport.now()),
    requestId: res.request_id,
    // The refresh response echoes a single id, never the lists.
    shopIdList: null,
    merchantIdList: null,
  };
}
