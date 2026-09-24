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
 * ## The package read (step 7)
 *
 * ONE more: `getPackageDetail`, the only Shopee surface that carries a package's
 * `fulfillment_status`, `tracking_number`, `ship_by_date`, `logistics_channel_id`
 * and its own `update_time` together. It is a `v2.order.*` path and NOT
 * `v2.logistics.get_tracking_info` — see
 * {@link SHOPEE_GET_PACKAGE_DETAIL_PATH}, which records why. It carries the
 * THIRD `emptyErrorAliases` call site (see
 * {@link SHOPEE_PACKAGE_DETAIL_ERROR_ALIASES}) and four refusals that all land
 * BEFORE the fetch.
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
 * ## The item reads (step 9)
 *
 * Four more, all Shop-signed GETs on the `product` module: `getItemList` (one
 * page of ids), `getItemBaseInfo` (1…50 full items), `getModelList` (ONE item's
 * variations — there is no batch form) and `getKitItemInfo` (ONE kit).
 *
 * ⚠️ They force the one shared change this package has taken since step 1:
 * `item_status` is REQUIRED on `get_item_list` and is a **REPEATED query key**
 * (`item_status=NORMAL&item_status=UNLIST` — the only explicit sentence about
 * repetition anywhere in Shopee's corpus), so `signedQuery` now APPENDS an array
 * value instead of only ever `set`ting a scalar. The signature is untouched:
 * the base string never reads the operation's parameters.
 *
 * ⚠️ `item_id_list`'s spelling is Shopee's fifth contradiction instrumented
 * here rather than guessed — its ONE page samples three encodings — and it is
 * one literal: {@link SHOPEE_ITEM_ID_LIST_ENCODING}.
 *
 * ⚠️ Three boundary operations of the same module are deliberately NOT built:
 * `get_item_extra_info` (sales/views/likes have no sink in this ERP),
 * `search_item` (it cannot enumerate a catalogue — its own `error_param` demands
 * a name or an attribute filter — and carries neither `update_time` nor
 * `tag.kit`) and `upload_image` (step 9 only DOWNLOADS `image_url`; step 11
 * builds it on the PARTNER client).
 *
 * ⚠️ **`get_item_promotion` was the fourth refusal here and step 12 BUILT it**,
 * because both halves of the refusal turned out to be wrong about the page.
 * "`get_model_list` already hands one `promotion_id` per model" — `guide 221 §4`
 * says that field carries only ONE of several concurrent promotions, so a model
 * under two of them reads as being under one. And the id itself: `promotion_id`
 * was REMOVED from `get_item_base_info` on 2026-04-03 and is documented
 * deprecated + `uint64` on `get_model_list`, so the surviving copy is both
 * partial and unsafe to read as a number. "Volatile promotion state" was never
 * the question either — what step 12 needs is the per-model RESERVED FLOOR
 * (`faq 59`: a listing inside a promotion refuses a stock below what the
 * promotion holds), and `promotion_stock_info_v2` is the only place it is
 * published. See {@link ShopeeClient.getItemPromotion}.
 *
 * ## The listing writes (step 11)
 *
 * The first operations here that CHANGE a listing: `add_item`, `update_item`, the
 * four tier/model writes, `delete_model`, `delete_item`, `unlist_item`, plus two
 * reads they need (`get_item_violation_info`, `get_channel_list`) and the ONE
 * upload in this package (`upload_image`, on the PARTNER client).
 *
 * ⚠️ **Every write returns the WHOLE parsed envelope; the two reads unwrap.** A
 * write's `warning` is a partial-failure channel — Shopee accepts the item and
 * says what it ignored — and eight unwrapped ops would have made it unreachable.
 * The precedent is `confirmConsumedLostPushMessages`.
 *
 * ⚠️ **The request types are the WIRE BODIES** (`snake_case`), not camelCase
 * mirrors: the query ops keep `…Params`, the body ops take the body. See
 * {@link ShopeeAddItemRequest}.
 *
 * ⚠️ Two of the twelve ship with **no caller in this repo** and say so in their
 * own docblocks — {@link ShopeeClient.deleteModel} and
 * {@link ShopeeClient.deleteItem} (the sandbox probe's cleanup).
 *
 * ⚠️ Three of Shopee's own contradictions are instrumented as single literals
 * rather than guessed, all three in `types.ts`:
 * {@link SHOPEE_UPLOAD_IMAGE_SIGNING} (a `type=Public` page whose error list
 * names `access_token`), {@link SHOPEE_UPLOAD_IMAGE_FIELD} (`image` in three
 * samples, `file` in the Java one) and {@link SHOPEE_TIER_MAX_OPTIONS} (20 and 50
 * on the same two pages — MEASURED at 50 on the sandbox, 2026-09-17).
 *
 * ## The stock sync (step 12)
 *
 * Four more: the ONE write (`update_stock`) and three reads that decide whether
 * the write may go out at all (`get_item_promotion`, `get_shop_holiday_mode`,
 * `get_warehouse_detail`).
 *
 * ⚠️ `update_stock` is the first operation in this package whose `error`
 * COEXISTS with its payload: its own list documents
 * `error_busi_update_stock_failed: Update stock failed, please check
 * failure_list for detailed reason`, and `failure_list` lives under `response`.
 * It is still a FAILURE — the transport's `payloadNoErro` merely stops throwing
 * the evidence away, handing a `ShopeeApiPartialError` that carries the parsed
 * body. The whole point is per-model attribution: without it a batch of fifty in
 * which one model sat inside a promotion fails as one lump, which is the legacy
 * Flutter defect verbatim.
 *
 * ⚠️ `getWarehouseDetail` is the ONE operation here that FOLDS an error into a
 * value. `warehouse.error_not_in_whitelist` is what the page's own sample shows
 * an ordinary shop receiving, so treating it as a failure would make "this shop
 * has no multi-warehouse regime" — the common case — read as a broken call. The
 * fold is exactly two codes ({@link SHOPEE_WAREHOUSE_SEM_ACESSO}) and everything
 * else rethrows.
 *
 * ⚠️ Its payload is a top-level ARRAY under `response` — the only one in this
 * package.
 *
 * This package never caches: the TTL cache lives in `apps/shopee`, keyed per
 * integração, because every one of these answers is per shop.
 */
import { roundReais } from '@delfrance/core/money';

import { type ShopeeTransport, type ShopeeWarning, shopeeCall } from './call';
import {
  SHOPEE_SURFACE,
  ShopeeApiError,
  ShopeeConfigError,
  shopeeCodeSemPrefixoDeModulo,
} from './errors';
import type { ShopeeHosts } from './hosts';
import type { SignedCall } from './sign';
import {
  SHOPEE_CONDITION,
  SHOPEE_ITEM_IMAGE_MAX,
  SHOPEE_ITEM_PROMOTION_MAX_IDS,
  SHOPEE_ITEM_STATUS_WRITABLE,
  SHOPEE_ITEM_VIOLATION_MAX_IDS,
  SHOPEE_MODEL_MAX_PER_ITEM,
  SHOPEE_MODEL_SKU_MAX_LENGTH,
  SHOPEE_TIER_MAX_LEVELS,
  SHOPEE_TIER_MAX_OPTIONS,
  SHOPEE_UNLIST_MAX_ITEMS,
  SHOPEE_UPDATE_PRICE_MAX_MODELS,
  SHOPEE_UPDATE_STOCK_MAX_MODELS,
  SHOPEE_UPLOAD_IMAGE_CONTENT_TYPES,
  SHOPEE_UPLOAD_IMAGE_FIELD,
  SHOPEE_UPLOAD_IMAGE_MAX_BYTES,
  SHOPEE_UPLOAD_IMAGE_SCENE_PADRAO,
  SHOPEE_UPLOAD_IMAGE_SIGNING,
  SHOPEE_WAREHOUSE_SEM_ACESSO,
  type ShopeeAppPushConfig,
  type ShopeeAttributeTree,
  type ShopeeBrandList,
  type ShopeeCategoryList,
  type ShopeeCategoryRecommend,
  type ShopeeChannelList,
  type ShopeeCondition,
  type ShopeeConfirmLostPush,
  type ShopeeEscrowDetail,
  type ShopeeEscrowList,
  type ShopeeGtinLimit,
  type ShopeeItemBaseInfo,
  type ShopeeItemLimit,
  type ShopeeItemList,
  type ShopeeItemPromotionPayload,
  type ShopeeItemStatusWritable,
  type ShopeeItemViolationInfo,
  type ShopeeItemWriteResponse,
  type ShopeeKitItemInfo,
  type ShopeeKitItemLimit,
  type ShopeeLostPushResponse,
  type ShopeeModelList,
  type ShopeeOrderDetail,
  type ShopeeOrderList,
  type ShopeePackageDetail,
  type ShopeeProfile,
  type ShopeeShopHolidayMode,
  type ShopeeShopInfo,
  type ShopeeShopsByPartner,
  type ShopeeTierWriteResponse,
  type ShopeeUnlistItemResponse,
  type ShopeeUpdatePriceResponse,
  type ShopeeUpdateStockResponse,
  type ShopeeUploadImageResponse,
  type ShopeeUploadImageScene,
  type ShopeeUploadImageSigning,
  type ShopeeVariations,
  type ShopeeWarehouse,
  type ShopeeWarehouseType,
  type ShopeeWriteAck,
  shopeeAppPushConfigSchema,
  shopeeAttributeTreeSchema,
  shopeeBrandListSchema,
  shopeeCategoryListSchema,
  shopeeCategoryRecommendSchema,
  shopeeChannelListSchema,
  shopeeConfirmLostPushSchema,
  shopeeEscrowDetailSchema,
  shopeeEscrowListSchema,
  shopeeItemBaseInfoSchema,
  shopeeItemLimitSchema,
  shopeeItemListSchema,
  shopeeItemPromotionSchema,
  shopeeItemViolationInfoSchema,
  shopeeItemWriteSchema,
  shopeeKitItemInfoSchema,
  shopeeKitItemLimitSchema,
  shopeeLostPushSchema,
  shopeeModelListSchema,
  shopeeOrderDetailSchema,
  shopeeOrderListSchema,
  shopeePackageDetailSchema,
  shopeeProfileSchema,
  shopeeShopHolidayModeSchema,
  shopeeShopInfoSchema,
  shopeeShopsByPartnerSchema,
  shopeeTierWriteSchema,
  shopeeUnlistItemSchema,
  shopeeUpdatePriceSchema,
  shopeeUpdateStockSchema,
  shopeeUploadImageSchema,
  shopeeVariationsSchema,
  shopeeWarehouseDetailSchema,
  shopeeWriteAckSchema,
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

/** `GET` — Shop-signed. WRAPPED. ONE page of this shop's item ids. */
export const SHOPEE_GET_ITEM_LIST_PATH = '/api/v2/product/get_item_list';
/** `GET` — Shop-signed. WRAPPED. The full detail of up to 50 items. */
export const SHOPEE_GET_ITEM_BASE_INFO_PATH = '/api/v2/product/get_item_base_info';
/** `GET` — Shop-signed. WRAPPED. ONE item's variation trees and models. */
export const SHOPEE_GET_MODEL_LIST_PATH = '/api/v2/product/get_model_list';
/** `GET` — Shop-signed. WRAPPED. ONE kit item and its components. */
export const SHOPEE_GET_KIT_ITEM_INFO_PATH = '/api/v2/product/get_kit_item_info';

/* ------------------------- the listing writes (step 11) ------------------- */

/** `POST` — Shop-signed. WRAPPED. Creates the item; answers its `item_id`. */
export const SHOPEE_ADD_ITEM_PATH = '/api/v2/product/add_item';
/**
 * `POST` — Shop-signed. WRAPPED. FIELD-WISE: "fields not uploaded are not
 * updated" (`guide 221 §5`), which is why a size chart set in Seller Centre
 * survives a republish that never mentions it.
 */
export const SHOPEE_UPDATE_ITEM_PATH = '/api/v2/product/update_item';
/** `POST` — Shop-signed. WRAPPED. The FIRST tier/model write of an item. */
export const SHOPEE_INIT_TIER_VARIATION_PATH = '/api/v2/product/init_tier_variation';
/** `POST` — Shop-signed. Envelope only. Re-maps live models onto tier options. */
export const SHOPEE_UPDATE_TIER_VARIATION_PATH = '/api/v2/product/update_tier_variation';
/** `POST` — Shop-signed. WRAPPED. Adds models to an item that already has tiers. */
export const SHOPEE_ADD_MODEL_PATH = '/api/v2/product/add_model';
/** `POST` — Shop-signed. Envelope only. Model SKU / weight / dimension only. */
export const SHOPEE_UPDATE_MODEL_PATH = '/api/v2/product/update_model';
/** `POST` — Shop-signed. Envelope only. ⚠️ No step-11 caller — see {@link ShopeeClient.deleteModel}. */
export const SHOPEE_DELETE_MODEL_PATH = '/api/v2/product/delete_model';
/** `POST` — Shop-signed. Envelope only. ⚠️ No step-11 caller — see {@link ShopeeClient.deleteItem}. */
export const SHOPEE_DELETE_ITEM_PATH = '/api/v2/product/delete_item';
/** `POST` — Shop-signed. WRAPPED. Batch pause / re-list, 1…50 items per call. */
export const SHOPEE_UNLIST_ITEM_PATH = '/api/v2/product/unlist_item';
/** `GET` — Shop-signed. WRAPPED. The violation / deboost detail of 1…50 items. */
export const SHOPEE_GET_ITEM_VIOLATION_INFO_PATH = '/api/v2/product/get_item_violation_info';
/** `GET` — Shop-signed. WRAPPED. Every logistics channel of the SHOP. No parameters. */
export const SHOPEE_GET_CHANNEL_LIST_PATH = '/api/v2/logistics/get_channel_list';
/**
 * `POST` — **Public**-signed by default, `multipart/form-data`. The ONE upload in
 * this package; see {@link SHOPEE_UPLOAD_IMAGE_SIGNING} for the contradiction the
 * default rests on and {@link UploadImageParams.signing} for the escape hatch.
 */
export const SHOPEE_UPLOAD_IMAGE_PATH = '/api/v2/media_space/upload_image';

/* -------------------------- the stock sync (step 12) ---------------------- */

/**
 * `POST` — Shop-signed (`method: 1` on the page). WRAPPED. ONE item, 1…50
 * models per call.
 *
 * ⚠️ The ONE operation in this package whose `error` COEXISTS with its payload:
 * `error_busi_update_stock_failed` is documented as *"please check
 * failure_list"*, and `failure_list` rides under `response`. Its call site is
 * therefore the ONLY `payloadNoErro` in this file — see
 * {@link ShopeeClient.updateStock}.
 */
export const SHOPEE_UPDATE_STOCK_PATH = '/api/v2/product/update_stock';
/**
 * `GET` — Shop-signed (`method: 2` on the page, against prose that reads POST).
 * WRAPPED. 1…{@link SHOPEE_ITEM_PROMOTION_MAX_IDS} item ids.
 */
export const SHOPEE_GET_ITEM_PROMOTION_PATH = '/api/v2/product/get_item_promotion';
/** `GET` — Shop-signed. WRAPPED. Takes NO parameters at all. */
export const SHOPEE_GET_SHOP_HOLIDAY_MODE_PATH = '/api/v2/shop/get_shop_holiday_mode';
/**
 * `GET` — Shop-signed. WRAPPED, and the payload is a top-level ARRAY — the only
 * one in this package.
 */
export const SHOPEE_GET_WAREHOUSE_DETAIL_PATH = '/api/v2/shop/get_warehouse_detail';

/* -------------------------- the price sync (step 13) ---------------------- */

/**
 * `POST` — Shop-signed (`method: 1` on the page). WRAPPED. ONE item, 1…50
 * models per call — {@link SHOPEE_UPDATE_STOCK_PATH}'s shape, and deliberately
 * NOT its error handling.
 *
 * ⚠️ NOT a `payloadNoErro` operation. That flag exists because the stock page
 * documents a code telling the caller to "check failure_list"; this page's
 * error list has NO such code, and its own response sample prints the partial
 * failure as a SUCCESS envelope — `error: ""` with both lists. So a non-empty
 * `error` here is a whole-call failure and throws the ordinary class, and the
 * per-model refusals are read off the 200 — see {@link ShopeeClient.updatePrice}.
 *
 * ⚠️ And NONE of its codes joins `KIND_BY_CODE` (`errors.ts`, register 101):
 * `error_update_price_fail`, `error_system_busy` and this page's `error_inner`
 * (`Update item failed {{.error_info}}` can be a PERMANENT whole-item
 * validation) are classified per operation by the app, never here.
 */
export const SHOPEE_UPDATE_PRICE_PATH = '/api/v2/product/update_price';

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

/**
 * `GET` — Shop-signed. WRAPPED. Up to 50 `package_number` per call.
 *
 * ⚠️ It is a **`v2.order.*`** path, not `v2.logistics.*`. `announcement 1169`
 * introduced it together with `package_fulfillment_status_push` (code 30) "for
 * multi-package order scenarios", and the same note warns that
 * `v2.order.get_shipment_list` "will be sunset soon".
 *
 * ⚠️ **It is not `get_tracking_info`, and that is a decision.** That page is
 * per-ORDER, returns no tracking number, types its package-level status against
 * the 13-value `LogisticsStatus` (while `push 33` sends the 11-value
 * `PackageFulfillmentStatus`), and is the ONLY page in the cached corpus that
 * documents `logistics.error_status_limit` — an undocumented status gate whose
 * passing statuses no page names. This page has no such error: its whole
 * api-specific list is `error_not_found`, `error_param`, `error_permission`,
 * `error_server`, `error_data` and `error_shop`.
 */
export const SHOPEE_GET_PACKAGE_DETAIL_PATH = '/api/v2/order/get_package_detail';

/** `get_order_detail`: `order_sn_list` is documented `limit [1,50]`. */
export const SHOPEE_ORDER_DETAIL_MAX_ORDER_SN = 50;

/** `get_package_detail`: `package_number_list` is documented `limit [1,50]`. */
export const SHOPEE_PACKAGE_DETAIL_MAX_PACKAGES = 50;

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
 * `get_item_base_info`: `item_id_list` is documented `limit [0,50]`.
 *
 * ⚠️ The mass import's per-dispatch batch size is bounded by this, so one drain
 * is one call: a batch bigger than this would silently need a second one.
 */
export const SHOPEE_ITEM_BASE_INFO_MAX_IDS = 50;

/**
 * The SIX wire values of `ItemStatus` (`guide 31`), for the **REQUEST** side of
 * `get_item_list`.
 *
 * ⚠️ Named `…_WIRE` because `@delfrance/schemas` already exports a
 * `SHOPEE_ITEM_STATUS` of its own (the link document's stored status) and
 * `apps/shopee` imports both packages in the same module.
 *
 * ⚠️ REQUEST side only. On a RESPONSE the field is a loose string in `types.ts`,
 * deliberately: Shopee moved this set once already (four values to six), and a
 * value it adds tomorrow must cost us nothing on the way IN while a wrong value
 * on the way OUT is our own bug and rejects before the wire.
 */
export const SHOPEE_ITEM_STATUS_WIRE = {
  normal: 'NORMAL',
  banned: 'BANNED',
  unlist: 'UNLIST',
  reviewing: 'REVIEWING',
  sellerDelete: 'SELLER_DELETE',
  shopeeDelete: 'SHOPEE_DELETE',
} as const;
export type ShopeeItemStatusWire =
  (typeof SHOPEE_ITEM_STATUS_WIRE)[keyof typeof SHOPEE_ITEM_STATUS_WIRE];

/** The three spellings {@link SHOPEE_ITEM_ID_LIST_ENCODING} chooses between. */
export type ShopeeIdListEncoding = 'bare-comma' | 'bracket-comma' | 'bracket-space';

/**
 * How `item_id_list` is serialised — the {@link SHOPEE_ESCROW_DETAIL_TRANSPORT}
 * technique, because `get_item_base_info`'s ONE page samples THREE encodings for
 * it (`[34001 34002]` in Java, `%5B34001+34002%5D` in PHP/Python,
 * `[34001,34002]` in cURL) while its two siblings `get_item_extra_info` and
 * `get_item_promotion` sample a BARE COMMA.
 *
 * ⚠️ The repo's own shipped precedent for a Shopee `*_list` query parameter is
 * the bare comma (`category_id_list` on `get_attribute_tree`, step 10), so that
 * is the default and ONE literal here flips it. A wrong guess surfaces as
 * `error_param`, which `apps/shopee` logs raw beside
 * {@link encodeShopeeIdList}'s output — so the answer arrives as evidence
 * instead of as a second guess.
 */
export const SHOPEE_ITEM_ID_LIST_ENCODING: ShopeeIdListEncoding = 'bare-comma';

/**
 * `item_id_list`, in whichever of the three spellings is asked for.
 *
 * ⚠️ Exported so a caller can log the spelling that actually went out beside a
 * raw `error_param` — the same reason step 10 logs `category_id_list`'s.
 */
export function encodeShopeeIdList(
  ids: readonly number[],
  encoding: ShopeeIdListEncoding = SHOPEE_ITEM_ID_LIST_ENCODING,
): string {
  switch (encoding) {
    case 'bare-comma':
      return ids.join(',');
    case 'bracket-comma':
      return `[${ids.join(',')}]`;
    case 'bracket-space':
      return `[${ids.join(' ')}]`;
  }
}

/**
 * The envelope `error` value the two lost-push pages print where every other
 * page prints `""` — a doc-authoring placeholder, tolerated on those two
 * operations only. See `ShopeeCallParams.emptyErrorAliases` in `call.ts`.
 *
 * ⚠️ SHARED by BOTH lost-push call sites — the one constant over two operations.
 * Narrowing one of them (Shopee fixes `get_lost_push_message` and not the
 * confirm) means SPLITTING this constant first: emptying it here moves both.
 */
export const SHOPEE_LOST_PUSH_ERROR_ALIASES = ['-'] as const;

/**
 * The envelope `error` value the `v2.order.get_package_detail` page prints where
 * its own parameter table says "Empty if no error happened" — the same
 * doc-authoring placeholder the two lost-push pages carry, on a third page.
 *
 * ⚠️ The SECOND constant — three call sites carry an alias, and this is the only
 * one that is not shared — rather than a reuse of
 * {@link SHOPEE_LOST_PUSH_ERROR_ALIASES}: the tolerance is opt-in per CALL SITE
 * because the contradiction is per PAGE (`get_app_push_config` samples `""` and
 * carries no alias, one method over), and a lost-push-named constant on an order
 * op would read as a copy rather than as a second observation. If Shopee ever
 * fixes this page and not the lost-push ones, two constants are two edits and
 * one constant is a decision nobody can make.
 *
 * ⚠️ This page prints `"-"` for `message` and `warning` too, and its
 * `tracking_number` sample is `"-"` as well — the sentinel is on the PAYLOAD as
 * much as on the envelope. Only the envelope's `error` is handled here; the
 * payload's `-` is the app's to normalise, in one function.
 */
export const SHOPEE_PACKAGE_DETAIL_ERROR_ALIASES = ['-'] as const;

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

/**
 * `get_item_list` — ONE page of this shop's item ids.
 *
 * ⚠️ The two `update_time` bounds are wire-shaped **SECONDS**, and the unit
 * lives in the field name, exactly as on {@link GetOrderListParams}. The package
 * converts no unit.
 */
export interface GetItemListParams {
  /** ⚠️ `>= 0`, not `> 0`: the FIRST page is offset zero, never an id. */
  readonly offset: number;
  /** 1…100, REQUIRED by Shopee. */
  readonly pageSize: number;
  /**
   * REQUIRED by Shopee, and sent as a REPEATED query key — never comma-joined.
   *
   * ⚠️ This package never defaults it. The legacy importer defaulted it to
   * `NORMAL` and never offered a choice, so every UNLIST listing in the shop was
   * structurally invisible for years; a required parameter with no default is
   * what makes that a decision the caller has to make.
   */
  readonly statuses: readonly ShopeeItemStatusWire[];
  /** Unix SECONDS, optional lower bound on the item's own `update_time`. */
  readonly updateTimeFromS?: number;
  /** Unix SECONDS. ⚠️ Must be strictly LATER than `updateTimeFromS`. */
  readonly updateTimeToS?: number;
}

/** `get_item_base_info` — 1…50 items, in ONE call. */
export interface GetItemBaseInfoParams {
  /**
   * 1…50 item ids, serialised by {@link encodeShopeeIdList}.
   *
   * ⚠️ Every element must be a positive safe integer, refused BEFORE the fetch:
   * a `0` would be sent for Shopee to reject, and the list is ONE joined scalar
   * on the wire, so its `error_param` could never say WHICH element was wrong.
   */
  readonly itemIds: readonly number[];
}

/** `get_model_list` — ONE item. There is no batch form and no paging. */
export interface GetModelListParams {
  readonly itemId: number;
}

/** `get_kit_item_info` — ONE kit item. */
export interface GetKitItemInfoParams {
  readonly itemId: number;
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

/**
 * `get_package_detail` — 1…50 packages, in ONE call.
 *
 * ⚠️ No fan-out loop: the caller chunks, exactly as it does for
 * {@link GetOrderDetailParams}.
 */
export interface GetPackageDetailParams {
  /**
   * 1…50 `package_number`, TRIMMED element by element and joined by commas on
   * the wire.
   *
   * ⚠️ Three per-element refusals BEFORE the fetch, and the second is this
   * page's own: a blank element (it would collapse rows onto one identity
   * downstream — {@link GetOrderDetailParams}'s reason), the `-` SENTINEL (this
   * page samples `"-"` as an ABSENCE on `tracking_number`, `item_sku` and
   * `virtual_contact_number`, so a caller that let one through would be asking
   * for "no package"), and a comma INSIDE an element (the join is by comma, so
   * one element would silently become two parameters). The last two have no twin
   * on `assertOrderDetailParams` deliberately: an `order_sn` is alphanumeric by
   * construction and widening that sibling is not this step's change.
   *
   * ⚠️ **The trim is what makes those refusals mean anything.** Two of the three
   * judge the TRIMMED element (`' '` is blank, `' - '` is the sentinel), so
   * sending the untrimmed one would refuse on one string and request another:
   * `' OFG…937 '` clears every check and would go out as `+OFG…937+` (a query
   * string spells a space `+`, never `%20`), which Shopee answers by returning
   * the rows it recognised — one short, and with no error to read. Only the
   * surrounding whitespace is dropped; nothing INSIDE the value is touched.
   */
  readonly packageNumbers: readonly string[];
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

/* -------------------------------------------------------------------------- */
/*            The listing writes (step 11) — WIRE-SHAPED request types         */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ **The eight body ops take the WIRE BODY; the query ops keep camelCase
 * `…Params`.** That is the whole rule, stated once.
 *
 * A camelCase mirror of ~45 fields over seven nested shapes would be a second
 * vocabulary, and the mapping between the two is exactly where a rename hides
 * without failing to compile. Wire-shaped request types let the publisher's
 * mapper output be compared byte-for-byte with a documented payload sample.
 *
 * ⚠️ They are plain `interface`s and NOT Zod schemas, deliberately:
 * `packages/config-eslint/rules/integration-response-numbers-tolerant.test.js`
 * asserts this package declares RESPONSE shapes only, and a request schema here
 * would need an `ALLOWED_STRICT` entry — a widening of a guard for a shape the
 * compiler already checks.
 */
export interface ShopeeDimensionRequest {
  /** int32, CENTIMETRES. */
  readonly package_height: number;
  readonly package_length: number;
  readonly package_width: number;
}

export interface ShopeeSellerStockRequest {
  /** The seller's warehouse. Omitted ⇒ the shop's default location. */
  readonly location_id?: string;
  readonly stock: number;
}

export interface ShopeePreOrderRequest {
  readonly is_pre_order: boolean;
  readonly days_to_ship?: number;
}

export interface ShopeeAttributeValueRequest {
  /** REQUIRED. ⚠️ `0` is the CUSTOM sentinel, not an absence (`guide 211 §2.2`). */
  readonly value_id: number;
  /** REQUIRED when `value_id` is 0. */
  readonly original_value_name?: string;
  /** REQUIRED when the attribute's `format_type` is 2 and the value is custom. */
  readonly value_unit?: string;
}

export interface ShopeeAttributeRequest {
  readonly attribute_id: number;
  readonly attribute_value_list?: readonly ShopeeAttributeValueRequest[];
}

export interface ShopeeLogisticInfoRequest {
  readonly logistic_id: number;
  readonly enabled: boolean;
  /**
   * int32 — ⚠️ and `get_channel_list` answers the same concept as a **STRING**.
   * The package converts neither; the caller that reads the channel list decides
   * what a non-integer size means (`shopeeLogisticsChannelSchema`).
   */
  readonly size_id?: number;
  readonly shipping_fee?: number;
  readonly is_free?: boolean;
}

export interface ShopeeImageRequest {
  /** REQUIRED inside `image`, 1…{@link SHOPEE_ITEM_IMAGE_MAX}. Shopee renders them POSITIONALLY. */
  readonly image_id_list: readonly string[];
  /** `'1:1'` | `'3:4'` — whitelist-only, and nothing in step 11 sends it. */
  readonly image_ratio?: string;
}

export interface ShopeeBrandRequest {
  /** ⚠️ `0` is "No Brand" — a VALUE, never an absence. */
  readonly brand_id: number;
  readonly original_brand_name: string;
}

/**
 * The BR fiscal block — every member a STRING.
 *
 * ⚠️ `tax_type` (the block's one int32) is TW-only and deliberately NOT declared:
 * a member nothing here can produce is noise that later reads like a contract.
 *
 * ⚠️ Shopee refuses this block **all-or-nothing** (`error_param: all BR tax field
 * should be empty or be filled at same time`), which is why the publisher builds
 * it whole or omits the key entirely.
 */
export interface ShopeeTaxInfoRequest {
  readonly ncm?: string;
  readonly cest?: string;
  readonly csosn?: string;
  readonly icms_cst?: string;
  readonly origin?: string;
  readonly measure_unit?: string;
  readonly pis?: string;
  readonly cofins?: string;
  readonly pis_cofins_cst?: string;
  readonly federal_state_taxes?: string;
  readonly operation_type?: string;
  readonly same_state_cfop?: string;
  readonly diff_state_cfop?: string;
  readonly export_cfop?: string;
  readonly ex_tipi?: string;
  readonly fci_num?: string;
  readonly recopi_num?: string;
  readonly additional_info?: string;
}

/** One model, as `init_tier_variation.model[]` AND `add_model.model_list[]` carry it. */
export interface ShopeeModelRequest {
  readonly tier_index: readonly number[];
  readonly original_price: number;
  readonly seller_stock: readonly ShopeeSellerStockRequest[];
  readonly model_sku?: string;
  readonly gtin_code?: string;
  readonly weight?: number;
  /** ⚠️ Setting it REQUIRES `weight` too — both model pages say so. */
  readonly dimension?: ShopeeDimensionRequest;
  readonly pre_order?: ShopeePreOrderRequest;
}

export interface ShopeeTierOptionRequest {
  /** Optional on `init_tier_variation`, REQUIRED on `update_tier_variation`. ⚠️ `0` is legal. */
  readonly variation_option_id?: number;
  readonly variation_option_name?: string;
  readonly image_id?: string;
}

export interface ShopeeStandardiseTierRequest {
  /** ⚠️ `0` = a CUSTOM tier (`announcement 873`), and for a BR shop outside Fashion that is EVERY tier. */
  readonly variation_id: number;
  /** REQUIRED iff `variation_id === 0`; FORBIDDEN otherwise (`announcement 873`). */
  readonly variation_name?: string;
  readonly variation_group_id?: number;
  readonly variation_option_list: readonly ShopeeTierOptionRequest[];
}

/**
 * `add_item` — the six REQUIRED fields are non-optional here, so a body that
 * cannot be complete does not compile.
 *
 * ⚠️ `condition` is optional on the page and MANDATORY for BR
 * (`announcement 1528` / `1460`); it stays optional in the type because the type
 * describes the WIRE, and the refusal for a BR create belongs to the publisher.
 */
export interface ShopeeAddItemRequest {
  readonly item_name: string;
  readonly description: string;
  readonly original_price: number;
  readonly weight: number;
  readonly category_id: number;
  readonly image: ShopeeImageRequest;
  readonly logistic_info: readonly ShopeeLogisticInfoRequest[];
  readonly item_status?: ShopeeItemStatusWritable;
  readonly condition?: ShopeeCondition;
  readonly dimension?: ShopeeDimensionRequest;
  readonly attribute_list?: readonly ShopeeAttributeRequest[];
  readonly brand?: ShopeeBrandRequest;
  readonly item_sku?: string;
  readonly gtin_code?: string;
  readonly seller_stock?: readonly ShopeeSellerStockRequest[];
  readonly pre_order?: ShopeePreOrderRequest;
  readonly tax_info?: ShopeeTaxInfoRequest;
  /** ⚠️ `'extended'` is whitelist-only; narrowed on purpose. */
  readonly description_type?: 'normal';
}

/**
 * `update_item` — `item_id` is the only field the page REQUIRES.
 *
 * ⚠️ FIELD-WISE: "fields not uploaded are not updated" (`guide 221 §5`). An
 * omitted key preserves; a key sent EMPTY deletes.
 */
export interface ShopeeUpdateItemRequest {
  readonly item_id: number;
  readonly item_name?: string;
  readonly description?: string;
  readonly category_id?: number;
  readonly weight?: number;
  readonly dimension?: ShopeeDimensionRequest;
  readonly image?: ShopeeImageRequest;
  readonly attribute_list?: readonly ShopeeAttributeRequest[];
  /** ⚠️ Both children are OPTIONAL here and REQUIRED on create. */
  readonly brand?: ShopeeBrandRequest;
  readonly condition?: ShopeeCondition;
  readonly item_sku?: string;
  readonly gtin_code?: string;
  readonly item_status?: ShopeeItemStatusWritable;
  readonly tax_info?: ShopeeTaxInfoRequest;
  readonly description_type?: 'normal';
  /**
   * ⚠️ ABSENT from the page's request TABLE and PRESENT in all five of its
   * request samples, in three of its own error codes and in `announcement 1395`
   * ("Logistics parameters in the update_item request will remain supported").
   * Declared. ⚠️ Never read BACK from the response: the same announcement is
   * REMOVING that block, and `announcement 1394` says to use
   * `get_item_base_info` instead.
   */
  readonly logistic_info?: readonly ShopeeLogisticInfoRequest[];
}

/** `init_tier_variation` — ⚠️ the container is `model`. */
export interface ShopeeInitTierVariationRequest {
  readonly item_id: number;
  readonly model: readonly ShopeeModelRequest[];
  readonly standardise_tier_variation?: readonly ShopeeStandardiseTierRequest[];
}

/**
 * `update_tier_variation` — ⚠️ the container is `model_list`.
 *
 * ⚠️ It is a FULL-LIST replace: a live model omitted from `model_list` loses its
 * mapping. There is deliberately NO completeness guard in this package (it cannot
 * know which models are live); the SENDER builds the list from a fresh
 * `get_model_list` and skips rather than sends a body it cannot prove complete.
 */
export interface ShopeeUpdateTierVariationRequest {
  readonly item_id: number;
  readonly model_list?: readonly {
    readonly model_id: number;
    readonly tier_index: readonly number[];
  }[];
  readonly standardise_tier_variation?: readonly ShopeeStandardiseTierRequest[];
}

/** `add_model` — ⚠️ the container is `model_list`. */
export interface ShopeeAddModelRequest {
  readonly item_id: number;
  readonly model_list: readonly ShopeeModelRequest[];
}

/**
 * `update_model` — ⚠️ the container is `model`, and the page carries a field this
 * interface deliberately cannot express.
 *
 * ⚠️ The model-status field of this page is **NOT DECLARED**: the page says
 * "Only CNSC and KRSC sellers can set the model_status", and a BR shop is
 * neither — so the field is UNCONSTRUCTIBLE here rather than merely documented
 * as forbidden. A source-text test in `test/api.test.ts` asserts the interface
 * body never regains it, because adding an optional key fails nothing.
 *
 * ⚠️ `model_sku` is REQUIRED by the page and `''` is LEGAL — `guide 221 §5`:
 * "we support the delete operation, you can upload the null string".
 */
export interface ShopeeUpdateModelRequest {
  readonly item_id: number;
  readonly model: readonly {
    readonly model_id: number;
    readonly model_sku: string;
    readonly gtin_code?: string;
    readonly weight?: number;
    readonly dimension?: ShopeeDimensionRequest;
    /** ⚠️ BOTH members are required on THIS page. */
    readonly pre_order?: { readonly is_pre_order: boolean; readonly days_to_ship: number };
  }[];
}

/** `delete_model` — two ids, no body beyond them. */
export interface ShopeeDeleteModelRequest {
  readonly item_id: number;
  readonly model_id: number;
}

/** `delete_item` — ONE id, no result body. See {@link ShopeeClient.deleteItem}. */
export interface ShopeeDeleteItemRequest {
  readonly item_id: number;
}

/** `unlist_item` — 1…{@link SHOPEE_UNLIST_MAX_ITEMS} entries, one verdict per entry. */
export interface ShopeeUnlistItemRequest {
  readonly item_list: readonly { readonly item_id: number; readonly unlist: boolean }[];
}

/** `get_item_violation_info` — 1…50 items. ⚠️ Duplicates ALLOWED, like `getItemBaseInfo`. */
export interface GetItemViolationInfoParams {
  readonly itemIds: readonly number[];
}

/* -------------------------- the stock sync (step 12) ---------------------- */

/**
 * One `seller_stock` entry of an `update_stock` model.
 *
 * ⚠️ `location_id` is a short OPAQUE STRING (`SGZ`, `IDZ`, `BRFSP1`), never a
 * number, and it is OPTIONAL: a shop outside the multi-warehouse whitelist has
 * no location to name. Whether it rides is decided per CALL and not per entry —
 * see {@link assertUpdateStockParams} rung 5.
 */
export interface ShopeeSellerStockEntry {
  readonly location_id?: string;
  /**
   * The new stock for this model at this location.
   *
   * ⚠️ `0` IS legal on an UPDATE and is the whole point of `announcement 1445`
   * for a BR shop: zeroing a listing is how it goes out of stock. The guard is
   * therefore NON-negative, never positive.
   */
  readonly stock: number;
}

/** One model of an `update_stock` call. */
export interface ShopeeUpdateStockEntry {
  /**
   * ⚠️ ALWAYS sent. `0` IS the no-model item — Shopee's own request sample
   * prints `"model_id": 0` — so a truthiness check that drops it turns the
   * simple-item write into `error_edit_item_stock_for_item_has_model`'s mirror.
   * A real id on a no-model item is the equally hard opposite error.
   */
  readonly model_id: number;
  readonly seller_stock: readonly ShopeeSellerStockEntry[];
}

/** `update_stock` — ONE item, 1…{@link SHOPEE_UPDATE_STOCK_MAX_MODELS} models. */
export interface ShopeeUpdateStockRequest {
  readonly item_id: number;
  readonly stock_list: readonly ShopeeUpdateStockEntry[];
}

/**
 * `get_item_promotion` — 1…{@link SHOPEE_ITEM_PROMOTION_MAX_IDS} items.
 *
 * ⚠️ Duplicates REFUSED — the near-miss against {@link GetItemBaseInfoParams}
 * and {@link GetItemViolationInfoParams}, which both allow them. This page's own
 * error list carries `error_param: Repeat item_id.`; theirs do not.
 */
export interface GetItemPromotionParams {
  readonly itemIds: readonly number[];
}

/**
 * `get_warehouse_detail` — the one optional parameter of the whole step.
 *
 * ⚠️ Omitted entirely when not supplied: the page documents its own default
 * (1, the pickup warehouse), so sending a copy of that default here would be a
 * second place for it to be wrong.
 */
export interface GetWarehouseDetailParams {
  readonly warehouseType?: ShopeeWarehouseType;
}

/**
 * What {@link ShopeeClient.getWarehouseDetail} answers: a list, or the typed
 * statement that this shop has no multi-warehouse regime.
 *
 * ⚠️ The fold lives HERE, in the package, so that no app ever string-matches a
 * Shopee error code. `warehouse.error_not_in_whitelist` is what the page's own
 * sample shows an ORDINARY shop receiving — treating it as a failure would make
 * the common case read as a broken call — and `error_can_not_find_warehouse` is
 * the same statement from the other side (no legal warehouse address).
 *
 * ⚠️ An error-free EMPTY array folds here too, with `code: ''`. "Nothing to map"
 * and "a regime we must refuse to write into" are the same instruction to the
 * sender; the empty `code` is what keeps them distinguishable in a log.
 */
export type ShopeeWarehouseDetail =
  | { readonly kind: 'lista'; readonly armazens: readonly ShopeeWarehouse[] }
  | { readonly kind: 'sem-multi-armazem'; readonly code: string };

/* -------------------------- the price sync (step 13) ---------------------- */

/** One model of an `update_price` call. */
export interface ShopeeUpdatePriceEntry {
  /**
   * ⚠️ ALWAYS sent. `0` IS the no-model item — the page's param table says "0
   * for no model item" and its own response sample keys that row as `0` — so a
   * truthiness check that drops it turns the simple-item write into
   * `error_edit_item_price_for_item_has_model`'s mirror. The guide's worked
   * example OMITS the key instead; which forms this page accepts is UNVERIFIED
   * until the step-13 probe, and `0` is the form with the page behind it (and
   * the one step 12 measured on the stock twin).
   */
  readonly model_id: number;
  /**
   * The new SHELF price, in the listing currency's MAJOR units. BR and SG: at
   * most two decimals (the page, verbatim). ⚠️ The package never rounds it — see
   * {@link assertUpdatePriceParams} rung 5.
   */
  readonly original_price: number;
}

/** `update_price` — ONE item, 1…{@link SHOPEE_UPDATE_PRICE_MAX_MODELS} models. */
export interface ShopeeUpdatePriceRequest {
  readonly item_id: number;
  readonly price_list: readonly ShopeeUpdatePriceEntry[];
}

/** The shop credentials `upload_image` needs ONLY under `signing: 'shop'`. */
export interface ShopeeShopAuth {
  readonly accessToken: string;
  readonly shopId: number;
}

/** `upload_image` — ONE file per call, plus the signing escape hatch. */
export interface UploadImageParams {
  readonly bytes: Uint8Array;
  readonly filename: string;
  /** One of {@link SHOPEE_UPLOAD_IMAGE_CONTENT_TYPES}, compared trimmed and lowercased. */
  readonly contentType: string;
  /** Omitted ⇒ {@link SHOPEE_UPLOAD_IMAGE_SCENE_PADRAO}, which is always SENT. */
  readonly scene?: ShopeeUploadImageScene;
  /** Supplied whenever available; USED only when the signing mode is `'shop'`. */
  readonly shopAuth?: ShopeeShopAuth;
  /**
   * ⚠️ The PROBE's seam, and only the probe's. Production passes nothing here and
   * lets {@link SHOPEE_UPLOAD_IMAGE_SIGNING} decide — ONE literal flips the whole
   * app. The sandbox check has to try BOTH arms in one run, and the partner
   * client holds no shop credentials, so two clients cannot express it.
   *
   * ⚠️ `'shop'` without {@link UploadImageParams.shopAuth} is a
   * `ShopeeConfigError` BEFORE any fetch: signing shop-class with no token would
   * go out Public-signed and come back `error_param: There is no access_token in
   * query.` — the very error the flip exists to read.
   */
  readonly signing?: ShopeeUploadImageSigning;
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

  /**
   * Upload ONE listing image and get its `image_id`.
   *
   * ⚠️ **On the PARTNER client, not the shop one.** The page is `type=Public`,
   * and the partner client is the one that never asks for an access token. The
   * shop credentials of {@link UploadImageParams.shopAuth} are a PARAMETER
   * precisely so the escape hatch does not turn this into a token-holding client.
   *
   * ⚠️ The WHOLE parsed envelope comes back (not `res.response`), like every
   * other write in this package: `warning` is a partial-failure channel and
   * unwrapping would make it unreachable.
   *
   * ⚠️ Failure semantics worth knowing before reading a log: this page's own
   * error list carries `error_param: There is no access_token in query.` and
   * `error_auth: Invalid access_token.`, and under the default
   * `signing: 'public'` BOTH mean *the signing mode is wrong*, never *the seller
   * must reconnect*. They classify as kind `other` on the business surface, so
   * they can never answer 409 `SHOPEE_REAUTH_REQUIRED` and send an operator to
   * re-authorize a healthy conta.
   */
  uploadImage(p: UploadImageParams): Promise<ShopeeUploadImageResponse>;
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
   * ONE page of this shop's item ids.
   *
   * ⚠️ It does NOT auto-page: `has_next_page` and `next_offset` come back on the
   * payload and the caller echoes `next_offset` — NEVER `offset + page_size`,
   * which is what the legacy did and what makes a mutating catalogue skip rows.
   *
   * ⚠️ `item_status` is REQUIRED and is a REPEATED query key. The caller picks
   * the set; this package never defaults it — see
   * {@link GetItemListParams.statuses}.
   *
   * ⚠️ `total_count` is INFORMATIONAL. It is glossed "total count of all items"
   * and no page says whether it honours the `item_status` filter, so nothing may
   * use it as a progress denominator or as a termination signal.
   *
   * ⚠️ `error_param: get items offset over limit, please use the next field` is
   * a documented error of this page and its cap VALUE appears nowhere. It is
   * TERMINAL for a scan, not retryable: the mitigation is a narrower
   * `update_time` window.
   *
   * ⚠️ The page documents NO ordering and no stability across pages. An offset
   * walk over a catalogue that changes under it can skip rows; the only
   * documented mitigation is freezing the window with `updateTimeFromS`/`ToS`.
   */
  getItemList(p: GetItemListParams): Promise<ShopeeItemList>;

  /**
   * The FULL detail of 1…50 items.
   *
   * ⚠️ It ALWAYS sends `need_tax_info=true` and NEVER `need_complaint_policy`,
   * and neither is a parameter: the BR fiscal block is ABSENT unless asked for
   * (the legacy never asked, so NCM/CEST/origem never arrived), and
   * `complaint_policy` is PL-only — pure body weight for a BR shop.
   *
   * ⚠️ The response may carry FEWER rows than were asked for. Reconcile by
   * `item_id`, never by position.
   *
   * ⚠️ `promotion_id` is NOT on this response (removed 2026-04-03); it survives
   * only in the page's stale sample, and nothing here reads it.
   *
   * ⚠️ `price_info` is absent when `has_model` is true — per-model prices come
   * from {@link ShopeeClient.getModelList}.
   */
  getItemBaseInfo(p: GetItemBaseInfoParams): Promise<ShopeeItemBaseInfo>;

  /**
   * ONE item's variation trees and models.
   *
   * ⚠️ One call per item: there is no batch form and no paging on this page,
   * which is why a catalogue import has to be resumable.
   *
   * ⚠️ BOTH trees travel to the caller. `tier_variation` is deprecated on the
   * WRITE side only and is still a documented response field;
   * `standardise_tier_variation` is all-zeros for a BR shop outside Fashion,
   * where the only usable option identity is the NAME.
   */
  getModelList(p: GetModelListParams): Promise<ShopeeModelList>;

  /**
   * ONE kit item and its components.
   *
   * ⚠️ There is NO kit LISTING endpoint. Kits are discovered only through
   * `get_item_list`'s `item.tag.kit`.
   *
   * ⚠️ `item_id` is a SCALAR that carries a batch bound (`limits [0,50]`) on its
   * own page; every sample and the response itself handle exactly one kit.
   *
   * ⚠️ The kit pages carry NO stock field anywhere and the derivation rule is
   * undocumented. Nothing in this repo may infer one.
   *
   * ⚠️ Four field names differ from the item read on purpose — see
   * `shopeeKitItemSchema` in `types.ts`, which lists every one.
   */
  getKitItemInfo(p: GetKitItemInfoParams): Promise<ShopeeKitItemInfo>;

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

  /**
   * The FULL detail of 1…50 packages — the per-package twin of
   * {@link ShopeeClient.getOrderDetail}, and the only Shopee surface that carries
   * `fulfillment_status`, `tracking_number`, `ship_by_date`,
   * `logistics_channel_id` and a package `update_time` together.
   *
   * ⚠️ The response may carry FEWER rows than were asked for, and an unreadable
   * row arrives as a `null` in place. Reconcile by `package_number`, never by
   * position, and count the nulls.
   *
   * ⚠️ It does NOT fan out and does NOT page: this page has no cursor and no
   * `more`. One call, one list; the caller chunks at
   * {@link SHOPEE_PACKAGE_DETAIL_MAX_PACKAGES}.
   *
   * ⚠️ `is_shipment_arranged` rides on this response and is **step 15's** guard,
   * not a shipped signal: it is "only effective when the package's
   * logistics_status/fulfillment_status is LOGISTICS_READY".
   *
   * ⚠️ `error: "-"` is SUCCESS on this operation — see
   * {@link SHOPEE_PACKAGE_DETAIL_ERROR_ALIASES}. On every other order page it is
   * still a failure.
   */
  getPackageDetail(p: GetPackageDetailParams): Promise<ShopeePackageDetail>;

  /* ---------------------- the listing writes (step 11) ---------------------- */

  /**
   * Create a listing.
   *
   * ⚠️ **Every write here returns the WHOLE parsed envelope**, not `res.response`
   * — the `confirmConsumedLostPushMessages` precedent. A write's `warning` is a
   * partial-failure channel (Shopee accepts the item and says what it ignored),
   * and unwrapping would drop it on the floor. The two READS below unwrap, like
   * every other read in this file.
   *
   * ⚠️ Nothing in this repo reads the echo beyond `item_id`: listing state is
   * read back through `get_item_base_info` (`announcement 1394`), because
   * `announcement 1395` is removing the response's logistics block.
   *
   * ⚠️ An item created WITH variations is created UNLIST with a throwaway
   * item-level price and stock, then tiered, then re-listed. That order is the
   * caller's; this method sends exactly the body it is given.
   */
  addItem(body: ShopeeAddItemRequest): Promise<ShopeeItemWriteResponse>;

  /**
   * Update a listing, FIELD-WISE.
   *
   * ⚠️ "Fields not uploaded are not updated" (`guide 221 §5`) — so an omitted key
   * PRESERVES and an empty one DELETES. A size chart attached in Seller Centre
   * survives a republish that never mentions it, and an `item_sku: ''` erases the
   * SKU.
   *
   * ⚠️ `logistic_info` IS accepted (`announcement 1395`), even though the page's
   * request table omits it.
   */
  updateItem(body: ShopeeUpdateItemRequest): Promise<ShopeeItemWriteResponse>;

  /**
   * The FIRST tier/model write of an item — ⚠️ container `model`.
   *
   * ⚠️ The response pairs models with `tier_index` only as a cross-check: the
   * authoritative pairing comes from a fresh `get_model_list`. An unreadable row
   * arrives as a `null` in place rather than failing the page, because by then
   * Shopee has already minted the models.
   */
  initTierVariation(body: ShopeeInitTierVariationRequest): Promise<ShopeeTierWriteResponse>;

  /**
   * Re-map LIVE models onto tier options — ⚠️ container `model_list`, and a FULL
   * LIST.
   *
   * ⚠️ A live model omitted from the list loses its mapping, and this package
   * cannot know which models are live, so there is deliberately **no completeness
   * guard here**. The sender builds the list from a fresh `get_model_list` and
   * skips rather than sends a body it cannot prove complete — a half-guard at the
   * wire would read like the real one.
   */
  updateTierVariation(body: ShopeeUpdateTierVariationRequest): Promise<ShopeeWriteAck>;

  /** Add models to an item that already has tiers — ⚠️ container `model_list`. */
  addModel(body: ShopeeAddModelRequest): Promise<ShopeeTierWriteResponse>;

  /**
   * Update model SKU / GTIN / weight / dimension / pre-order — ⚠️ container
   * `model`.
   *
   * ⚠️ It carries NO price and NO stock: those are `update_price` /
   * `update_stock` (steps 12 and 13), and no body shape here can smuggle them.
   */
  updateModel(body: ShopeeUpdateModelRequest): Promise<ShopeeWriteAck>;

  /**
   * Delete ONE model.
   *
   * ⚠️ **No step-11 caller.** `update_tier_variation` already deletes by omission,
   * and the publisher never deletes a model or a link doc — a model that vanished
   * upstream is MARKED, never erased. It ships because the operation is part of
   * this page family and a bound guard plus a test is cheaper than a second,
   * unguarded copy the day something does need it.
   */
  deleteModel(body: ShopeeDeleteModelRequest): Promise<ShopeeWriteAck>;

  /**
   * Delete ONE item.
   *
   * ⚠️ **No step-11 caller: the sandbox probe's cleanup only.** The publisher
   * never deletes a listing — pausing is `unlist_item` — and Shopee's own delete
   * is not a tidy inverse of create: a deleted item stays readable for 90 days,
   * cannot be updated, and four separate promotion locks refuse the call outright
   * (`error_cannt_delete_in_promotion`, `error_in_item_promotion_delete_lock`,
   * `error_in_model_promotion_delete_lock`, `error_slash_price_item_delete_lock`).
   * It exists so a rehearsal against the sandbox shop can clean up after itself
   * instead of leaving a probe item behind for a human to find.
   */
  deleteItem(body: ShopeeDeleteItemRequest): Promise<ShopeeWriteAck>;

  /**
   * Pause or re-list 1…50 items in ONE call.
   *
   * ⚠️ `unlist: false` RE-LISTS (`guide 221 §6`), and `success_list[].unlist`
   * ECHOES THE REQUEST FLAG — it is NOT the item's new `item_status`. Whoever
   * needs the new status re-reads `get_item_base_info`.
   *
   * ⚠️ Per-entry verdicts: an entry can land in `failure_list` while the call
   * answers 200 with an empty `error`. A caller that only checked for a throw
   * would report a pause that never happened.
   */
  unlistItem(body: ShopeeUnlistItemRequest): Promise<ShopeeUnlistItemResponse>;

  /**
   * The violation / deboost detail of 1…50 items — UNWRAPPED, like every read.
   *
   * ⚠️ **This page's SUCCESS body carries no `error` key, and that is MEASURED.**
   * Both of its response samples print `{"message": null, "request_id": …,
   * "response": {…}}` while its own Response-params table declares an `error`,
   * and on 2026-09-17 the sandbox answered exactly the samples' shape (register
   * 73) — stage 1 refused it naming `error`. So this op, and ONLY this op, opts
   * into the transport's per-operation absent-key tolerance (`call.ts`), which
   * still demands a `response` object: a body carrying neither key is refused as
   * before.
   *
   * ⚠️ **Every call site stays best-effort regardless.** The op can still fail —
   * network, rate limit, a real `error_*`, a body with neither key — and none of
   * those may cost the caller its listing state: treat a throw of ANY class as
   * "no violation detail this time" and fall back on `get_item_base_info`'s
   * status + deboost.
   *
   * ⚠️ A row carries its OWN failure in band (`fail_error` / `fail_message`) — a
   * third partial-failure encoding in this module. Reconcile by `item_id`.
   */
  getItemViolationInfo(p: GetItemViolationInfoParams): Promise<ShopeeItemViolationInfo>;

  /**
   * Every logistics channel of the SHOP — UNWRAPPED, and it takes NO parameters
   * at all (the page's Request-params section is empty), the
   * `getLostPushMessages` precedent.
   *
   * ⚠️ `size_list[].size_id` comes back a **STRING** here and `add_item` wants an
   * `int32`. Nothing in this package converts it: a `"0"` round-tripped as `0`
   * would send a size the seller never picked.
   */
  getChannelList(): Promise<ShopeeChannelList>;

  /* ------------------------ the stock sync (step 12) ---------------------- */

  /**
   * Set the stock of 1…{@link SHOPEE_UPDATE_STOCK_MAX_MODELS} models of ONE
   * item — the WHOLE envelope, like every write here.
   *
   * ⚠️ **A non-empty `error` arrives WITH the per-model detail on this page**,
   * and that is the reason this operation exists in the shape it does. Its own
   * list documents `error_busi_update_stock_failed: Update stock failed, please
   * check failure_list for detailed reason`, and `failure_list` lives under
   * `response`. So this is the ONE call site carrying the transport's
   * `payloadNoErro`: the throw stays a throw, and the thrown
   * `ShopeeApiPartialError` carries the parsed body so the caller can attribute
   * the refusal to the models it actually hit. Everything else — a throttle, a
   * dead authorization, a body with no `response` — throws the ordinary class,
   * because the operation schema refuses those bodies and nothing is attached.
   *
   * ⚠️ It does NOT catch. A caller that needs the per-model verdicts narrows on
   * the subclass; a caller that only needs "did it land" sees a failure, which
   * is what it is.
   *
   * ⚠️ And a 200 with an EMPTY `error` can still carry a non-empty
   * `failure_list` — the `unlist_item` hazard on a second page. Whoever writes
   * the result back reads both lists, never just the absence of a throw.
   */
  updateStock(body: ShopeeUpdateStockRequest): Promise<ShopeeUpdateStockResponse>;

  /**
   * Every live and upcoming promotion of 1…50 items — UNWRAPPED, like every
   * read.
   *
   * ⚠️ Step 12 reads exactly one thing from it: the per-model RESERVED FLOOR
   * (`promotion_stock_info_v2`, through `reservadoDaPromocao`), because a
   * listing inside a promotion refuses any stock below what the promotion holds
   * (`faq 59`). `get_model_list`'s `promotion_id` cannot answer that question —
   * it carries only ONE of several concurrent promotions (`guide 221 §4`) and no
   * stock at all.
   *
   * ⚠️ Duplicate `item_id` is REFUSED here and ALLOWED by
   * {@link ShopeeClient.getItemBaseInfo}: this page's own error list carries
   * `error_param: Repeat item_id.` and theirs do not.
   *
   * ⚠️ `promotion_id` comes back a STRING and must stay one — it is `uint64`
   * since 2026-07-31, so a number would lose precision above 2^53 on ids this
   * package never does arithmetic with anyway.
   */
  getItemPromotion(p: GetItemPromotionParams): Promise<ShopeeItemPromotionPayload>;

  /**
   * Whether the SHOP is on holiday mode — UNWRAPPED, and it takes NO parameters
   * at all (the page's Request-params section is empty), the
   * {@link ShopeeClient.getChannelList} precedent.
   *
   * ⚠️ `holiday_mode_type` reads backwards: `1` is PARTIAL (orders still
   * arrive), `0` is FULL. {@link SHOPEE_HOLIDAY_MODE_TYPE} names both so nobody
   * has to remember which way round it goes, and it is only meaningful while
   * `holiday_mode_on` is true.
   */
  getShopHolidayMode(): Promise<ShopeeShopHolidayMode>;

  /**
   * The shop's warehouses — or the typed statement that it has none.
   *
   * ⚠️ **The ONE operation in this package that folds an error into a value**,
   * and the fold is exactly {@link SHOPEE_WAREHOUSE_SEM_ACESSO}: the page's own
   * sample shows `warehouse.error_not_in_whitelist` as what an ORDINARY shop
   * receives, so a shop with no multi-warehouse regime would otherwise read as a
   * broken call on every sweep. Every other `ShopeeApiError` — and every other
   * class — rethrows untouched.
   *
   * ⚠️ The module prefix is tolerated: the code matches verbatim OR after
   * `shopeeCodeSemPrefixoDeModulo`, because Shopee prints both spellings.
   *
   * ⚠️ `location_id` is a short opaque STRING and is the value `update_stock`
   * echoes back; nothing here parses it as a number.
   */
  getWarehouseDetail(p?: GetWarehouseDetailParams): Promise<ShopeeWarehouseDetail>;

  /* ------------------------ the price sync (step 13) ---------------------- */

  /**
   * Set the SHELF price (`original_price`) of 1…{@link SHOPEE_UPDATE_PRICE_MAX_MODELS}
   * models of ONE item — the WHOLE envelope, like every write here.
   *
   * ⚠️ **A 200 with `error: ''` can carry a non-empty `failure_list`**, and on
   * this page that is the ONLY documented partial shape: the response sample
   * prints `error: ""` with both lists, and step 12's probe measured the stock
   * twin answering a mixed batch exactly that way. So whoever writes the result
   * back reads BOTH lists, never the absence of a throw — a model in neither
   * list was not confirmed.
   *
   * ⚠️ Unlike {@link ShopeeClient.updateStock} it does NOT carry the transport's
   * failure-list flag: this page documents no "check failure_list" code, so a
   * non-empty `error` is a whole-call failure and throws the ordinary
   * `ShopeeApiError` (a throttle its `ShopeeRateLimitError`), with no payload
   * attached. Whether Shopee ever sends a non-empty `error` WITH the lists here
   * is UNVERIFIED; the flip, if the probe finds it, is the flag plus its pins.
   *
   * ⚠️ It does NOT round. A price with a third decimal is REFUSED before the
   * fetch ({@link assertUpdatePriceParams} rung 5): rounding is the caller's
   * (`roundReais`), so the package never decides a price.
   */
  updatePrice(body: ShopeeUpdatePriceRequest): Promise<ShopeeUpdatePriceResponse>;
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
 * Every `get_item_list` bound, checked BEFORE any fetch.
 *
 * ⚠️ Every branch is a `ShopeeConfigError` — a caller bug, never a provider
 * failure — so the mass import's provider-error containment must not swallow it:
 * a contained one would be written into the job as a per-item failure and read
 * like a catalogue of broken listings.
 *
 * ⚠️ The EMPTY-list branch is the one this file owes the transport.
 * `signedQuery` emits NOTHING for an empty array (it is a query builder and owns
 * no refusal vocabulary), so without this branch a required parameter would
 * simply not go out and Shopee would answer `error_param_item_status` — a
 * message that reads like a provider fault and points nowhere near the caller
 * that forgot the list.
 *
 * ⚠️ `offset >= 0`, deliberately NOT `assertIdPositivo`: the first page IS
 * offset zero, and reusing the id reader here would refuse it.
 */
function assertItemListParams(p: GetItemListParams): void {
  if (!Number.isSafeInteger(p.pageSize) || p.pageSize < 1 || p.pageSize > SHOPEE_MAX_PAGE_SIZE) {
    throw new ShopeeConfigError(
      `page_size deve estar entre 1 e ${String(SHOPEE_MAX_PAGE_SIZE)} (recebido: ${JSON.stringify(p.pageSize)}).`,
    );
  }
  if (!Number.isSafeInteger(p.offset) || p.offset < 0) {
    throw new ShopeeConfigError(
      `offset deve ser um inteiro >= 0 (recebido: ${JSON.stringify(p.offset)}).`,
    );
  }
  if (p.statuses.length === 0) {
    throw new ShopeeConfigError(
      'item_status é obrigatório: informe ao menos um status (uma lista vazia não emite chave nenhuma).',
    );
  }
  const conhecidos = new Set<string>(Object.values(SHOPEE_ITEM_STATUS_WIRE));
  const vistos = new Set<string>();
  p.statuses.forEach((status, posicao) => {
    // ⚠️ Case-SENSITIVE. `'normal'` is not a wire value: Shopee's enum is
    // uppercase, and folding the case here would make this client accept a
    // spelling only it understands.
    if (!conhecidos.has(status)) {
      throw new ShopeeConfigError(
        `item_status inválido (posição ${String(posicao)}, recebido: ${JSON.stringify(status)}).`,
      );
    }
    if (vistos.has(status)) {
      throw new ShopeeConfigError(
        `item_status repetido (posição ${String(posicao)}, recebido: ${JSON.stringify(status)}).`,
      );
    }
    vistos.add(status);
  });
  if (p.updateTimeFromS !== undefined)
    assertSegundosPositivos('update_time_from', p.updateTimeFromS);
  if (p.updateTimeToS !== undefined) assertSegundosPositivos('update_time_to', p.updateTimeToS);
  if (
    p.updateTimeFromS !== undefined &&
    p.updateTimeToS !== undefined &&
    p.updateTimeFromS >= p.updateTimeToS
  ) {
    // ⚠️ STRICT: the page's own `error_update_time_range` says "Update_time_to
    // should be LATER than update_time_from", so a zero-width window is refused
    // here — unlike `get_escrow_list`, whose page allows one.
    throw new ShopeeConfigError(
      `update_time_from deve ser anterior a update_time_to (recebido: ${JSON.stringify(p.updateTimeFromS)} e ${JSON.stringify(p.updateTimeToS)}).`,
    );
  }
}

/**
 * Every `get_item_base_info` bound, checked BEFORE any fetch.
 *
 * ⚠️ The per-element branch is the load-bearing one, for
 * `assertOrderDetailParams`'s reason: the wire parameter is ONE joined scalar,
 * so Shopee's `error_param` could only ever say that `item_id_list` was wrong,
 * never WHICH element — and a `0` id sent for Shopee to reject costs a call that
 * was never going to answer.
 */
function assertItemBaseInfoParams(p: GetItemBaseInfoParams): void {
  const quantidade = p.itemIds.length;
  if (quantidade < 1 || quantidade > SHOPEE_ITEM_BASE_INFO_MAX_IDS) {
    throw new ShopeeConfigError(
      `item_id_list deve conter de 1 a ${String(SHOPEE_ITEM_BASE_INFO_MAX_IDS)} itens (recebido: ${String(quantidade)}).`,
    );
  }
  p.itemIds.forEach((itemId, posicao) => {
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      throw new ShopeeConfigError(
        `item_id_list deve ser um inteiro positivo (posição ${String(posicao)}, recebido: ${JSON.stringify(itemId)}).`,
      );
    }
  });
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

/**
 * Every `get_package_detail` bound, checked BEFORE any fetch.
 *
 * ⚠️ Every branch is a `ShopeeConfigError` — a caller bug, never a provider
 * failure — so the shipment arm's provider-error containment must not swallow
 * it. Each refusal is its own message naming the POSITION, because the wire
 * parameter is ONE joined scalar: Shopee's own `error_param` could only say that
 * `package_number_list` was wrong, never which element.
 *
 * ⚠️ The `-` branch is this page's own contradiction reaching the request side.
 * `-` is the page's ABSENCE sentinel on `tracking_number`, `item_sku` and
 * `virtual_contact_number`; a caller that read one of those and fed it straight
 * back would be asking for "no package", and Shopee would answer with a row set
 * nobody asked for rather than with an error.
 *
 * ⚠️ Two branches judge the element TRIMMED, so the SENDER trims too — see
 * {@link GetPackageDetailParams.packageNumbers}. Judging one string and sending
 * another is how a refusal passes over the value that actually goes out.
 */
function assertPackageDetailParams(p: GetPackageDetailParams): void {
  const quantidade = p.packageNumbers.length;
  if (quantidade < 1 || quantidade > SHOPEE_PACKAGE_DETAIL_MAX_PACKAGES) {
    throw new ShopeeConfigError(
      `package_number_list deve conter de 1 a ${String(SHOPEE_PACKAGE_DETAIL_MAX_PACKAGES)} pacotes (recebido: ${String(quantidade)}).`,
    );
  }
  p.packageNumbers.forEach((numero, posicao) => {
    if (typeof numero !== 'string' || numero.trim() === '') {
      throw new ShopeeConfigError(
        `package_number não pode ser vazio (posição ${String(posicao)}, recebido: ${JSON.stringify(numero)}).`,
      );
    }
    if (numero.trim() === '-') {
      throw new ShopeeConfigError(
        `package_number "-" é a SENTINELA de ausência desta página, nunca uma chave (posição ${String(posicao)}).`,
      );
    }
    if (numero.includes(',')) {
      throw new ShopeeConfigError(
        `package_number não pode conter vírgula — ela é o separador da lista (posição ${String(posicao)}).`,
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

/* -------------------------------------------------------------------------- */
/*                 The listing writes (step 11) — the bound guards             */
/* -------------------------------------------------------------------------- */

/**
 * A Shopee id that may legitimately be **0** — the CUSTOM sentinel on both
 * standardise levels (`announcement 873`).
 *
 * ⚠️ NEVER {@link assertIdPositivo} here: for a BR shop outside Fashion EVERY
 * `variation_id` and `variation_option_id` is 0, so the positive reader would
 * refuse every custom tier in the catalogue. Same for `brand_id`, where 0 is
 * "No Brand".
 */
function assertIdNaoNegativo(nome: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ShopeeConfigError(
      `${nome} deve ser um inteiro >= 0 (recebido: ${JSON.stringify(value)}).`,
    );
  }
}

/** A price or a weight: finite and strictly positive. */
function assertPositivoFinito(nome: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ShopeeConfigError(
      `${nome} deve ser um número positivo (recebido: ${JSON.stringify(value)}).`,
    );
  }
}

/** A stock or a `tier_index` element: an integer, zero included. */
function assertInteiroNaoNegativo(nome: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ShopeeConfigError(
      `${nome} deve ser um inteiro >= 0 (recebido: ${JSON.stringify(value)}).`,
    );
  }
}

function assertTextoNaoVazio(nome: string, value: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ShopeeConfigError(`${nome} não pode ser vazio (recebido: ${JSON.stringify(value)}).`);
  }
}

/** Three positive int32 centimetres, all three or none. */
function assertDimensao(nome: string, d: ShopeeDimensionRequest): void {
  assertIdPositivo(`${nome}.package_height`, d.package_height);
  assertIdPositivo(`${nome}.package_length`, d.package_length);
  assertIdPositivo(`${nome}.package_width`, d.package_width);
}

/**
 * `image.image_id_list` — 1…{@link SHOPEE_ITEM_IMAGE_MAX} non-blank ids.
 *
 * ⚠️ The hard ceiling, not the band: the real bound is per SHOP and per CATEGORY
 * (`get_item_limit.item_image_count_limit`), so a body that clears this one can
 * still be refused. A blank id is refused because Shopee renders the list
 * POSITIONALLY — one empty string shifts every later picture.
 */
function assertImagem(nome: string, img: ShopeeImageRequest): void {
  const quantidade = img.image_id_list.length;
  if (quantidade < 1 || quantidade > SHOPEE_ITEM_IMAGE_MAX) {
    throw new ShopeeConfigError(
      `${nome}.image_id_list deve conter de 1 a ${String(SHOPEE_ITEM_IMAGE_MAX)} imagens (recebido: ${String(quantidade)}).`,
    );
  }
  img.image_id_list.forEach((id, posicao) => {
    assertTextoNaoVazio(`${nome}.image_id_list[${String(posicao)}]`, id);
  });
}

/**
 * `attribute_list` — and the one rule the stored attributes cannot encode:
 * `value_id: 0` is the CUSTOM sentinel and REQUIRES `original_value_name`
 * (`guide 211 §2.2`).
 */
function assertAtributos(atributos: readonly ShopeeAttributeRequest[]): void {
  atributos.forEach((atributo, posicao) => {
    assertIdPositivo(`attribute_list[${String(posicao)}].attribute_id`, atributo.attribute_id);
    (atributo.attribute_value_list ?? []).forEach((valor, j) => {
      const onde = `attribute_list[${String(posicao)}].attribute_value_list[${String(j)}]`;
      assertIdNaoNegativo(`${onde}.value_id`, valor.value_id);
      if (valor.value_id === 0) {
        if (valor.original_value_name === undefined) {
          throw new ShopeeConfigError(
            `${onde}.original_value_name é obrigatório quando value_id é 0 (valor personalizado).`,
          );
        }
        assertTextoNaoVazio(`${onde}.original_value_name`, valor.original_value_name);
      }
    });
  });
}

/** Each `logistic_id` a positive int; the list itself may not be empty on a create. */
function assertLogistica(canais: readonly ShopeeLogisticInfoRequest[]): void {
  canais.forEach((canal, posicao) => {
    assertIdPositivo(`logistic_info[${String(posicao)}].logistic_id`, canal.logistic_id);
  });
}

function assertEstoqueDoVendedor(
  nome: string,
  estoques: readonly ShopeeSellerStockRequest[],
): void {
  estoques.forEach((e, posicao) => {
    assertInteiroNaoNegativo(`${nome}[${String(posicao)}].stock`, e.stock);
  });
}

/** `brand.brand_id` — ⚠️ `0` ("No Brand") is a VALUE and must pass. */
function assertMarca(marca: ShopeeBrandRequest): void {
  assertIdNaoNegativo('brand.brand_id', marca.brand_id);
  assertTextoNaoVazio('brand.original_brand_name', marca.original_brand_name);
}

function assertStatusGravavel(value: ShopeeItemStatusWritable): void {
  const gravaveis = new Set<string>(Object.values(SHOPEE_ITEM_STATUS_WRITABLE));
  if (!gravaveis.has(value)) {
    throw new ShopeeConfigError(
      `item_status de escrita deve ser ${Object.values(SHOPEE_ITEM_STATUS_WRITABLE).join(' ou ')} (recebido: ${JSON.stringify(value)}).`,
    );
  }
}

function assertCondicao(value: ShopeeCondition): void {
  const conhecidas = new Set<string>(Object.values(SHOPEE_CONDITION));
  if (!conhecidas.has(value)) {
    throw new ShopeeConfigError(
      `condition deve ser ${Object.values(SHOPEE_CONDITION).join(' ou ')} (recebido: ${JSON.stringify(value)}).`,
    );
  }
}

/** Every `add_item` bound, checked BEFORE any fetch. */
function assertAddItemParams(req: ShopeeAddItemRequest): void {
  assertTextoNaoVazio('item_name', req.item_name);
  assertTextoNaoVazio('description', req.description);
  assertPositivoFinito('original_price', req.original_price);
  // ⚠️ Shopee's own `error_param: Invalid Weight.` — the WIRE floor. The
  // publisher's `sem-peso` refusal is a different, earlier decision.
  assertPositivoFinito('weight', req.weight);
  assertIdPositivo('category_id', req.category_id);
  assertImagem('image', req.image);
  if (req.logistic_info.length === 0) {
    throw new ShopeeConfigError('logistic_info deve conter ao menos um canal habilitado.');
  }
  assertLogistica(req.logistic_info);
  if (req.dimension !== undefined) assertDimensao('dimension', req.dimension);
  if (req.item_status !== undefined) assertStatusGravavel(req.item_status);
  if (req.condition !== undefined) assertCondicao(req.condition);
  if (req.seller_stock !== undefined) assertEstoqueDoVendedor('seller_stock', req.seller_stock);
  if (req.brand !== undefined) assertMarca(req.brand);
  if (req.attribute_list !== undefined) assertAtributos(req.attribute_list);
}

/**
 * Every `update_item` bound, plus the one this page needs and the create does
 * not: a body carrying ONLY `item_id` is a spent call and a caller bug.
 */
function assertUpdateItemParams(req: ShopeeUpdateItemRequest): void {
  assertIdPositivo('item_id', req.item_id);
  // ⚠️ Counted over DEFINED VALUES, never over keys: `exactOptionalPropertyTypes`
  // is off in this repo, so `item_name: nome ?? undefined` is legal TypeScript and
  // `Object.keys` would count it — while `JSON.stringify` drops it and posts the
  // `{item_id}` body this very guard exists to refuse.
  const mutaveis = Object.entries(req).filter(
    ([chave, valor]) => chave !== 'item_id' && valor !== undefined,
  );
  if (mutaveis.length === 0) {
    throw new ShopeeConfigError(
      'update_item precisa de ao menos um campo além de item_id — um corpo só com o id gasta a chamada e não muda nada.',
    );
  }
  if (req.item_name !== undefined) assertTextoNaoVazio('item_name', req.item_name);
  if (req.description !== undefined) assertTextoNaoVazio('description', req.description);
  if (req.category_id !== undefined) assertIdPositivo('category_id', req.category_id);
  if (req.weight !== undefined) assertPositivoFinito('weight', req.weight);
  if (req.dimension !== undefined) assertDimensao('dimension', req.dimension);
  if (req.image !== undefined) assertImagem('image', req.image);
  if (req.attribute_list !== undefined) assertAtributos(req.attribute_list);
  if (req.brand !== undefined) assertMarca(req.brand);
  if (req.condition !== undefined) assertCondicao(req.condition);
  if (req.item_status !== undefined) assertStatusGravavel(req.item_status);
  if (req.logistic_info !== undefined) assertLogistica(req.logistic_info);
}

/**
 * `init_tier_variation.model[]` and `add_model.model_list[]` — one guard, two
 * containers.
 *
 * ⚠️ The duplicate-`tier_index` refusal is the load-bearing one: two models at
 * the same combination is one silently overwriting the other, and Shopee's own
 * message would name neither.
 */
function assertModelListParams(
  nome: string,
  models: readonly ShopeeModelRequest[],
  opcoes: { readonly tiers?: readonly ShopeeStandardiseTierRequest[] } = {},
): void {
  if (models.length < 1 || models.length > SHOPEE_MODEL_MAX_PER_ITEM) {
    throw new ShopeeConfigError(
      `${nome} deve conter de 1 a ${String(SHOPEE_MODEL_MAX_PER_ITEM)} modelos (recebido: ${String(models.length)}).`,
    );
  }
  const combinacoes = new Set<string>();
  models.forEach((model, posicao) => {
    const onde = `${nome}[${String(posicao)}]`;
    assertPositivoFinito(`${onde}.original_price`, model.original_price);
    if (model.seller_stock.length === 0) {
      throw new ShopeeConfigError(`${onde}.seller_stock deve conter ao menos uma entrada.`);
    }
    assertEstoqueDoVendedor(`${onde}.seller_stock`, model.seller_stock);
    if (model.model_sku !== undefined && model.model_sku.length > SHOPEE_MODEL_SKU_MAX_LENGTH) {
      throw new ShopeeConfigError(
        `${onde}.model_sku deve ter no máximo ${String(SHOPEE_MODEL_SKU_MAX_LENGTH)} caracteres (recebido: ${String(model.model_sku.length)}).`,
      );
    }
    if (model.dimension !== undefined) {
      assertDimensao(`${onde}.dimension`, model.dimension);
      // Both model pages: "If set the dimension of this model, them must set the
      // weight of this model".
      if (model.weight === undefined) {
        throw new ShopeeConfigError(`${onde}.weight é obrigatório quando dimension é informado.`);
      }
    }
    if (model.weight !== undefined) assertPositivoFinito(`${onde}.weight`, model.weight);
    assertTierIndex(onde, model.tier_index, opcoes.tiers);
    // ⚠️ Joined on a NUL so `[1,11]` and `[11,1]` cannot collide with `[1,1,1]`.
    const chave = model.tier_index.join('\u0000');
    if (combinacoes.has(chave)) {
      throw new ShopeeConfigError(
        `${onde}.tier_index repete uma combinação já usada (${JSON.stringify(model.tier_index)}) — dois modelos na mesma combinação é um sobrescrevendo o outro.`,
      );
    }
    combinacoes.add(chave);
  });
}

/**
 * `tier_index` — 1…{@link SHOPEE_TIER_MAX_LEVELS} non-negative ints, and exactly
 * one entry per declared tier when the same body declared them
 * (`error_param: Model tier_index error.`).
 */
function assertTierIndex(
  onde: string,
  tierIndex: readonly number[],
  tiers?: readonly ShopeeStandardiseTierRequest[],
): void {
  if (tierIndex.length < 1 || tierIndex.length > SHOPEE_TIER_MAX_LEVELS) {
    throw new ShopeeConfigError(
      `${onde}.tier_index deve ter de 1 a ${String(SHOPEE_TIER_MAX_LEVELS)} níveis (recebido: ${String(tierIndex.length)}).`,
    );
  }
  tierIndex.forEach((indice, j) => {
    assertInteiroNaoNegativo(`${onde}.tier_index[${String(j)}]`, indice);
  });
  if (tiers !== undefined && tierIndex.length !== tiers.length) {
    throw new ShopeeConfigError(
      `${onde}.tier_index deve ter um índice por tier declarado (${String(tiers.length)}); recebido ${String(tierIndex.length)}.`,
    );
  }
}

/**
 * `standardise_tier_variation` — the bounds, plus `announcement 873`'s XOR:
 * "If you input variation_name & variation_id, and variation_id != 0, it will not
 * allow you to input variation_name. … If variation_id = 0, then you must pass
 * the variation_name."
 *
 * ⚠️ `optionIdRequired` is TRUE for `update_tier_variation` (its table marks the
 * option id REQUIRED) and FALSE for `init_tier_variation` (optional there).
 */
function assertStandardiseTiers(
  tiers: readonly ShopeeStandardiseTierRequest[],
  opcoes: { readonly optionIdRequired: boolean },
): void {
  if (tiers.length < 1 || tiers.length > SHOPEE_TIER_MAX_LEVELS) {
    throw new ShopeeConfigError(
      `standardise_tier_variation deve ter de 1 a ${String(SHOPEE_TIER_MAX_LEVELS)} tiers (recebido: ${String(tiers.length)}).`,
    );
  }
  tiers.forEach((tier, posicao) => {
    const onde = `standardise_tier_variation[${String(posicao)}]`;
    assertIdNaoNegativo(`${onde}.variation_id`, tier.variation_id);
    if (tier.variation_id === 0) {
      if (tier.variation_name === undefined) {
        throw new ShopeeConfigError(
          `${onde}.variation_name é obrigatório quando variation_id é 0 (tier personalizado).`,
        );
      }
      assertTextoNaoVazio(`${onde}.variation_name`, tier.variation_name);
    } else if (tier.variation_name !== undefined) {
      throw new ShopeeConfigError(
        `${onde}.variation_name é PROIBIDO quando variation_id != 0 — a Shopee recusa o par (announcement 873).`,
      );
    }
    const opcoesDoTier = tier.variation_option_list;
    if (opcoesDoTier.length < 1 || opcoesDoTier.length > SHOPEE_TIER_MAX_OPTIONS) {
      throw new ShopeeConfigError(
        `${onde}.variation_option_list deve ter de 1 a ${String(SHOPEE_TIER_MAX_OPTIONS)} opções (recebido: ${String(opcoesDoTier.length)}).`,
      );
    }
    opcoesDoTier.forEach((opcao, j) => {
      const ondeOpcao = `${onde}.variation_option_list[${String(j)}]`;
      if (opcao.variation_option_id === undefined) {
        if (opcoes.optionIdRequired) {
          throw new ShopeeConfigError(
            `${ondeOpcao}.variation_option_id é obrigatório em update_tier_variation.`,
          );
        }
      } else {
        assertIdNaoNegativo(`${ondeOpcao}.variation_option_id`, opcao.variation_option_id);
      }
    });
  });
}

/**
 * Every `update_tier_variation` bound.
 *
 * ⚠️ The duplicate-`model_id` refusal is Shopee's own
 * (`error_duplicate_modelid: The model_id is duplicate`), caught here so it costs
 * no call. The duplicate-`tier_index` one is ours, and it is the same refusal
 * {@link assertModelListParams} makes for the two CREATE containers: this list
 * is a FULL-LIST replace, so two models landing on one combination is one
 * silently taking the other's position — and Shopee's own message would name
 * neither.
 */
function assertUpdateTierVariationParams(req: ShopeeUpdateTierVariationRequest): void {
  assertIdPositivo('item_id', req.item_id);
  if (req.model_list === undefined && req.standardise_tier_variation === undefined) {
    throw new ShopeeConfigError(
      'update_tier_variation precisa de model_list ou standardise_tier_variation.',
    );
  }
  if (req.model_list !== undefined) {
    if (req.model_list.length > SHOPEE_MODEL_MAX_PER_ITEM) {
      throw new ShopeeConfigError(
        `model_list deve ter no máximo ${String(SHOPEE_MODEL_MAX_PER_ITEM)} modelos (recebido: ${String(req.model_list.length)}).`,
      );
    }
    const vistos = new Set<number>();
    const combinacoes = new Set<string>();
    req.model_list.forEach((model, posicao) => {
      const onde = `model_list[${String(posicao)}]`;
      assertIdPositivo(`${onde}.model_id`, model.model_id);
      if (vistos.has(model.model_id)) {
        throw new ShopeeConfigError(
          `${onde}.model_id repetido (${String(model.model_id)}) — a Shopee responde error_duplicate_modelid.`,
        );
      }
      vistos.add(model.model_id);
      assertTierIndex(onde, model.tier_index, req.standardise_tier_variation);
      // ⚠️ Same delimiter, same reason as `assertModelListParams`.
      const chave = model.tier_index.join('\u0000');
      if (combinacoes.has(chave)) {
        throw new ShopeeConfigError(
          `${onde}.tier_index repete uma combinação já usada (${JSON.stringify(model.tier_index)}) — esta lista SUBSTITUI a do anúncio, então dois modelos na mesma combinação é um tomando a posição do outro.`,
        );
      }
      combinacoes.add(chave);
    });
  }
  if (req.standardise_tier_variation !== undefined) {
    assertStandardiseTiers(req.standardise_tier_variation, { optionIdRequired: true });
  }
}

/** Every `update_model` bound. ⚠️ `model_sku: ''` is LEGAL — it DELETES the SKU. */
function assertUpdateModelParams(req: ShopeeUpdateModelRequest): void {
  assertIdPositivo('item_id', req.item_id);
  if (req.model.length < 1 || req.model.length > SHOPEE_MODEL_MAX_PER_ITEM) {
    throw new ShopeeConfigError(
      `model deve conter de 1 a ${String(SHOPEE_MODEL_MAX_PER_ITEM)} modelos (recebido: ${String(req.model.length)}).`,
    );
  }
  req.model.forEach((model, posicao) => {
    const onde = `model[${String(posicao)}]`;
    assertIdPositivo(`${onde}.model_id`, model.model_id);
    if (typeof model.model_sku !== 'string') {
      throw new ShopeeConfigError(
        `${onde}.model_sku deve ser uma string (recebido: ${JSON.stringify(model.model_sku)}).`,
      );
    }
    if (model.model_sku.length > SHOPEE_MODEL_SKU_MAX_LENGTH) {
      throw new ShopeeConfigError(
        `${onde}.model_sku deve ter no máximo ${String(SHOPEE_MODEL_SKU_MAX_LENGTH)} caracteres (recebido: ${String(model.model_sku.length)}).`,
      );
    }
    if (model.weight !== undefined) assertPositivoFinito(`${onde}.weight`, model.weight);
    if (model.dimension !== undefined) assertDimensao(`${onde}.dimension`, model.dimension);
    if (model.pre_order !== undefined) {
      assertIdPositivo(`${onde}.pre_order.days_to_ship`, model.pre_order.days_to_ship);
    }
  });
}

/**
 * Every `unlist_item` bound.
 *
 * ⚠️ The duplicate-`item_id` refusal: two entries for one id with opposite flags
 * are unreconcilable against a `success_list` keyed on `item_id` alone.
 */
function assertUnlistItemParams(req: ShopeeUnlistItemRequest): void {
  const quantidade = req.item_list.length;
  if (quantidade < 1 || quantidade > SHOPEE_UNLIST_MAX_ITEMS) {
    throw new ShopeeConfigError(
      `item_list deve conter de 1 a ${String(SHOPEE_UNLIST_MAX_ITEMS)} itens (recebido: ${String(quantidade)}).`,
    );
  }
  const vistos = new Set<number>();
  req.item_list.forEach((entrada, posicao) => {
    assertIdPositivo(`item_list[${String(posicao)}].item_id`, entrada.item_id);
    if (vistos.has(entrada.item_id)) {
      throw new ShopeeConfigError(
        `item_list[${String(posicao)}].item_id repetido (${String(entrada.item_id)}) — o success_list é chaveado só por item_id.`,
      );
    }
    vistos.add(entrada.item_id);
  });
}

/**
 * Every `get_item_violation_info` bound.
 *
 * ⚠️ Duplicates ALLOWED, mirroring {@link assertItemBaseInfoParams}: the caller
 * already reconciles by `item_id` and Shopee may answer fewer rows.
 */
function assertItemViolationParams(p: GetItemViolationInfoParams): void {
  const quantidade = p.itemIds.length;
  if (quantidade < 1 || quantidade > SHOPEE_ITEM_VIOLATION_MAX_IDS) {
    throw new ShopeeConfigError(
      `item_id_list deve conter de 1 a ${String(SHOPEE_ITEM_VIOLATION_MAX_IDS)} itens (recebido: ${String(quantidade)}).`,
    );
  }
  p.itemIds.forEach((itemId, posicao) => {
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      throw new ShopeeConfigError(
        `item_id_list deve ser um inteiro positivo (posição ${String(posicao)}, recebido: ${JSON.stringify(itemId)}).`,
      );
    }
  });
}

/* ---------------- the stock sync (step 12) — the bound guards ------------- */

/**
 * Every `update_stock` bound, all five checked BEFORE any fetch.
 *
 * ⚠️ Rung 3, the duplicate `model_id`: `error_param: Repeat model_id.` is on
 * this page's own error list, and BOTH result lists are keyed on `model_id`
 * ALONE — so two entries for one model come back unreconcilable even on the
 * success path. Verbatim the {@link assertUnlistItemParams} argument.
 *
 * ⚠️ Rung 4 uses {@link assertIdNaoNegativo} and NEVER
 * {@link assertIdPositivo}: `stock: 0` is legal on an update (the page's own
 * request sample prints it, and `announcement 1445` is the BR case), so a
 * positive guard here would make "take this listing out of stock" — the single
 * most common thing this whole step does — unexpressible.
 *
 * ⚠️ Rung 5, the location structure: `error_param: Can not update item with
 * different stock structure…` is STICKY per listing, and `faq 61` requires a
 * multi-warehouse write to upload EVERY `location_id` in ONE call. Whether this
 * item needs locations at all is a question only a read can answer; whether THIS
 * call is internally consistent is not, so that half is checked here.
 */
function assertUpdateStockParams(req: ShopeeUpdateStockRequest): void {
  assertIdPositivo('item_id', req.item_id);

  const quantidade = req.stock_list.length;
  if (quantidade < 1 || quantidade > SHOPEE_UPDATE_STOCK_MAX_MODELS) {
    throw new ShopeeConfigError(
      `stock_list deve conter de 1 a ${String(SHOPEE_UPDATE_STOCK_MAX_MODELS)} modelos (recebido: ${String(quantidade)}).`,
    );
  }

  const vistos = new Set<number>();
  // ⚠️ Contado sobre a chamada INTEIRA, não por entrada: a Shopee recusa um
  // corpo em que alguns `seller_stock` nomeiam o armazém e outros não.
  let comLocation = 0;
  let semLocation = 0;

  req.stock_list.forEach((entrada, posicao) => {
    const onde = `stock_list[${String(posicao)}]`;
    // ⚠️ `0` É o item sem modelos — daí o guarda NÃO-negativo também aqui.
    assertIdNaoNegativo(`${onde}.model_id`, entrada.model_id);
    if (vistos.has(entrada.model_id)) {
      throw new ShopeeConfigError(
        `${onde}.model_id repetido (${String(entrada.model_id)}) — as duas listas de resultado são chaveadas só por model_id.`,
      );
    }
    vistos.add(entrada.model_id);

    if (entrada.seller_stock.length < 1) {
      throw new ShopeeConfigError(`${onde}.seller_stock deve conter ao menos uma entrada.`);
    }
    entrada.seller_stock.forEach((estoque, indice) => {
      assertIdNaoNegativo(`${onde}.seller_stock[${String(indice)}].stock`, estoque.stock);
      if (estoque.location_id === undefined || estoque.location_id.trim() === '') {
        semLocation += 1;
      } else {
        comLocation += 1;
      }
    });
  });

  if (comLocation > 0 && semLocation > 0) {
    throw new ShopeeConfigError(
      `stock_list mistura entradas com e sem location_id (${String(comLocation)} com, ${String(semLocation)} sem) — a Shopee exige a MESMA estrutura de estoque na chamada inteira.`,
    );
  }
}

/**
 * Every `get_item_promotion` bound.
 *
 * ⚠️ Duplicates REFUSED, the NEAR-MISS against {@link assertItemBaseInfoParams}
 * and {@link assertItemViolationParams}, which both allow them: this page's own
 * error list carries `error_param: Repeat item_id.` and theirs do not.
 */
function assertItemPromotionParams(p: GetItemPromotionParams): void {
  const quantidade = p.itemIds.length;
  if (quantidade < 1 || quantidade > SHOPEE_ITEM_PROMOTION_MAX_IDS) {
    throw new ShopeeConfigError(
      `item_id_list deve conter de 1 a ${String(SHOPEE_ITEM_PROMOTION_MAX_IDS)} itens (recebido: ${String(quantidade)}).`,
    );
  }
  const vistos = new Set<number>();
  p.itemIds.forEach((itemId, posicao) => {
    assertIdPositivo(`item_id_list[${String(posicao)}]`, itemId);
    if (vistos.has(itemId)) {
      throw new ShopeeConfigError(
        `item_id_list[${String(posicao)}] repetido (${String(itemId)}) — esta página recusa ids repetidos (error_param: Repeat item_id.).`,
      );
    }
    vistos.add(itemId);
  });
}

/* ---------------- the price sync (step 13) — the bound guards ------------- */

/**
 * Every `update_price` bound, all six checked BEFORE any fetch.
 *
 * ⚠️ Rung 3 uses {@link assertIdNaoNegativo} and NEVER {@link assertIdPositivo}
 * on `model_id`: `0` IS the no-model item. And a duplicate is REFUSED —
 * `error_param: Repeat model_id.` is on this page's own list, and BOTH result
 * lists are keyed on `model_id` alone, so two entries for one model come back
 * unreconcilable even on the success path ({@link assertUpdateStockParams}'
 * argument, verbatim).
 *
 * ⚠️ Rung 5, two decimals: the page says BR and SG sellers "can set the price
 * with two decimal place", and nothing documents what a third does (refused,
 * truncated or rounded — UNVERIFIED). So a third decimal never reaches the wire,
 * and it is REFUSED rather than rounded: the check is `roundReais(p) !== p`, the
 * ONE sanctioned money rounding, so a price the app rounded is by construction a
 * price this guard accepts — and the package never picks a price the caller did
 * not.
 *
 * ⚠️ Rung 6, structure: a `model_id: 0` entry must be ALONE. `0` says "this item
 * has no models"; a `0` beside a real id is a caller bug that Shopee would
 * answer with one of two OPPOSITE errors (the has-model mirror, or `Wrong
 * model_id.`), neither of which names the real mistake.
 */
function assertUpdatePriceParams(req: ShopeeUpdatePriceRequest): void {
  assertIdPositivo('item_id', req.item_id);

  const quantidade = req.price_list.length;
  if (quantidade < 1 || quantidade > SHOPEE_UPDATE_PRICE_MAX_MODELS) {
    throw new ShopeeConfigError(
      `price_list deve conter de 1 a ${String(SHOPEE_UPDATE_PRICE_MAX_MODELS)} modelos (recebido: ${String(quantidade)}).`,
    );
  }

  const vistos = new Set<number>();
  req.price_list.forEach((entrada, posicao) => {
    const onde = `price_list[${String(posicao)}]`;
    // ⚠️ `0` É o item sem modelos — daí o guarda NÃO-negativo.
    assertIdNaoNegativo(`${onde}.model_id`, entrada.model_id);
    if (vistos.has(entrada.model_id)) {
      throw new ShopeeConfigError(
        `${onde}.model_id repetido (${String(entrada.model_id)}) — as duas listas de resultado são chaveadas só por model_id.`,
      );
    }
    vistos.add(entrada.model_id);

    assertPositivoFinito(`${onde}.original_price`, entrada.original_price);
    if (roundReais(entrada.original_price) !== entrada.original_price) {
      throw new ShopeeConfigError(
        `${onde}.original_price deve ter no máximo duas casas decimais (recebido: ${JSON.stringify(entrada.original_price)}) — o arredondamento é de quem chama, nunca do pacote.`,
      );
    }
  });

  if (quantidade > 1 && vistos.has(0)) {
    throw new ShopeeConfigError(
      `price_list mistura model_id 0 (o item SEM modelos) com ${String(quantidade - 1)} outro(s) modelo(s) — o 0 só pode vir sozinho.`,
    );
  }
}

/**
 * Every `upload_image` bound, checked BEFORE any fetch — including the one the
 * signing switch owes.
 *
 * ⚠️ `signing: 'shop'` with no `shopAuth` cannot be expressed on the wire: the
 * call would go out Public-signed and Shopee would answer `error_param: There is
 * no access_token in query.` — the very message the flip exists to read, arriving
 * for the wrong reason.
 */
function assertUploadImageParams(p: UploadImageParams, signing: ShopeeUploadImageSigning): void {
  if (signing === 'shop' && p.shopAuth === undefined) {
    throw new ShopeeConfigError(
      'upload_image com signing "shop" exige shopAuth (access token + shop id) — veja SHOPEE_UPLOAD_IMAGE_SIGNING.',
    );
  }
  assertTextoNaoVazio('filename', p.filename);
  const tamanho = p.bytes.byteLength;
  if (tamanho < 1 || tamanho > SHOPEE_UPLOAD_IMAGE_MAX_BYTES) {
    throw new ShopeeConfigError(
      `a imagem deve ter de 1 a ${String(SHOPEE_UPLOAD_IMAGE_MAX_BYTES)} bytes (recebido: ${String(tamanho)}).`,
    );
  }
  const tipo = p.contentType.trim().toLowerCase();
  const aceitos: readonly string[] = SHOPEE_UPLOAD_IMAGE_CONTENT_TYPES;
  if (!aceitos.includes(tipo)) {
    throw new ShopeeConfigError(
      `content-type ${JSON.stringify(p.contentType)} não é aceito pela Shopee (aceitos: ${aceitos.join(', ')}).`,
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

    uploadImage: async (p) => {
      const signing = p.signing ?? SHOPEE_UPLOAD_IMAGE_SIGNING;
      assertUploadImageParams(p, signing);
      // ⚠️ ONE literal decides the base string AND the query: `public` sends
      // partner_id + timestamp + sign, `shop` adds access_token + shop_id — the
      // shape the legacy production exporter used. See
      // SHOPEE_UPLOAD_IMAGE_SIGNING for why the default is `public` anyway.
      const call: SignedCall =
        signing === 'shop' && p.shopAuth !== undefined
          ? { class: 'shop', accessToken: p.shopAuth.accessToken, shopId: p.shopAuth.shopId }
          : { class: 'public' };
      // ⚠️ The WHOLE envelope — a write's `warning` is a partial-failure channel.
      return shopeeCall(transport, {
        method: 'POST',
        path: SHOPEE_UPLOAD_IMAGE_PATH,
        call,
        schema: shopeeUploadImageSchema,
        surface: SHOPEE_SURFACE.business,
        // ⚠️ No `Content-Type` anywhere: `fetch` writes it WITH the boundary from
        // the FormData. `sensitive` stays unset — an image is not a credential.
        multipart: {
          file: {
            field: SHOPEE_UPLOAD_IMAGE_FIELD,
            filename: p.filename,
            contentType: p.contentType,
            bytes: p.bytes,
          },
          // ⚠️ SENT rather than omitted, even though `normal` is the documented
          // default — see SHOPEE_UPLOAD_IMAGE_SCENE_PADRAO.
          fields: { scene: p.scene ?? SHOPEE_UPLOAD_IMAGE_SCENE_PADRAO },
        },
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
        // `category_id_list` while its own cURL sample sends `category_ids`.
        // ⚠️ A repeated key IS expressible since step 9 (`sign.ts`'s array
        // branch appends one entry per element) — the joined scalar stays
        // because THIS page's samples disagree about the spelling, not about the
        // shape, and because `apps/shopee` sends ONE id per call, which is valid
        // under every reading. It logs `error_param` raw, so flipping the name
        // is a single literal here if the live API disagrees.
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

    /* ------------------------------ item reads ------------------------------ */

    getItemList: async (p) => {
      assertItemListParams(p);
      const res = await shopeeCall(transport, {
        method: 'GET',
        path: SHOPEE_GET_ITEM_LIST_PATH,
        call: await signedCall(),
        schema: shopeeItemListSchema,
        surface: SHOPEE_SURFACE.business,
        query: {
          offset: p.offset,
          page_size: p.pageSize,
          // ⚠️ THE repeated key — the one parameter in this package that is not
          // a joined scalar. `signedQuery` appends one entry per element, in
          // order; the page's own words are "please upload the url like this:
          // item_status=NORMAL&item_status=BANNED". Joining these with commas is
          // documented NOWHERE.
          item_status: p.statuses,
          // `undefined` is dropped by `signedQuery`, so an unfiltered scan
          // really sends no window at all.
          update_time_from: p.updateTimeFromS,
          update_time_to: p.updateTimeToS,
        },
      });
      return res.response;
    },

    getItemBaseInfo: async (p) => {
      assertItemBaseInfoParams(p);
      const res = await shopeeCall(transport, {
        method: 'GET',
        path: SHOPEE_GET_ITEM_BASE_INFO_PATH,
        call: await signedCall(),
        schema: shopeeItemBaseInfoSchema,
        surface: SHOPEE_SURFACE.business,
        query: {
          // ⚠️ ONE joined scalar, and WHICH spelling is one literal — see
          // SHOPEE_ITEM_ID_LIST_ENCODING. This page samples three of them.
          item_id_list: encodeShopeeIdList(p.itemIds),
          // ⚠️ A literal, never a parameter. The BR fiscal block is absent
          // unless asked for, and asking costs nothing; the STRING 'true' is
          // what the wire wants, exactly like `request_order_status_pending`.
          need_tax_info: 'true',
          // ⚠️ `need_complaint_policy` is deliberately NEVER sent: that block is
          // PL-only, so for a BR shop it is body weight and nothing else.
        },
      });
      return res.response;
    },

    getModelList: async (p) => {
      assertIdPositivo('item_id', p.itemId);
      const res = await shopeeCall(transport, {
        method: 'GET',
        path: SHOPEE_GET_MODEL_LIST_PATH,
        call: await signedCall(),
        schema: shopeeModelListSchema,
        surface: SHOPEE_SURFACE.business,
        query: { item_id: p.itemId },
      });
      return res.response;
    },

    getKitItemInfo: async (p) => {
      assertIdPositivo('item_id', p.itemId);
      const res = await shopeeCall(transport, {
        method: 'GET',
        // ⚠️ Its own path. A kit is never read through the item endpoint.
        path: SHOPEE_GET_KIT_ITEM_INFO_PATH,
        call: await signedCall(),
        schema: shopeeKitItemInfoSchema,
        surface: SHOPEE_SURFACE.business,
        query: { item_id: p.itemId },
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
          // ⚠️ ONE joined scalar, commas between: the page's own request sample
          // is comma-joined. `signedQuery` CAN emit a repeated key since step 9,
          // and this parameter is deliberately not migrated to it — no page
          // documents the repeated form for `order_sn_list`.
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

    getPackageDetail: async (p) => {
      assertPackageDetailParams(p);
      const res = await shopeeCall(transport, {
        // GET — the page's own `method: 2`, and its four request samples agree.
        method: 'GET',
        path: SHOPEE_GET_PACKAGE_DETAIL_PATH,
        call: await signedCall(),
        schema: shopeePackageDetailSchema,
        surface: SHOPEE_SURFACE.business,
        // ⚠️ THIS page's own contradiction — see the constant. The tolerance is
        // per OPERATION, never global.
        emptyErrorAliases: SHOPEE_PACKAGE_DETAIL_ERROR_ALIASES,
        query: {
          // ⚠️ ONE joined scalar, commas and NO spaces: the page's own request
          // sample is comma-joined (`…OFG1156498731071468%2COFG199593509207187…`).
          // A repeated key is expressible since step 9 and this parameter is
          // deliberately not migrated to it — no page documents that form here.
          // ⚠️ TRIMMED, element by element, because that is what
          // `assertPackageDetailParams` JUDGED: it refuses on `numero.trim()`, so
          // an untrimmed join would send the very bytes every refusal had already
          // read as something else — ` OFG…937 ` passes all three checks and goes
          // out as `+OFG…937+`, a key Shopee simply does not have. The answer is
          // not an error: it is the row set for the packages it DID recognise,
          // which is one row short with no signal anywhere.
          package_number_list: p.packageNumbers.map((numero) => numero.trim()).join(','),
        },
      });
      // ONE page, no auto-paging: this op has no cursor and no `more`.
      return res.response;
    },

    /* -------------------------- the listing writes -------------------------- */

    addItem: async (body) => {
      assertAddItemParams(body);
      // ⚠️ The WHOLE envelope, not `res.response` — C9's rule for every write:
      // `warning` is where Shopee says what it accepted but ignored.
      return shopeeCall(transport, {
        method: 'POST',
        path: SHOPEE_ADD_ITEM_PATH,
        call: await signedCall(),
        schema: shopeeItemWriteSchema,
        surface: SHOPEE_SURFACE.business,
        // ⚠️ The body is the WIRE body, verbatim. It is NOT signed (`call.ts`),
        // so two different items produce the SAME `sign`; the common parameters
        // stay in the signed query for a POST exactly as for a GET.
        body,
      });
    },

    updateItem: async (body) => {
      assertUpdateItemParams(body);
      return shopeeCall(transport, {
        method: 'POST',
        path: SHOPEE_UPDATE_ITEM_PATH,
        call: await signedCall(),
        // The SAME echo schema as `add_item`, and that decision rests on a
        // passing sample PER PAGE in `types.test.ts` — never on a comment
        // claiming the two are mirrors.
        schema: shopeeItemWriteSchema,
        surface: SHOPEE_SURFACE.business,
        body,
      });
    },

    initTierVariation: async (body) => {
      assertIdPositivo('item_id', body.item_id);
      if (body.standardise_tier_variation !== undefined) {
        // ⚠️ `optionIdRequired: false` — this page's option id is OPTIONAL and
        // `update_tier_variation`'s is REQUIRED. One guard, one flag, two pages.
        assertStandardiseTiers(body.standardise_tier_variation, { optionIdRequired: false });
      }
      assertModelListParams('model', body.model, { tiers: body.standardise_tier_variation });
      return shopeeCall(transport, {
        method: 'POST',
        path: SHOPEE_INIT_TIER_VARIATION_PATH,
        call: await signedCall(),
        schema: shopeeTierWriteSchema,
        surface: SHOPEE_SURFACE.business,
        body,
      });
    },

    updateTierVariation: async (body) => {
      assertUpdateTierVariationParams(body);
      return shopeeCall(transport, {
        method: 'POST',
        path: SHOPEE_UPDATE_TIER_VARIATION_PATH,
        call: await signedCall(),
        // The BARE envelope: this page answers no `response` object at all.
        schema: shopeeWriteAckSchema,
        surface: SHOPEE_SURFACE.business,
        body,
      });
    },

    addModel: async (body) => {
      assertIdPositivo('item_id', body.item_id);
      // ⚠️ No `tiers` here: this page declares none, so the tier_index LENGTH
      // cannot be cross-checked against a declaration that is not in the body.
      assertModelListParams('model_list', body.model_list);
      return shopeeCall(transport, {
        method: 'POST',
        path: SHOPEE_ADD_MODEL_PATH,
        call: await signedCall(),
        schema: shopeeTierWriteSchema,
        surface: SHOPEE_SURFACE.business,
        body,
      });
    },

    updateModel: async (body) => {
      assertUpdateModelParams(body);
      return shopeeCall(transport, {
        method: 'POST',
        path: SHOPEE_UPDATE_MODEL_PATH,
        call: await signedCall(),
        schema: shopeeWriteAckSchema,
        surface: SHOPEE_SURFACE.business,
        body,
      });
    },

    deleteModel: async (body) => {
      assertIdPositivo('item_id', body.item_id);
      assertIdPositivo('model_id', body.model_id);
      return shopeeCall(transport, {
        method: 'POST',
        path: SHOPEE_DELETE_MODEL_PATH,
        call: await signedCall(),
        schema: shopeeWriteAckSchema,
        surface: SHOPEE_SURFACE.business,
        body,
      });
    },

    deleteItem: async (body) => {
      assertIdPositivo('item_id', body.item_id);
      return shopeeCall(transport, {
        method: 'POST',
        path: SHOPEE_DELETE_ITEM_PATH,
        call: await signedCall(),
        schema: shopeeWriteAckSchema,
        surface: SHOPEE_SURFACE.business,
        body,
      });
    },

    unlistItem: async (body) => {
      assertUnlistItemParams(body);
      return shopeeCall(transport, {
        method: 'POST',
        path: SHOPEE_UNLIST_ITEM_PATH,
        call: await signedCall(),
        schema: shopeeUnlistItemSchema,
        surface: SHOPEE_SURFACE.business,
        body,
      });
    },

    getItemViolationInfo: async (p) => {
      assertItemViolationParams(p);
      const res = await shopeeCall(transport, {
        method: 'GET',
        path: SHOPEE_GET_ITEM_VIOLATION_INFO_PATH,
        call: await signedCall(),
        schema: shopeeItemViolationInfoSchema,
        surface: SHOPEE_SURFACE.business,
        // ⚠️ The ONE operation in this package that opts into the transport's
        // absent-key tolerance, and the only place the flag may appear.
        // MEASURED on the sandbox 2026-09-17 (register 73): the SUCCESS body is
        // `{message, request_id, response: {item_list: […]}}` with NO `error`
        // key, and stage 1 refused it with `campos=["error"]`. The tolerance
        // still requires a `response` object, so a body carrying neither key
        // stays refused — see the option's docblock in `call.ts`.
        erroAusenteEhSucesso: true,
        query: {
          // ⚠️ The SAME literal `getItemBaseInfo` uses — this page samples no
          // encoding at all, and the shipped precedent is the bare comma.
          item_id_list: encodeShopeeIdList(p.itemIds),
        },
      });
      // A READ: unwrapped, like every other read in this file.
      return res.response;
    },

    getChannelList: async () => {
      const res = await shopeeCall(transport, {
        method: 'GET',
        path: SHOPEE_GET_CHANNEL_LIST_PATH,
        call: await signedCall(),
        schema: shopeeChannelListSchema,
        surface: SHOPEE_SURFACE.business,
        // ⚠️ No `query` key at all: the page's Request params section is EMPTY,
        // the `getLostPushMessages` precedent.
      });
      return res.response;
    },

    /* ---------------------- the stock sync (step 12) --------------------- */

    updateStock: async (body) => {
      assertUpdateStockParams(body);
      return shopeeCall(transport, {
        method: 'POST',
        path: SHOPEE_UPDATE_STOCK_PATH,
        call: await signedCall(),
        schema: shopeeUpdateStockSchema,
        surface: SHOPEE_SURFACE.business,
        // ⚠️ The ONE `payloadNoErro` in this package, and the only place it may
        // appear. It does NOT change the verdict — a non-empty `error` is still
        // a failure and still throws — it only stops the parsed body being
        // discarded at the throw site, because THIS page documents
        // `error_busi_update_stock_failed` as "please check failure_list" and
        // `failure_list` rides under `response`. See the flag's docblock in
        // `call.ts` for why it is neither of the other two tolerances.
        payloadNoErro: true,
        body,
      });
    },

    getItemPromotion: async (p) => {
      assertItemPromotionParams(p);
      const res = await shopeeCall(transport, {
        method: 'GET',
        path: SHOPEE_GET_ITEM_PROMOTION_PATH,
        call: await signedCall(),
        schema: shopeeItemPromotionSchema,
        surface: SHOPEE_SURFACE.business,
        query: {
          // ⚠️ The SAME literal `getItemBaseInfo` uses. This page is in fact one
          // of the two siblings that sample a BARE COMMA, which is what
          // SHOPEE_ITEM_ID_LIST_ENCODING already defaults to.
          item_id_list: encodeShopeeIdList(p.itemIds),
        },
      });
      // A READ: unwrapped, like every other read in this file.
      return res.response;
    },

    getShopHolidayMode: async () => {
      const res = await shopeeCall(transport, {
        method: 'GET',
        path: SHOPEE_GET_SHOP_HOLIDAY_MODE_PATH,
        call: await signedCall(),
        schema: shopeeShopHolidayModeSchema,
        surface: SHOPEE_SURFACE.business,
        // ⚠️ The SECOND of the two absent-key tolerances in this file (the
        // first is `getItemViolationInfo`, register 73). MEASURED on the
        // sandbox 2026-09-21 (step 12's probe, P2): the SUCCESS body is
        // `{request_id, response: {holiday_mode_on, …}}` with NO `error` and NO
        // `message` key, and stage 1 refused it with `campos=["error"]` on every
        // read — which would have turned the conta gate `loja-em-ferias` and the
        // sender's holiday arm into a permanent read failure. The tolerance
        // still requires a `response` object, so a body carrying neither key
        // stays refused — see the option's docblock in `call.ts`.
        erroAusenteEhSucesso: true,
        // ⚠️ No `query` key at all: the page's Request params section is EMPTY,
        // the `getChannelList` precedent.
      });
      // ⚠️ WRAPPED, against the step-12 seam's own sketch: the page's
      // `response_params` declares `response` as an OBJECT carrying the seven
      // fields, and its response sample nests them under it. A flat reading
      // would have answered `undefined` for every one of them.
      return res.response;
    },

    getWarehouseDetail: async (p) => {
      let res;
      try {
        res = await shopeeCall(transport, {
          method: 'GET',
          path: SHOPEE_GET_WAREHOUSE_DETAIL_PATH,
          call: await signedCall(),
          schema: shopeeWarehouseDetailSchema,
          surface: SHOPEE_SURFACE.business,
          query: {
            // ⚠️ `undefined` emits NO key — `signedQuery` drops it — which is
            // exactly what "let the page apply its own default of 1" means.
            warehouse_type: p?.warehouseType,
          },
        });
      } catch (err: unknown) {
        // ⚠️ Rule 6 narrow: ONLY a ShopeeApiError, and only the two codes the
        // page itself documents as an ordinary shop's answer. Anything else —
        // a throttle, a dead authorization, a schema failure, a network error —
        // is rethrown untouched, because folding those would report "no
        // multi-warehouse regime" for a call that never got an answer.
        if (!(err instanceof ShopeeApiError)) throw err;
        // ⚠️ A DOBRA, e o que ela iguala: o PREFIXO DE MÓDULO, dos dois lados.
        // A Shopee imprime `warehouse.error_not_in_whitelist` e
        // `error_not_in_whitelist` para o mesmo fato, então normalizar só o
        // código que chegou não bastaria — a lista é escrita com prefixo.
        // O que continua DISTINTO é todo o resto do sufixo: um
        // `warehouse.error_param` do mesmo módulo, um `error_server`, um
        // throttle. Nada aqui compara por "começa com" nem por substring.
        const semPrefixo = (code: string): string => shopeeCodeSemPrefixoDeModulo(code) ?? code;
        const alvo = semPrefixo(err.code);
        if (!SHOPEE_WAREHOUSE_SEM_ACESSO.some((code) => semPrefixo(code) === alvo)) throw err;
        // ⚠️ O código VERBATIM, não o normalizado: quem lê o log precisa ver a
        // grafia que a Shopee mandou de fato.
        return { kind: 'sem-multi-armazem', code: err.code };
      }

      const armazens = res.response;
      // ⚠️ An error-free EMPTY array is the same instruction to the sender as
      // the whitelist refusal — there is no location to name — and the empty
      // `code` is what keeps the two distinguishable in a log.
      return armazens.length === 0
        ? { kind: 'sem-multi-armazem', code: '' }
        : { kind: 'lista', armazens };
    },

    /* ---------------------- the price sync (step 13) --------------------- */

    updatePrice: async (body) => {
      assertUpdatePriceParams(body);
      // ⚠️ A WRITE: the whole envelope comes back, and neither transport
      // tolerance rides here — a non-empty `error` throws the ordinary class,
      // and a partial refusal is the 200's `failure_list`. See the path's
      // docblock for why this is not the stock twin's shape.
      return shopeeCall(transport, {
        method: 'POST',
        path: SHOPEE_UPDATE_PRICE_PATH,
        call: await signedCall(),
        schema: shopeeUpdatePriceSchema,
        surface: SHOPEE_SURFACE.business,
        body,
      });
    },
  };
}
