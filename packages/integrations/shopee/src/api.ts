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
 * ⚠️ FLAT vs WRAPPED vs DATA is decided by the operation SCHEMA and by nothing
 * else. There is no mode flag: a flag would be a second source of truth that can
 * disagree with the schema, and Shopee is inconsistent enough that it would.
 *
 * ⚠️ No retry and no backoff here. `ShopeeRateLimitError` carries `kind`
 * (`'burst'` vs `'daily'`, which want opposite responses) and
 * `retryAfterSeconds`; durable retry belongs to the Cloud Tasks pipeline.
 *
 * ⚠️ **No paging loop anywhere.** `getShopsByPartner` and `getBrandList` each
 * fetch ONE page and surface the cursor; the caller loops. Auto-paging inside a
 * client hides an unbounded number of provider calls behind one innocuous
 * `await`, and Shopee's brand API is slow enough that the difference is visible
 * to an operator.
 *
 * ## The taxonomy reads (step 10)
 *
 * Seven of them, all Shop-signed GETs on the `product` module, all read-only and
 * all validation-before-the-wire: a bound that cannot be satisfied REJECTS
 * without spending a provider call. Two of Shopee's own contradictions are
 * instrumented rather than guessed — the `get_variations` path (see
 * {@link SHOPEE_GET_VARIATION_TREE_PATH_ALT}) and the language casing (see
 * {@link SHOPEE_TAXONOMY_LANGUAGE}). This package never caches: the TTL cache
 * lives in `apps/shopee`, keyed per integração, because every one of these
 * answers is per shop.
 */
