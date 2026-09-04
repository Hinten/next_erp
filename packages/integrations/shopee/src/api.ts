/**
 * The two typed Shopee clients.
 *
 * They are separate factories rather than one client with optional credentials,
 * because they sign DIFFERENTLY and one of them is the reason the conta screen
 * works at all:
 *
 *  - {@link createShopeePartnerClient} is **Public-signed**. It never asks for an
 *    access token, so it answers even when the stored token has lapsed — which
 *    is what lets `apps/shopee` tell "the authorization was revoked" from "the
 *    4-hour access token expired". A single client with an optional token would
 *    have made that a runtime accident.
 *  - {@link createShopeeClient} is **Shop-signed** and needs a live token.
 *
 * ⚠️ FLAT vs WRAPPED is decided by the operation SCHEMA and by nothing else.
 * There is no mode flag: a flag would be a second source of truth that can
 * disagree with the schema, and Shopee is inconsistent enough that it would.
 *
 * ⚠️ No retry and no backoff here. `ShopeeRateLimitError` carries `kind`
 * (`'burst'` vs `'daily'`, which want opposite responses) and
 * `retryAfterSeconds`; durable retry belongs to the Cloud Tasks pipeline.
 */
import { type ShopeeTransport, type ShopeeWarning, shopeeCall } from './call';
import { SHOPEE_SURFACE, ShopeeConfigError } from './errors';
import type { ShopeeHosts } from './hosts';
import {
  type ShopeeProfile,
  type ShopeeShopInfo,
  type ShopeeShopsByPartner,
  shopeeProfileSchema,
  shopeeShopInfoSchema,
  shopeeShopsByPartnerSchema,
} from './types';

/**
 * ⚠️ Re-exported from here rather than from `index.ts`: `call.ts` is internal
 * (nothing outside this package may build a raw call), but `ShopeeWarning` is
 * the payload of a PUBLIC callback on both configs, so consumers must be able to
 * name it.
 */
export type { ShopeeWarning } from './call';

/** `GET` — Public-signed. The token-free connection oracle. */
export const SHOPEE_SHOPS_BY_PARTNER_PATH = '/api/v2/public/get_shops_by_partner';
/** `GET` — Shop-signed. FLAT response. */
export const SHOPEE_SHOP_INFO_PATH = '/api/v2/shop/get_shop_info';
/** `GET` — Shop-signed. WRAPPED response. */
export const SHOPEE_GET_PROFILE_PATH = '/api/v2/shop/get_profile';

/** Shopee's own bound on `get_shops_by_partner`. */
export const SHOPEE_MAX_PAGE_SIZE = 100;

export interface ShopeePartnerConfig {
  readonly partnerId: number;
  readonly partnerKey: string;
  readonly hosts: ShopeeHosts;
  readonly fetch?: typeof globalThis.fetch;
  /** Injected clock, milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Called on a SUCCESSFUL call that carried a `warning`. Never on a failure. */
  readonly onWarning?: (w: ShopeeWarning) => void;
}

export interface ShopeeClientConfig extends ShopeePartnerConfig {
  readonly shopId: number;
  /**
   * Returns a live (non-expired) access token. Refreshing it is the caller's
   * concern — this package holds no store.
   */
  readonly getAccessToken: () => Promise<string>;
}

export interface GetShopsByPartnerParams {
  /** 1…100. Defaults to 100. */
  readonly pageSize?: number;
  /** ≥ 1. Defaults to 1. */
  readonly pageNo?: number;
}

export interface ShopeePartnerClient {
  /**
   * Every shop that authorized this partner, with `auth_time` / `expire_time`.
   *
   * ⚠️ One page per call, deliberately: `more` is surfaced and the caller loops.
   * Auto-paging inside a client hides an unbounded number of provider calls
   * behind a single innocuous-looking `await`.
   */
  getShopsByPartner(p?: GetShopsByPartnerParams): Promise<ShopeeShopsByPartner>;
}

export interface ShopeeClient {
  getShopInfo(): Promise<ShopeeShopInfo>;
  /** The UNWRAPPED `response` object — the envelope never reaches the caller. */
  getProfile(): Promise<ShopeeProfile>;
}

function transportFrom(c: ShopeePartnerConfig): ShopeeTransport {
  const base = {
    partnerId: c.partnerId,
    partnerKey: c.partnerKey,
    apiHost: c.hosts.apiHost,
    fetch: c.fetch ?? globalThis.fetch,
    now: c.now ?? (() => Date.now()),
  };
  return c.onWarning === undefined ? base : { ...base, onWarning: c.onWarning };
}

export function createShopeePartnerClient(config: ShopeePartnerConfig): ShopeePartnerClient {
  const transport = transportFrom(config);

  return {
    // `async` so a bad page bound REJECTS rather than throwing synchronously —
    // a caller that only wrote `.catch()` would otherwise miss it.
    getShopsByPartner: async (p = {}) => {
      const pageSize = p.pageSize ?? SHOPEE_MAX_PAGE_SIZE;
      const pageNo = p.pageNo ?? 1;
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > SHOPEE_MAX_PAGE_SIZE) {
        throw new ShopeeConfigError(
          `page_size deve estar entre 1 e ${String(SHOPEE_MAX_PAGE_SIZE)} (recebido: ${JSON.stringify(pageSize)}).`,
        );
      }
      if (!Number.isSafeInteger(pageNo) || pageNo < 1) {
        throw new ShopeeConfigError(
          `page_no deve ser um inteiro >= 1 (recebido: ${JSON.stringify(pageNo)}).`,
        );
      }
      return shopeeCall(transport, {
        method: 'GET',
        path: SHOPEE_SHOPS_BY_PARTNER_PATH,
        // Public: no access token in the base string and none in the query.
        call: { class: 'public' },
        schema: shopeeShopsByPartnerSchema,
        surface: SHOPEE_SURFACE.business,
        query: { page_size: pageSize, page_no: pageNo },
      });
    },
  };
}

export function createShopeeClient(config: ShopeeClientConfig): ShopeeClient {
  if (!Number.isSafeInteger(config.shopId) || config.shopId <= 0) {
    throw new ShopeeConfigError(
      `shop_id deve ser um inteiro positivo (recebido: ${JSON.stringify(config.shopId)}).`,
    );
  }
  const transport = transportFrom(config);

  async function signedCall(): Promise<{
    readonly class: 'shop';
    readonly accessToken: string;
    readonly shopId: number;
  }> {
    return { class: 'shop', accessToken: await config.getAccessToken(), shopId: config.shopId };
  }

  return {
    getShopInfo: async () =>
      shopeeCall(transport, {
        // ⚠️ GET, although the reference page is headed POST: every generated
        // sample on that page uses GET with everything in the query, and the
        // legacy Flutter app called it with GET in production for years.
        method: 'GET',
        path: SHOPEE_SHOP_INFO_PATH,
        call: await signedCall(),
        schema: shopeeShopInfoSchema,
        surface: SHOPEE_SURFACE.business,
      }),

    getProfile: async () => {
      const res = await shopeeCall(transport, {
        method: 'GET',
        path: SHOPEE_GET_PROFILE_PATH,
        call: await signedCall(),
        // WRAPPED — and the wrapper is stripped here, so callers never see it.
        schema: shopeeProfileSchema,
        surface: SHOPEE_SURFACE.business,
      });
      return res.response;
    },
  };
}
