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
 * ⚠️ **No paging loop anywhere.** `getShopsByPartner`, `getBrandList`,
 * `getOrderList`, `getLostPushMessages` and `getEscrowList` each fetch ONE page
 * and surface the cursor (or the page number); the caller loops. Auto-paging
 * inside a client hides an unbounded number of provider calls behind one
 * innocuous `await`, and Shopee's brand API is slow enough that the difference is
 * visible to an operator.
 *
 * ## The push and order reads (step 4)
 *
 * Three Public-signed push operations — `getLostPushMessages`,
 * `confirmConsumedLostPushMessages`, `getAppPushConfig` — plus the Shop-signed
 * `getOrderList`. The first two carry the `emptyErrorAliases` exception to the
 * `error === ''` invariant (see `call.ts`) — and `getLostPushMessages` is the
 * ONE read here that hands back the whole parsed operation instead of
 * `res.response`, because that exception is what its caller has to observe on
 * live traffic; the third deliberately does NOT, and
 * there is deliberately no `setAppPushConfig` at all — the absence is the
 * enforcement, and {@link ShopeePartnerClient.getAppPushConfig} says why.
 *
 * ## The order reads (step 5)
 *
 * `getOrderDetail` (≤ 50 `order_sn`, WRAPPED) and `getEscrowDetail` (one
 * `order_sn`) — the pair the pedido importer runs, in that order. Two Shopee
 * contradictions are instrumented rather than guessed, and each is ONE literal:
 * {@link SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS} (an optional field that is not
 * named comes back ABSENT, so the list is a default rather than a parameter the
 * caller can forget) and {@link SHOPEE_ESCROW_DETAIL_TRANSPORT} (the escrow page
 * declares GET while its only sample is a JSON body — one literal flips the verb
 * AND the placement together, because a GET cannot carry a body at all).
 *
 * ## The settlement read (step 6)
 *
 * ONE more: `getEscrowList`, the only surface that exposes
 * `escrow_release_time`. It diverges from `getOrderList` in two ways that are
 * both the PAGE's doing rather than a preference — `release_time_from ===
 * release_time_to` is legal here (see {@link GetEscrowListParams}) and no
 * maximum window is documented at all (see
 * {@link SHOPEE_ESCROW_LIST_DEFAULT_PAGE_SIZE}).
 *
 * ⚠️ **`get_escrow_detail_batch` is deliberately NOT built, and it is not a
 * shortcut anybody may add later.** Its response drops eleven fields the single
 * call carries — including `buyer_total_amount`, `escrow_amount_after_adjustment`,
 * `total_adjustment_amount` and `tenure_info_list` — so it can produce neither
 * the pagamento's `valor` nor its `tarifas`, and it carries **no per-order
 * `error`**, so a batch of 50 in which one order failed is indistinguishable
 * from a batch in which none did.
 *
 * ## The taxonomy reads (step 10)
 *
 * Seven of them, all Shop-signed GETs on the `product` module, all read-only and
 * all validation-before-the-wire: a bound that cannot be satisfied REJECTS
 * without spending a provider call. Four of Shopee's own contradictions are
 * instrumented rather than guessed — the `get_variations` path (see
 * {@link SHOPEE_GET_VARIATION_TREE_PATH_ALT}), the language casing (see
 * {@link SHOPEE_TAXONOMY_LANGUAGE}), `category_id_list` vs `category_ids` (the
 * single joined literal in `getAttributeTree`) and `gtin_limit`'s position (see
 * {@link ShopeeItemLimitRead}, which carries BOTH).
 *
 * This package never caches: the TTL cache lives in `apps/shopee`, keyed per
 * integração, because every one of these answers is per shop.
 */
import { type ShopeeTransport, type ShopeeWarning, shopeeCall } from './call';
import { SHOPEE_SURFACE, ShopeeConfigError } from './errors';
import type { ShopeeHosts } from './hosts';
import {
  type ShopeeAppPushConfig,
  type ShopeeAttributeTree,
  type ShopeeBrandList,
  type ShopeeCategoryList,
  type ShopeeCategoryRecommend,
  type ShopeeConfirmLostPush,
  type ShopeeEscrowDetail,
  type ShopeeEscrowList,
  type ShopeeGtinLimit,
  type ShopeeItemLimit,
  type ShopeeKitItemLimit,
  type ShopeeLostPushResponse,
  type ShopeeOrderDetail,
  type ShopeeOrderList,
  type ShopeeProfile,
  type ShopeeShopInfo,
  type ShopeeShopsByPartner,
  type ShopeeVariations,
  shopeeAppPushConfigSchema,
  shopeeAttributeTreeSchema,
  shopeeBrandListSchema,
  shopeeCategoryListSchema,
  shopeeCategoryRecommendSchema,
  shopeeConfirmLostPushSchema,
  shopeeEscrowDetailSchema,
  shopeeEscrowListSchema,
  shopeeItemLimitSchema,
  shopeeKitItemLimitSchema,
  shopeeLostPushSchema,
  shopeeOrderDetailSchema,
  shopeeOrderListSchema,
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

/** `GET` — Public-signed. ONE page of the 3-day lost-push queue (the earliest 100). */
export const SHOPEE_GET_LOST_PUSH_PATH = '/api/v2/push/get_lost_push_message';
/** `POST` — Public-signed. The batch watermark ack. Envelope-only response. */
export const SHOPEE_CONFIRM_LOST_PUSH_PATH = '/api/v2/push/confirm_consumed_lost_push_message';
/** `GET` — Public-signed. The app-wide push configuration. READ ONLY. */
export const SHOPEE_GET_APP_PUSH_CONFIG_PATH = '/api/v2/push/get_app_push_config';

/** `GET` — Shop-signed. WRAPPED. ONE page of orders in a ≤ 15-day window. */
export const SHOPEE_GET_ORDER_LIST_PATH = '/api/v2/order/get_order_list';

/** `GET` — Shop-signed. WRAPPED. Up to 50 `order_sn` per call. */
export const SHOPEE_GET_ORDER_DETAIL_PATH = '/api/v2/order/get_order_detail';
/**
 * Shop-signed. WRAPPED. ONE `order_sn`. The verb and where the parameter rides
 * are BOTH decided by {@link SHOPEE_ESCROW_DETAIL_TRANSPORT}.
 */
export const SHOPEE_GET_ESCROW_DETAIL_PATH = '/api/v2/payment/get_escrow_detail';

/**
 * `GET` — Shop-signed. WRAPPED. ONE page of RELEASED orders, by
 * `escrow_release_time`.
 *
 * ⚠️ The only Shopee surface that exposes `escrow_release_time` at all; the
 * escrow DETAIL does not carry it.
 */
export const SHOPEE_GET_ESCROW_LIST_PATH = '/api/v2/payment/get_escrow_list';

/** `get_order_detail`: `order_sn_list` is documented `limit [1,50]`. */
export const SHOPEE_ORDER_DETAIL_MAX_ORDER_SN = 50;

/**
 * `response_optional_fields` for `get_order_detail` — 24 tokens, comma-joined,
 * **NO SPACES**.
 *
 * ⚠️ **An optional field that is not NAMED here comes back ABSENT, not empty.**
 * Only eleven fields return by default (`order_sn, region, currency, cod,
 * order_status, message_to_seller, create_time, update_time, days_to_ship,
 * ship_by_date, booking_sn`); everything the importer reads — the items, the
 * address, the money, the packages — has to be asked for. That is why this is a
 * DEFAULT rather than a required parameter: forgetting it is silent (a pedido
 * imports with no items and no buyer), while a default that is wrong is loud.
 *
 * Shopee's own list carries 31 tokens (with `buyer_username` printed twice). The
 * seven left out, and why:
 *
 *  - `international_label` — its `is_international` is not step 5's signal; the
 *    ORDER-level `region` is, and that one is never masking-gated.
 *  - (`note`, `note_update_time` ARE in: the seller's own Seller Centre note
 *    feeds `observacoesInternas` on the pedido, as the legacy importer did —
 *    an unnamed field is absent, so leaving it out would make that field
 *    silently empty on every order.)
 *  - `goods_to_declare`, `dropshipper`, `dropshipper_phone`, `split_up`,
 *    `actual_shipping_fee_confirmed` — cross-border, ID-dropshipping and
 *    forder-level concerns with no consumer here.
 *
 * ⚠️ `edt` IS in the list even though the response carries `edt_from`/`edt_to`
 * and no `edt` at all: the settle-live register asks whether the token is what
 * produces those two, and only asking answers it.
 */
export const SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS =
  'item_list,recipient_address,buyer_cpf_id,buyer_username,buyer_user_id,pay_time,' +
  'payment_method,payment_info,total_amount,package_list,invoice_data,actual_shipping_fee,' +
  'estimated_shipping_fee,shipping_carrier,order_chargeable_weight_gram,cancel_by,' +
  'cancel_reason,buyer_cancel_reason,edt,pickup_done_time,fulfillment_flag,' +
  'return_request_due_date,note,note_update_time';

/** The verb AND the placement of `order_sn` on `get_escrow_detail`, as one value. */
export type ShopeeEscrowDetailTransport = 'get-query' | 'post-body';

/**
 * ✅ **SETTLED 2026-09-10 — `'get-query'`** (settle-live register item 6). ONE
 * literal still flips both halves. The `v2.payment.get_escrow_detail` page
 * declares `method: 2` (GET) while its ONE request sample is a JSON body
 * (`{"order_sn": "..."}`). A GET carrying a body is not sendable through `fetch`
 * at all — it throws a `TypeError` before any network call — so "query vs body"
 * is really "GET+query vs POST+body", and this constant is the pair.
 *
 * The Shopee console's own test tool sent
 * `GET …/api/v2/payment/get_escrow_detail?…&order_sn=<order_sn>` with an EMPTY
 * body and Shopee answered, so the page's `method` was right and its request
 * sample was misleading. The body Shopee returned is committed as
 * `apps/shopee/lib/shopee/fixtures/__wire__/get_escrow_detail.qty2-sg.json`.
 *
 * ⚠️ The literal SURVIVES the answer, deliberately: it is the named seam, and
 * one live `error_param` is all it would take to flip it to `'post-body'` —
 * which is precisely the failure mode described below.
 *
 * ⚠️ **Neither half of the pair touches the signature, and that is measured, not
 * assumed.** The shop base string is `partner_id + path + timestamp +
 * access_token + shop_id` (`sign.ts`) — the VERB is not in it and neither are the
 * operation's own parameters, in the query or in the body. So two different
 * `order_sn` produce the SAME `sign` under BOTH transports, and a wrong guess
 * here surfaces as `error_param` ("Missing order_sn…", which this page
 * documents) — never as `error_sign` and never as a 404. `apps/shopee` logs the
 * code raw. A test pins the identical-sign property, exactly as
 * `confirmConsumedLostPushMessages` pins it for its own body, because a future
 * "sign the parameters too" would break this call silently.
 */
export const SHOPEE_ESCROW_DETAIL_TRANSPORT: ShopeeEscrowDetailTransport = 'get-query';

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

/**
 * The envelope `error` value the two lost-push pages print where every other
 * page prints `""` — a doc-authoring placeholder, tolerated on those two
 * operations only. See `ShopeeCallParams.emptyErrorAliases` in `call.ts`.
 */
export const SHOPEE_LOST_PUSH_ERROR_ALIASES = ['-'] as const;

/** `get_order_list`: `page_size` is documented `[1,100]` and is REQUIRED. */
export const SHOPEE_ORDER_LIST_MAX_PAGE_SIZE = 100;

/**
 * `get_order_list`: "The maximum date range that may be specified with the
 * time_from and time_to fields is 15 days" — 1 296 000 SECONDS.
 *
 * ⚠️ Measured between the two bounds actually sent, so a caller that widens a
 * window backwards must move `time_to` with it. One second past this is
 * `order.order_list_invalid_time`, not a truncated answer.
 */
export const SHOPEE_ORDER_LIST_MAX_WINDOW_SECONDS = 15 * 24 * 60 * 60;

/** `get_escrow_list`: `page_size` is documented `[1,100]`. */
export const SHOPEE_ESCROW_LIST_MAX_PAGE_SIZE = 100;

/**
 * `get_escrow_list`: Shopee's own documented default for `page_size`, applied
 * HERE and **always SENT**.
 *
 * ⚠️ Sent rather than omitted because `page_no` paging is only meaningful against
 * a KNOWN page size: a caller that resumes at page 7 is asking for rows 601–700
 * under a 100-row page and rows 241–280 under a 40-row one. Letting Shopee pick
 * the size would make a stored resume point mean something different from one
 * tick to the next, and nothing would say so.
 */
export const SHOPEE_ESCROW_LIST_DEFAULT_PAGE_SIZE = 40;

/*
 * ⚠️ There is deliberately **no** `SHOPEE_ESCROW_LIST_MAX_WINDOW_SECONDS`, and
 * the absence is the statement: `get_escrow_list` documents NO maximum window,
 * unlike `get_order_list` (see {@link SHOPEE_ORDER_LIST_MAX_WINDOW_SECONDS}).
 * The 15-day cap the settlement sweep applies is the SWEEP's own budget, self
 * imposed and living with it in `apps/shopee`; a constant here would read as a
 * provider fact and would be one more thing to keep true.
 */

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

/** `confirm_consumed_lost_push_message` — the ONE parameter, and it rides in the BODY. */
export interface ConfirmConsumedLostPushParams {
  /**
   * The `last_message_id` of the page being confirmed, VERBATIM.
   *
   * ⚠️ Never synthesized and never derived. `0` is what an absent-or-invented
   * cursor looks like, so it rejects before the call is spent.
   */
  readonly lastMessageId: number;
}

/** `get_order_list.time_range_field` — REQUIRED, and the two values are not interchangeable. */
export type ShopeeOrderTimeRangeField = 'create_time' | 'update_time';

/**
 * `get_order_list` — one page of a ≤ 15-day window.
 *
 * ⚠️ The bounds are wire-shaped **SECONDS**, and the unit lives in the field
 * name. The package converts nothing: `apps/shopee` is the single place the
 * s↔ms conversion happens (the `conta/shops.ts` precedent), and a package that
 * accepted milliseconds here would describe seconds in `types.ts` and take
 * milliseconds in `api.ts` — two sources of truth for one unit.
 */
export interface GetOrderListParams {
  readonly timeRangeField: ShopeeOrderTimeRangeField;
  /** Unix SECONDS, inclusive lower bound. */
  readonly timeFromS: number;
  /** Unix SECONDS. `timeToS - timeFromS` may not exceed 15 days. */
  readonly timeToS: number;
  /** 1…100, REQUIRED by Shopee. */
  readonly pageSize: number;
  /**
   * The previous page's `next_cursor`, VERBATIM and OPAQUE.
   *
   * ⚠️ OMIT it for the first page. An empty string is REFUSED rather than
   * normalized away: `next_cursor: ''` is Shopee's DRAINED sentinel, and a
   * package that quietly dropped it would turn "feed the drained sentinel back"
   * into "silently restart the window from page 1" — which looks like progress
   * and is a data skip.
   */
  readonly cursor?: string;
  /**
   * Sent as the string `'true'` when true, omitted otherwise. Shopee's own
   * words: "send True will let API support PENDING status, send False or don't
   * send will fallback to old logic".
   */
  readonly requestOrderStatusPending?: boolean;
  /** `'order_status'` is the ONLY documented value. */
  readonly responseOptionalFields?: 'order_status';
}

/**
 * `get_order_detail` — 1…50 orders, in ONE call.
 *
 * ⚠️ No fan-out loop: the caller chunks, exactly as it pages `getOrderList`. The
 * bound exists so a future batch caller cannot exceed it by accident.
 */
export interface GetOrderDetailParams {
  /**
   * 1…50 `order_sn`, joined by commas on the wire.
   *
   * ⚠️ Every element must be a non-blank string, and that is refused BEFORE the
   * fetch: a blank `order_sn` collapses every such row onto ONE identity
   * downstream, which is the same reason `shopeeOrderDetailRowSchema.order_sn`
   * is `.min(1)`. Duplicates are ALLOWED — Shopee may then answer with fewer
   * rows than were asked for, which the caller reconciles by `order_sn`.
   */
  readonly orderSnList: readonly string[];
  /**
   * Sent as the STRING `'true'` when true, omitted otherwise — Shopee's own
   * words: "send True will let API support PENDING status and return
   * pending_terms, send False or don't send will fallback to old logic".
   */
  readonly requestOrderStatusPending?: boolean;
  /**
   * Overrides {@link SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS} — it REPLACES the
   * default list, never adds to it. Joined by commas by this client.
   */
  readonly responseOptionalFields?: readonly string[];
}

/** `get_escrow_detail` — ONE order. */
export interface GetEscrowDetailParams {
  readonly orderSn: string;
}

/**
 * `get_escrow_list` — ONE page of orders whose escrow was RELEASED inside a
 * window on `escrow_release_time`.
 *
 * ⚠️ Both bounds are REQUIRED by the page, and both are wire-shaped **SECONDS**
 * with the unit in the field name. The package converts nothing: `apps/shopee`
 * is the single place the s↔ms conversion happens
 * (the {@link GetOrderListParams} precedent).
 *
 * ⚠️ **`releaseTimeFromS === releaseTimeToS` is ACCEPTED here, and that is a
 * deliberate DIVERGENCE from `getOrderList`.** The two pages refuse different
 * things: `get_order_list` documents a window and this client refuses
 * `time_from >= time_to`, while `get_escrow_list`'s only documented refusal is
 * "start date cannot be later than the end date" — so a zero-width window is
 * legal on this page and a sweep that has already drained up to `now` must be
 * able to ask for it rather than being told it made a caller error. The
 * divergence is pinned side by side in `api.test.ts`, because copying the
 * neighbouring assertion is exactly how it would be "fixed" back.
 *
 * ⚠️ No maximum window is documented for this page. See the note beside
 * {@link SHOPEE_ESCROW_LIST_DEFAULT_PAGE_SIZE}.
 */
export interface GetEscrowListParams {
  /** Unix SECONDS, inclusive lower bound. */
  readonly releaseTimeFromS: number;
  /** Unix SECONDS. ⚠️ May EQUAL `releaseTimeFromS` — see the interface note. */
  readonly releaseTimeToS: number;
  /** 1…100. Omitted ⇒ {@link SHOPEE_ESCROW_LIST_DEFAULT_PAGE_SIZE}, and SENT either way. */
  readonly pageSize?: number;
  /** ≥ 1. Omitted ⇒ 1, and SENT either way. This page pages by NUMBER; it has no cursor. */
  readonly pageNo?: number;
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

  /**
   * ONE page of the lost-push queue — always "the earliest 100 lost within 3
   * days and not confirmed to have been consumed".
   *
   * ⚠️ Paging is cursor-by-ACKNOWLEDGEMENT: there is no `page_no`, no `cursor`
   * and no offset INPUT. The only way to advance is
   * {@link ShopeePartnerClient.confirmConsumedLostPushMessages}. `has_next_page`
   * says whether more than 100 are waiting; it does NOT let you skip ahead, so
   * one entry the caller never makes durable blocks every later one until it
   * expires.
   *
   * ⚠️ Each entry's `data` is a STRING, and this package leaves it that way.
   *
   * ⚠️ **The WHOLE parsed operation comes back — envelope AND `response` — and
   * this is the only read in this file that does not unwrap.** The reason is
   * D1: both lost-push pages sample `"error": "-"` where every other page
   * samples `""`, which is why {@link SHOPEE_LOST_PUSH_ERROR_ALIASES} exists at
   * all. The caller logs `error` VERBATIM so the first production tick settles
   * the contradiction with evidence instead of with the sample. Unwrapping to
   * `res.response` here would leave that field unreachable — and reachable only
   * through the CONFIRM's envelope, which is exactly the field a rehearsal tick
   * under `SHOPEE_LOST_PUSH_CONFIRM_DISABLED` never produces. Read the page
   * itself off `.response`.
   */
  getLostPushMessages(): Promise<ShopeeLostPushResponse>;

  /**
   * Acknowledge the page whose `last_message_id` this is.
   *
   * ⚠️ **The batch reading is INFERRED, not documented.** No page says that
   * confirming id N acks everything ≤ N, whether it is idempotent, or what a
   * stale id does — and no error code covers any of it. The consequence is the
   * caller's ordering rule, not this method's: make every entry durable FIRST,
   * then confirm once per page, and never confirm an empty page.
   *
   * Returns the parsed envelope so the caller can log `request_id` — the one
   * thing a support ticket about a watermark that did not advance needs.
   */
  confirmConsumedLostPushMessages(p: ConfirmConsumedLostPushParams): Promise<ShopeeConfirmLostPush>;

  /**
   * The app-wide push configuration and its live health (`live_push_status`).
   *
   * ⚠️ There is deliberately NO `setAppPushConfig` in this package, and adding
   * one is a decision rather than an omission: `set_app_push_config` takes a
   * single app-wide `callback_url`, FIRES A LIVE TEST PUSH, has undocumented
   * partial-body semantics, and its own push-code enum stops at 13 while live
   * codes reach 47 — so a read-modify-write would silently drop every code above
   * 13. Registration and recovery from a suspension are human Console steps.
   */
  getAppPushConfig(): Promise<ShopeeAppPushConfig>;
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

  /**
   * ONE page of this shop's orders in a ≤ 15-day window.
   *
   * ⚠️ It does NOT auto-page, like every other read here: `more` and
   * `next_cursor` come back on the payload and the caller asks for the next
   * page. Terminate on `more === false` and NEVER on the row count — the page's
   * own sample answers 10 rows for `page_size: 20` with `more: true`.
   *
   * ⚠️ No `order_status` filter is offered, deliberately: Shopee's filter omits
   * `PENDING`/`RETRY_SHIP`/`TO_CONFIRM_RECEIVE`/`TO_RETURN`, so a sweep that
   * used one would silently skip orders. Ask for everything and filter later.
   */
  getOrderList(p: GetOrderListParams): Promise<ShopeeOrderList>;

  /**
   * The FULL detail of 1…50 orders.
   *
   * ⚠️ It asks for {@link SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS} by default,
   * because only eleven fields return without being named and an unnamed one
   * comes back ABSENT — a silent failure whose symptom is a pedido with no items
   * and no buyer, never an error.
   *
   * ⚠️ It does NOT fan out. One call, one page of orders; the caller chunks.
   *
   * ⚠️ The response may carry FEWER rows than were asked for. Reconcile by
   * `order_sn`, never by position.
   */
  getOrderDetail(p: GetOrderDetailParams): Promise<ShopeeOrderDetail>;

  /**
   * ONE order's accounting — the per-item money, including the BR-local
   * `is_kit`/`kit_items` that the ORDER detail does not carry.
   *
   * ⚠️ Its verb and parameter placement are unsettled and live in ONE literal:
   * {@link SHOPEE_ESCROW_DETAIL_TRANSPORT}.
   *
   * ⚠️ `order_not_found` is a documented error of this page, and it classifies as
   * kind `other` — a permanent refusal about one order, not a transient failure.
   */
  getEscrowDetail(p: GetEscrowDetailParams): Promise<ShopeeEscrowDetail>;

  /**
   * ONE page of orders whose escrow was RELEASED inside a window — the
   * settlement feed.
   *
   * ⚠️ **It does NOT auto-page.** One call, one page; the caller loops on
   * `more`, exactly as it does for `getOrderList`. Terminate on `more === false`
   * and NEVER on the row count: Shopee's sibling order page returns ten rows for
   * `page_size: 20` with `more: true`, so a short page proves nothing.
   *
   * ⚠️ Paging is by `page_no`, and there is no cursor. The page also documents
   * **no ordering** of the rows, so nothing may be inferred from their sequence
   * — not the window's high-water mark, not whether a page was skipped.
   *
   * ⚠️ `payout_amount` reaches the caller RAW, because the page contradicts
   * itself about its unit. See {@link shopeeEscrowListRowSchema}.
   *
   * ⚠️ An unreadable row arrives as `null` in place rather than failing the
   * page — see {@link shopeeEscrowListPayloadSchema}. A caller counts those; it
   * never treats one as a row.
   *
   * ⚠️ `income_not_found` and `decoded_failed_error` are documented errors of
   * this page and both classify as kind `other` — permanent refusals, not
   * transient failures.
   */
  getEscrowList(p: GetEscrowListParams): Promise<ShopeeEscrowList>;
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

/**
 * Every `get_order_list` bound, checked BEFORE any fetch.
 *
 * ⚠️ Each branch is a `ShopeeConfigError` — a caller bug or a misconfiguration,
 * never a provider failure — so it must not be swallowed by a sweep's
 * provider-error containment. A window one second too wide would come back as
 * `order.order_list_invalid_time` and read like a Shopee outage.
 */
function assertOrderListParams(p: GetOrderListParams): void {
  if (
    !Number.isSafeInteger(p.pageSize) ||
    p.pageSize < 1 ||
    p.pageSize > SHOPEE_ORDER_LIST_MAX_PAGE_SIZE
  ) {
    throw new ShopeeConfigError(
      `page_size deve estar entre 1 e ${String(SHOPEE_ORDER_LIST_MAX_PAGE_SIZE)} (recebido: ${JSON.stringify(p.pageSize)}).`,
    );
  }
  assertSegundosPositivos('time_from', p.timeFromS);
  assertSegundosPositivos('time_to', p.timeToS);
  if (p.timeFromS >= p.timeToS) {
    throw new ShopeeConfigError(
      `time_from deve ser anterior a time_to (recebido: ${JSON.stringify(p.timeFromS)} e ${JSON.stringify(p.timeToS)}).`,
    );
  }
  const janela = p.timeToS - p.timeFromS;
  if (janela > SHOPEE_ORDER_LIST_MAX_WINDOW_SECONDS) {
    throw new ShopeeConfigError(
      `a janela não pode passar de 15 dias (${String(SHOPEE_ORDER_LIST_MAX_WINDOW_SECONDS)} s); recebido: ${String(janela)} s.`,
    );
  }
  // ⚠️ Refused, never normalized away. See `GetOrderListParams.cursor`.
  if (p.cursor !== undefined && p.cursor === '') {
    throw new ShopeeConfigError(
      'cursor não pode ser vazio — omita o parâmetro na primeira página.',
    );
  }
}

/**
 * Every `get_order_detail` bound, checked BEFORE any fetch.
 *
 * ⚠️ Every branch is a `ShopeeConfigError` — a caller bug, never a provider
 * failure — so a sweep's provider-error containment must not swallow it. And the
 * blank check is the load-bearing one: Shopee would answer a blank `order_sn`
 * with a plain `error_param`, but a blank one that reached the MAPPER would key
 * every such order onto a single deterministic pedido id.
 */
function assertOrderDetailParams(p: GetOrderDetailParams): void {
  const quantidade = p.orderSnList.length;
  if (quantidade < 1 || quantidade > SHOPEE_ORDER_DETAIL_MAX_ORDER_SN) {
    throw new ShopeeConfigError(
      `order_sn_list deve conter de 1 a ${String(SHOPEE_ORDER_DETAIL_MAX_ORDER_SN)} pedidos (recebido: ${String(quantidade)}).`,
    );
  }
  p.orderSnList.forEach((orderSn, posicao) => {
    if (typeof orderSn !== 'string' || orderSn.trim() === '') {
      throw new ShopeeConfigError(
        `order_sn não pode ser vazio (posição ${String(posicao)}, recebido: ${JSON.stringify(orderSn)}).`,
      );
    }
  });
}

/** The same refusal for the single-order reads. Blank is never a value. */
function assertOrderSn(orderSn: string): void {
  if (typeof orderSn !== 'string' || orderSn.trim() === '') {
    throw new ShopeeConfigError(
      `order_sn não pode ser vazio (recebido: ${JSON.stringify(orderSn)}).`,
    );
  }
}

/**
 * Every `get_escrow_list` bound, checked BEFORE any fetch.
 *
 * ⚠️ Every branch is a `ShopeeConfigError` — a caller bug or a misconfiguration,
 * never a provider failure — so a sweep's provider-error containment must not
 * swallow it. That matters more here than on the order pages: this call runs
 * inside a scheduled settlement whose whole design is to CONTAIN provider errors
 * per conta and carry on, and a window it computed wrongly must be loud.
 *
 * ⚠️ **`from === to` is ACCEPTED, and the `>` is not a typo for `>=`.** The
 * neighbouring `assertOrderListParams` refuses `time_from >= time_to`, because
 * that page documents a window; this page's only documented refusal is "start
 * date cannot be later than the end date". Two pages, two rules — copying the
 * sibling's operator here would refuse a legal zero-width window and there would
 * be no error to see, only a sweep that stops making progress once it catches up
 * with `now`. See {@link GetEscrowListParams}.
 */
function assertEscrowListParams(pageSize: number, pageNo: number, p: GetEscrowListParams): void {
  assertSegundosPositivos('release_time_from', p.releaseTimeFromS);
  assertSegundosPositivos('release_time_to', p.releaseTimeToS);
  if (p.releaseTimeFromS > p.releaseTimeToS) {
    throw new ShopeeConfigError(
      `release_time_from não pode ser posterior a release_time_to (recebido: ${JSON.stringify(p.releaseTimeFromS)} e ${JSON.stringify(p.releaseTimeToS)}).`,
    );
  }
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > SHOPEE_ESCROW_LIST_MAX_PAGE_SIZE
  ) {
    throw new ShopeeConfigError(
      `page_size deve estar entre 1 e ${String(SHOPEE_ESCROW_LIST_MAX_PAGE_SIZE)} (recebido: ${JSON.stringify(pageSize)}).`,
    );
  }
  if (!Number.isSafeInteger(pageNo) || pageNo < 1) {
    throw new ShopeeConfigError(
      `page_no deve ser um inteiro >= 1 (recebido: ${JSON.stringify(pageNo)}).`,
    );
  }
}

/** A wire timestamp in SECONDS: a positive safe integer, never a millisecond value by accident. */
function assertSegundosPositivos(nome: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ShopeeConfigError(
      `${nome} deve ser um inteiro positivo em segundos (recebido: ${JSON.stringify(value)}).`,
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

    getLostPushMessages: async () =>
      // ⚠️ Returned WHOLE — no `res.response`. The envelope's `error` is the
      // evidence D1 waits on; see the method's docblock above.
      shopeeCall(transport, {
        // ⚠️ GET — the page's own `method: 2`, and its four samples agree. See
        // the doc-reader fix at `.master_plans/shopee/shopee-doc.mjs`.
        method: 'GET',
        path: SHOPEE_GET_LOST_PUSH_PATH,
        // Public: the queue is partner-level, so it answers even when every
        // conta's token is dead — which is exactly when it matters.
        call: { class: 'public' },
        schema: shopeeLostPushSchema,
        surface: SHOPEE_SURFACE.business,
        emptyErrorAliases: SHOPEE_LOST_PUSH_ERROR_ALIASES,
        // ⚠️ No `query` key at all: the page's Request params section is EMPTY,
        // and only the common ones (partner_id, timestamp, sign) travel.
      }),

    confirmConsumedLostPushMessages: async (p) => {
      assertIdPositivo('last_message_id', p.lastMessageId);
      return shopeeCall(transport, {
        method: 'POST',
        path: SHOPEE_CONFIRM_LOST_PUSH_PATH,
        call: { class: 'public' },
        // The BARE envelope — this operation has no `response` object.
        schema: shopeeConfirmLostPushSchema,
        surface: SHOPEE_SURFACE.business,
        emptyErrorAliases: SHOPEE_LOST_PUSH_ERROR_ALIASES,
        // ⚠️ The body carries the operation parameter; the common ones stay in
        // the SIGNED query. The body is NOT signed (`call.ts`), so two different
        // `last_message_id`s produce the SAME `sign` — a test pins that, because
        // a future "sign the body too" would break the ack silently.
        body: { last_message_id: p.lastMessageId },
      });
    },

    getAppPushConfig: async () => {
      const res = await shopeeCall(transport, {
        method: 'GET',
        path: SHOPEE_GET_APP_PUSH_CONFIG_PATH,
        call: { class: 'public' },
        schema: shopeeAppPushConfigSchema,
        surface: SHOPEE_SURFACE.business,
        // ⚠️ NO alias here, deliberately: THIS page's response sample says `""`.
        // The tolerance is per OPERATION because the contradiction is per PAGE.
      });
      return res.response;
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
        // GET, per the page's own `method: 2` and every one of its samples. An
        // earlier note here claimed the page was headed POST — that came from
        // our doc reader's `is_get_method` bug (that field is `0` on all 20
        // cached pages, so it printed POST for every one), fixed 2026-09-09 at
        // `.master_plans/shopee/shopee-doc.mjs`. The verb was always right; only
        // the reason was a fiction, and a fiction attached to a verb is what
        // gets "corrected" later.
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

    /* ------------------------------- orders -------------------------------- */

    getOrderList: async (p) => {
      assertOrderListParams(p);
      const res = await shopeeCall(transport, {
        method: 'GET',
        path: SHOPEE_GET_ORDER_LIST_PATH,
        call: await signedCall(),
        schema: shopeeOrderListSchema,
        surface: SHOPEE_SURFACE.business,
        query: {
          time_range_field: p.timeRangeField,
          time_from: p.timeFromS,
          time_to: p.timeToS,
          page_size: p.pageSize,
          // `undefined` is dropped by `signedQuery`, so the first page really
          // sends no `cursor` — the literal `''` of the samples is never sent.
          cursor: p.cursor,
          // ⚠️ The wire wants a STRING here. `signedQuery` takes
          // `string | number | undefined`, and `String(true) === 'true'` makes
          // the two shapes wire-identical — widening the query type to accept a
          // boolean would have been a transport change for one parameter.
          request_order_status_pending: p.requestOrderStatusPending === true ? 'true' : undefined,
          response_optional_fields: p.responseOptionalFields,
          // ⚠️ No `order_status`: see the interface. Filtering here would drop
          // four documented statuses without saying so.
        },
      });
      return res.response;
    },

    getOrderDetail: async (p) => {
      assertOrderDetailParams(p);
      const res = await shopeeCall(transport, {
        method: 'GET',
        path: SHOPEE_GET_ORDER_DETAIL_PATH,
        call: await signedCall(),
        schema: shopeeOrderDetailSchema,
        surface: SHOPEE_SURFACE.business,
        query: {
          // ⚠️ ONE joined scalar, commas between: `signedQuery` cannot emit a
          // repeated key, and the page's own request sample is comma-joined.
          order_sn_list: p.orderSnList.join(','),
          // ⚠️ The wire wants the STRING 'true'; `undefined` is dropped by
          // `signedQuery`, so `false` really sends nothing. Same shape as
          // `getOrderList`'s.
          request_order_status_pending: p.requestOrderStatusPending === true ? 'true' : undefined,
          // ⚠️ The caller's list REPLACES the default; it never merges with it.
          response_optional_fields:
            p.responseOptionalFields === undefined
              ? SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS
              : p.responseOptionalFields.join(','),
        },
      });
      return res.response;
    },

    getEscrowDetail: async (p) => {
      assertOrderSn(p.orderSn);
      // ⚠️ ONE literal decides both halves — see SHOPEE_ESCROW_DETAIL_TRANSPORT.
      // `shopeeCall` sets `init.body` for ANY method and `fetch` throws a
      // TypeError on a GET carrying one, so the verb and the placement can never
      // be chosen independently.
      const porQuery = SHOPEE_ESCROW_DETAIL_TRANSPORT === 'get-query';
      const res = await shopeeCall(transport, {
        method: porQuery ? 'GET' : 'POST',
        path: SHOPEE_GET_ESCROW_DETAIL_PATH,
        call: await signedCall(),
        schema: shopeeEscrowDetailSchema,
        surface: SHOPEE_SURFACE.business,
        ...(porQuery ? { query: { order_sn: p.orderSn } } : { body: { order_sn: p.orderSn } }),
      });
      return res.response;
    },

    getEscrowList: async (p) => {
      // Resolved BEFORE the assertion so the bound is checked against the value
      // that will actually be sent — a default that skipped validation would be
      // a second, unchecked way to reach the wire.
      const pageSize = p.pageSize ?? SHOPEE_ESCROW_LIST_DEFAULT_PAGE_SIZE;
      const pageNo = p.pageNo ?? 1;
      assertEscrowListParams(pageSize, pageNo, p);
      const res = await shopeeCall(transport, {
        // GET — the page's own `method: 2`, and its samples agree.
        method: 'GET',
        path: SHOPEE_GET_ESCROW_LIST_PATH,
        call: await signedCall(),
        schema: shopeeEscrowListSchema,
        surface: SHOPEE_SURFACE.business,
        query: {
          // ⚠️ SECONDS, verbatim. The package converts no unit.
          release_time_from: p.releaseTimeFromS,
          release_time_to: p.releaseTimeToS,
          // ⚠️ BOTH always sent, defaults included — see
          // SHOPEE_ESCROW_LIST_DEFAULT_PAGE_SIZE.
          page_size: pageSize,
          page_no: pageNo,
        },
      });
      // ONE page. `more` travels on the payload and the caller decides.
      return res.response;
    },
  };
}