import { type ShopeeTransport, type ShopeeWarning, shopeeCall } from './call';
import { SHOPEE_SURFACE, ShopeeConfigError } from './errors';
import type { ShopeeHosts } from './hosts';
import {
  type ShopeeAttributeTree,
  type ShopeeBrandList,
  type ShopeeCategoryList,
  type ShopeeCategoryRecommend,
  type ShopeeGtinLimit,
  type ShopeeItemLimit,
  type ShopeeKitItemLimit,
  type ShopeeProfile,
  type ShopeeShopInfo,
  type ShopeeShopsByPartner,
  type ShopeeVariations,
  shopeeAttributeTreeSchema,
  shopeeBrandListSchema,
  shopeeCategoryListSchema,
  shopeeCategoryRecommendSchema,
  shopeeItemLimitSchema,
  shopeeKitItemLimitSchema,
  shopeeProfileSchema,
  shopeeShopInfoSchema,
  shopeeShopsByPartnerSchema,
  shopeeVariationsSchema,
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

/** `GET` — Shop-signed. WRAPPED. The whole category tree, unpaged. */
export const SHOPEE_GET_CATEGORY_PATH = '/api/v2/product/get_category';
/** `GET` — Shop-signed. WRAPPED. Up to 20 leaf categories per call. */
export const SHOPEE_GET_ATTRIBUTE_TREE_PATH = '/api/v2/product/get_attribute_tree';
/** `GET` — Shop-signed. WRAPPED. ONE page of a leaf category's brands. */
export const SHOPEE_GET_BRAND_LIST_PATH = '/api/v2/product/get_brand_list';
/** `GET` — Shop-signed. WRAPPED **plus** a `gtin_limit` sibling of `response`. */
export const SHOPEE_GET_ITEM_LIMIT_PATH = '/api/v2/product/get_item_limit';
/** `GET` — Shop-signed. WRAPPED. The kit bands, which are their own numbers. */
export const SHOPEE_GET_KIT_ITEM_LIMIT_PATH = '/api/v2/product/get_kit_item_limit';
/** `GET` — Shop-signed. Payload under **`data`**. The default; see the ALT below. */
export const SHOPEE_GET_VARIATIONS_PATH = '/api/v2/product/get_variations';
/** `GET` — Shop-signed. WRAPPED. Offered, never applied automatically. */
export const SHOPEE_CATEGORY_RECOMMEND_PATH = '/api/v2/product/category_recommend';

/**
 * The OTHER spelling of the `get_variations` path — and the reason the default is
 * overridable rather than settled here.
 *
 * ⚠️ Observed 2026-09-08 on the `v2.product.get_variations` reference page: its
 * `path`, `url` and `test_url` all say `/api/v2/product/get_variation_tree`,
 * while all four of its generated request samples call
 * `/api/v2/product/get_variations`. One of the two is wrong and the page cannot
 * say which.
 *
 * ⚠️ The path sits INSIDE the HMAC base string, so the wrong one does not fail as
 * a 404 — it fails as `error_sign`, which reads like a credential problem and
 * points nowhere near here. Hence the `hosts.ts` technique: default to the
 * samples ({@link SHOPEE_GET_VARIATIONS_PATH}), let `SHOPEE_VARIATIONS_PATH` in
 * `apps/shopee` swap in this constant, and settle it with one live sandbox call
 * instead of a code change.
 */
export const SHOPEE_GET_VARIATION_TREE_PATH_ALT = '/api/v2/product/get_variation_tree';

/** Shopee's own bound on `get_shops_by_partner`. */
export const SHOPEE_MAX_PAGE_SIZE = 100;

/** `get_attribute_tree`: "max count is 20" — a bound on `category_id_list`. */
export const SHOPEE_ATTRIBUTE_TREE_MAX_CATEGORIES = 20;

/** `get_brand_list`: `page_size` is documented `[1,100]`. */
export const SHOPEE_BRAND_MAX_PAGE_SIZE = 100;

/** `get_brand_list.status` — the only two values the page accepts. */
export const SHOPEE_BRAND_STATUS = { normal: 1, pending: 2 } as const;
export type ShopeeBrandStatus = (typeof SHOPEE_BRAND_STATUS)[keyof typeof SHOPEE_BRAND_STATUS];

/**
 * The language every taxonomy read asks for.
 *
 * ⚠️ Observed 2026-09-08: `get_category` and `get_brand_list` spell the Brazilian
 * option **`pt-br`**, while `get_attribute_tree` spells it **`pt-BR`**. Whether
 * the API folds the case is undocumented, and nothing in either page says.
 *
 * ONE constant is sent to all three, deliberately: a wrong guess is then a single
 * literal to flip, and `error_invalid_language` — which `apps/shopee` logs raw —
 * is the signal that says so. Two constants would have made the flip a search.
 */
export const SHOPEE_TAXONOMY_LANGUAGE = 'pt-br';

/**
 * Per-operation API path overrides.
 *
 * Only the operations whose documented path is CONTRADICTED by the same page
 * belong here. It is not a general-purpose routing hook: a path that is merely
 * unusual is a constant, not an override.
 */
export interface ShopeeApiPathOverrides {
  /** See {@link SHOPEE_GET_VARIATION_TREE_PATH_ALT}. */
  readonly getVariations?: string;
}

/**
 * A bare API path — leading `/`, no scheme, no host, no query, no fragment.
 *
 * ⚠️ Rejected rather than trimmed, and for the same reason `normalizeHost`
 * rejects a path-bearing origin: the path is part of the HMAC base string. An
 * override carrying a host would be signed as if it were a path and every call
 * would come back `error_sign`, with nothing in the message pointing here. A
 * query string would be signed too and then silently duplicated by `signedQuery`.
 */
export function normalizeApiPath(raw: string, envVar: string): string {
  const trimmed = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) {
    throw new ShopeeConfigError(
      `${envVar} deve ser apenas o caminho da API, sem esquema nem host (recebido: ${JSON.stringify(raw)}).`,
    );
  }
  if (!trimmed.startsWith('/')) {
    throw new ShopeeConfigError(
      `${envVar} deve começar com "/" (recebido: ${JSON.stringify(raw)}).`,
    );
  }
  if (trimmed.includes('?') || trimmed.includes('#')) {
    throw new ShopeeConfigError(
      `${envVar} não pode conter query nem fragmento (recebido: ${JSON.stringify(raw)}).`,
    );
  }
  return trimmed;
}

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
  /**
   * Overrides for the operations whose documented path contradicts its own
   * samples. Validated at CONSTRUCTION, so a bad value fails before any call.
   */
  readonly paths?: ShopeeApiPathOverrides;
}

export interface GetShopsByPartnerParams {
  /** 1…100. Defaults to 100. */
  readonly pageSize?: number;
  /** ≥ 1. Defaults to 1. */
  readonly pageNo?: number;
}

/** `get_attribute_tree` — 1…20 leaf category ids, sent as ONE joined parameter. */
export interface GetAttributeTreeParams {
  readonly categoryIds: readonly number[];
}

/** `get_brand_list` — one page. Every parameter is REQUIRED by Shopee. */
export interface GetBrandListParams {
  readonly categoryId: number;
  /** `0` for the first page, then the previous answer's `next_offset` VERBATIM. */
  readonly offset: number;
  /** 1…100. */
  readonly pageSize: number;
  /** 1 = normal, 2 = pending. See {@link SHOPEE_BRAND_STATUS}. */
  readonly status: number;
}

/**
 * `get_item_limit` — the category is OPTIONAL and its absence is meaningful: the
 * shop-wide bands are a documented read, not a degraded one.
 */
export interface GetItemLimitParams {
  readonly categoryId?: number;
}

/** `get_kit_item_limit` — same optional parameter, different bands entirely. */
export interface GetKitItemLimitParams {
  readonly categoryId?: number;
}

/** `get_variations` — a LEAF category id. */
export interface GetVariationsParams {
  readonly categoryId: number;
}

/** `category_recommend` — a non-blank item name, plus an optional cover image id. */
export interface CategoryRecommendParams {
  readonly itemName: string;
  /** The image id returned by `v2.media_space.upload_image`, never a URL. */
  readonly productCoverImage?: string;
}

/**
 * What `getItemLimit` hands back: the inner `response` AND the `gtin_limit`
 * SIBLING, because the page renders that field outside `response` and ships no
 * response sample. Merging the two positions is the reader's job in
 * `apps/shopee`; discarding one of them here would have hidden the answer.
 */
export interface ShopeeItemLimitRead {
  readonly response: ShopeeItemLimit;
  readonly gtin_limit: ShopeeGtinLimit | null;
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

  /** The whole category tree in one call. A leaf is `has_children === false`. */
  getCategory(): Promise<ShopeeCategoryList>;
  /**
   * The attribute tree of 1…20 categories.
   *
   * ⚠️ Each row carries its OWN `warning`, distinct from the envelope's; the
   * caller reads the row whose `category_id` it asked for, never `list[0]`.
   */
  getAttributeTree(p: GetAttributeTreeParams): Promise<ShopeeAttributeTree>;
  /** ONE page of a leaf category's brands. `brand_id: 0` is "No Brand", not absent. */
  getBrandList(p: GetBrandListParams): Promise<ShopeeBrandList>;
  /** The item bands, plus the `gtin_limit` sibling. See {@link ShopeeItemLimitRead}. */
  getItemLimit(p?: GetItemLimitParams): Promise<ShopeeItemLimitRead>;
  /** The KIT bands — never derived from {@link ShopeeClient.getItemLimit}'s. */
  getKitItemLimit(p?: GetKitItemLimitParams): Promise<ShopeeKitItemLimit>;
  /** The standardised variation tree. Payload under `data`, not `response`. */
  getVariations(p: GetVariationsParams): Promise<ShopeeVariations>;
  /** Category ids Shopee suggests for an item name. Offered, never applied. */
  categoryRecommend(p: CategoryRecommendParams): Promise<ShopeeCategoryRecommend>;
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

/**
 * A Shopee id is a positive safe integer. `0` is never a category and a
 * fractional id is a caller bug, so both reject before the wire rather than
 * being sent for Shopee to reject as `error_param`.
 */
function assertIdPositivo(nome: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ShopeeConfigError(
      `${nome} deve ser um inteiro positivo (recebido: ${JSON.stringify(value)}).`,
    );
  }
}

/** Every `get_brand_list` bound, all four REQUIRED by the page. */
function assertBrandListParams(p: GetBrandListParams): void {
  assertIdPositivo('category_id', p.categoryId);
  if (!Number.isSafeInteger(p.offset) || p.offset < 0) {
    throw new ShopeeConfigError(
      `offset deve ser um inteiro >= 0 (recebido: ${JSON.stringify(p.offset)}).`,
    );
  }
  if (
    !Number.isSafeInteger(p.pageSize) ||
    p.pageSize < 1 ||
    p.pageSize > SHOPEE_BRAND_MAX_PAGE_SIZE
  ) {
    throw new ShopeeConfigError(
      `page_size deve estar entre 1 e ${String(SHOPEE_BRAND_MAX_PAGE_SIZE)} (recebido: ${JSON.stringify(p.pageSize)}).`,
    );
  }
  if (p.status !== SHOPEE_BRAND_STATUS.normal && p.status !== SHOPEE_BRAND_STATUS.pending) {
    throw new ShopeeConfigError(
      `status deve ser 1 (normal) ou 2 (pendente) (recebido: ${JSON.stringify(p.status)}).`,
    );
  }
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

  // ⚠️ Resolved ONCE, here, so a malformed override fails at construction — the
  // same moment a malformed `shopId` does. Resolving it per call would sign an
  // unvalidated string and turn a config typo into an `error_sign` per request.
  const variationsPath =
    config.paths?.getVariations === undefined
      ? SHOPEE_GET_VARIATIONS_PATH
      : normalizeApiPath(config.paths.getVariations, 'SHOPEE_VARIATIONS_PATH');

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

    /* ---------------------------- taxonomy reads ---------------------------- */

    getCategory: async () => {
      const res = await shopeeCall(transport, {
        method: 'GET',
        path: SHOPEE_GET_CATEGORY_PATH,
        call: await signedCall(),
        schema: shopeeCategoryListSchema,
        surface: SHOPEE_SURFACE.business,
        query: { language: SHOPEE_TAXONOMY_LANGUAGE },
      });
      return res.response;
    },

    getAttributeTree: async (p) => {
      const ids = p.categoryIds;
      if (ids.length < 1 || ids.length > SHOPEE_ATTRIBUTE_TREE_MAX_CATEGORIES) {
        throw new ShopeeConfigError(
          `category_id_list deve conter de 1 a ${String(SHOPEE_ATTRIBUTE_TREE_MAX_CATEGORIES)} categorias (recebido: ${JSON.stringify(ids.length)}).`,
        );
      }
      for (const id of ids) assertIdPositivo('category_id_list', id);

      const res = await shopeeCall(transport, {
        method: 'GET',
        path: SHOPEE_GET_ATTRIBUTE_TREE_PATH,
        call: await signedCall(),
        schema: shopeeAttributeTreeSchema,
        surface: SHOPEE_SURFACE.business,
        // ⚠️ `category_id_list`, joined by commas. The page's parameter table says
        // `category_id_list` while its own cURL sample sends `category_ids`;
        // `signedQuery` cannot emit a repeated key anyway, so the joined scalar is
        // the only shape available. `apps/shopee` sends ONE id per call, which is
        // valid under both spellings, and logs `error_param` raw — so flipping the
        // name is a single literal here if the live API disagrees.
        query: { category_id_list: ids.join(','), language: SHOPEE_TAXONOMY_LANGUAGE },
      });
      return res.response;
    },

    getBrandList: async (p) => {
      assertBrandListParams(p);
      const res = await shopeeCall(transport, {
        method: 'GET',
        path: SHOPEE_GET_BRAND_LIST_PATH,
        call: await signedCall(),
        schema: shopeeBrandListSchema,
        surface: SHOPEE_SURFACE.business,
        // ⚠️ ONE page. `has_next_page` / `next_offset` come back on the payload and
        // the caller decides whether to ask for more.
        query: {
          category_id: p.categoryId,
          offset: p.offset,
          page_size: p.pageSize,
          status: p.status,
          language: SHOPEE_TAXONOMY_LANGUAGE,
        },
      });
      return res.response;
    },

    getItemLimit: async (p = {}) => {
      if (p.categoryId !== undefined) assertIdPositivo('category_id', p.categoryId);
      const res = await shopeeCall(transport, {
        method: 'GET',
        path: SHOPEE_GET_ITEM_LIMIT_PATH,
        call: await signedCall(),
        schema: shopeeItemLimitSchema,
        surface: SHOPEE_SURFACE.business,
        // `undefined` is dropped by `signedQuery`, so an omitted category really
        // sends no `category_id` — the shop-wide read.
        query: { category_id: p.categoryId },
      });
      // ⚠️ BOTH positions travel to the caller. Which one Shopee fills is
      // unsettled (the page renders `gtin_limit` outside `response` and ships no
      // response sample), so the merge belongs to the reader that can log it.
      return { response: res.response, gtin_limit: res.gtin_limit };
    },

    getKitItemLimit: async (p = {}) => {
      if (p.categoryId !== undefined) assertIdPositivo('category_id', p.categoryId);
      const res = await shopeeCall(transport, {
        method: 'GET',
        // ⚠️ Its own path and its own schema. A kit's bands are never the item's.
        path: SHOPEE_GET_KIT_ITEM_LIMIT_PATH,
        call: await signedCall(),
        schema: shopeeKitItemLimitSchema,
        surface: SHOPEE_SURFACE.business,
        query: { category_id: p.categoryId },
      });
      return res.response;
    },

    getVariations: async (p) => {
      assertIdPositivo('category_id', p.categoryId);
      const res = await shopeeCall(transport, {
        method: 'GET',
        // The contradicted path — see `SHOPEE_GET_VARIATION_TREE_PATH_ALT`.
        path: variationsPath,
        call: await signedCall(),
        // DATA-wrapped, the only operation that is.
        schema: shopeeVariationsSchema,
        surface: SHOPEE_SURFACE.business,
        query: { category_id: p.categoryId },
      });
      return res.data;
    },

    categoryRecommend: async (p) => {
      if (p.itemName.trim() === '') {
        throw new ShopeeConfigError(
          `item_name não pode ser vazio (recebido: ${JSON.stringify(p.itemName)}).`,
        );
      }
      const res = await shopeeCall(transport, {
        method: 'GET',
        path: SHOPEE_CATEGORY_RECOMMEND_PATH,
        call: await signedCall(),
        schema: shopeeCategoryRecommendSchema,
        surface: SHOPEE_SURFACE.business,
        query: { item_name: p.itemName, product_cover_image: p.productCoverImage },
      });
      return res.response;
    },
  };
}
