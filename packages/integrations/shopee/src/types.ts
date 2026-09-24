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
 * ⚠️ **The `error === ''` invariant has exactly TWO exceptions, and BOTH are
 * per-operation and live in the TRANSPORT, never here.** The first is the VALUE:
 * three pages CONTRADICT THEMSELVES — the two on the lost-push queue and
 * `v2.order.get_package_detail`: their parameter tables sample `error` as `""`
 * ("Empty if no error happened") while their rendered response samples print
 * `"-"` for `error`, `message` AND `warning`. Other cached pages —
 * `get_app_push_config` and `get_order_detail` included — sample `""`. So `-` is
 * a doc-authoring placeholder on those pages, not a protocol variant, and it is
 * tolerated ONLY on those three operations, through
 * `ShopeeCallParams.emptyErrorAliases` in `call.ts` — three call sites over TWO
 * constants, the lost-push pair sharing one and `get_package_detail` carrying
 * its own. The second is the KEY: `get_item_violation_info`'s success body omits
 * `error` entirely (MEASURED 2026-09-17 — see
 * {@link shopeeItemViolationInfoPayloadSchema}), and
 * `ShopeeCallParams.erroAusenteEhSucesso` reads an absent key as `''` for that
 * ONE operation, and only when the body carries a `response` object. The schemas
 * here are unchanged by either: `error` is still `z.string()` with no default,
 * `'-'` still parses as the string `'-'`, and a body without the key still
 * fails.
 *
 * ## Flat vs wrapped vs data
 *
 * Shopee is not consistent about where the payload lives. The auth endpoints,
 * `get_shop_info` and `get_shops_by_partner` put their fields **flat** beside the
 * envelope; `get_profile` and most business APIs nest them under `response`; and
 * `get_variations` nests its payload under **`data`** instead.
 * {@link flatOp}, {@link wrappedOp} and {@link dataOp} are the three shapes,
 * composed per operation — the operation schema alone decides which, so there is
 * no second source of truth (a "mode" flag on the client) that could disagree
 * with it.
 *
 * ⚠️ `get_item_limit` matches none of the three: it renders `gtin_limit` as a
 * SIBLING of `response`. It composes {@link shopeeItemLimitSchema} by hand for
 * that reason, and its reader receives both positions.
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

import { wireInt, wireNumber } from '@delfrance/core/wire';

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

/**
 * An operation whose payload is nested under `data`.
 *
 * ⚠️ The third wrapper, and it exists for exactly one operation today
 * (`get_variations`). It is NOT interchangeable with {@link wrappedOp}: a body
 * under `data` fails a `response` schema and vice versa, which a near-miss pair
 * pins — the whole point of letting the operation schema decide the shape.
 */
export function dataOp<S extends z.ZodType>(inner: S) {
  return z.object({ ...envelopeShape, data: inner }).passthrough();
}

/* -------------------------------------------------------------------------- */
/*                        Ids that must never be numbers                      */
/* -------------------------------------------------------------------------- */

/** The preprocess step of {@link shopeeIdOpaco} — a JSON number becomes its digits. */
function paraIdOpaco(v: unknown): unknown {
  return typeof v === 'number' ? String(v) : v;
}

/**
 * A provider id that must never become a JS number, read as a STRING.
 *
 * ⚠️ NOT `wireInt()`, and the difference is a whole page rather than one field.
 * `wireInt()` is `z.preprocess(toNumberish, z.number().int())`
 * (`packages/core/src/wire/index.ts`), and Zod 4's `.int()` answers `too_big`
 * above `Number.MAX_SAFE_INTEGER` — so a uint64 id declared `wireInt()` does not
 * lose precision quietly, it FAILS the parse of the body that carries it.
 * `promotion_id` became a uint64 on 2026-07-31 and rides three pages this
 * package reads ({@link shopeeModelSchema}, {@link shopeePromocaoDeItemSchema}
 * and {@link shopeeOrderItemSchema}), so all three would go down on the first
 * big id Shopee mints.
 *
 * ⚠️ It cannot REPAIR a big number: by the time the preprocess runs, `JSON.parse`
 * has already rounded it. `String(9007199254740993)` is `'9007199254740992'`, a
 * plausible id that is not the one Shopee sent. That is what
 * {@link idOpacoExato} is for — the value still parses (one field never costs a
 * page) and a caller that stores or compares one can ask whether it is exact.
 *
 * The `.nullable().default(null)` sits OUTSIDE the preprocess, which is the
 * `wireInt().nullable().default(null)` idiom the rest of this module uses: an
 * absent key reads as `null` without the effect ever running.
 */
export function shopeeIdOpaco() {
  return z.preprocess(paraIdOpaco, z.string()).nullable().default(null);
}

/**
 * `true` when an opaque id arrived in a form that survived `JSON.parse` exactly:
 * a string (Shopee quoted it), or a number inside the safe range.
 *
 * `false` means a NUMERIC id above `Number.MAX_SAFE_INTEGER` arrived and is
 * already rounded — the digits {@link shopeeIdOpaco} produced are not the id.
 * Diagnostics only: nothing that reads one of the three pages stores its
 * `promotion_id`.
 */
export function idOpacoExato(bruto: unknown): boolean {
  return typeof bruto !== 'number' || Number.isSafeInteger(bruto);
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

/**
 * `GET /api/v2/shop/get_shop_info` — FLAT (no `response` wrapper).
 *
 * ⚠️ The four last fields are the SHOP-level gates of the stock sync (step 12),
 * all four confirmed on the page's own Response params (read 2026-09-21). They
 * are `.nullable().default(null)` because the page returns three of them only
 * for the shop kinds they describe: `mart_outlet_structure_type` is documented
 * "(Only returned when requesting a Mart or Outlet Shop)", and the shop sample
 * prints neither it nor `is_mart_shop`/`is_outlet_shop`. A gate that reads
 * `null` must therefore mean "not stated", never "false".
 */
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
  /** "whether this merchant is upgraded to CBSC, including CNSC and KRSC." */
  is_upgraded_cbsc: z.boolean().nullable().default(null),
  /** "Indicates whether the current shop is a Mart Shop." */
  is_mart_shop: z.boolean().nullable().default(null),
  /** "Indicates whether the current shop is an Outlet Shop." */
  is_outlet_shop: z.boolean().nullable().default(null),
  /**
   * `normal_mart_shop` | `warehouse_mart_shop` | `normal_outlet_shop` |
   * `warehouse_outlet_shop` — LOOSE for {@link shopeeItemListRowSchema}'s
   * reason: an unknown value must cost one gate decision, never the shop read
   * that every conta screen depends on.
   */
  mart_outlet_structure_type: z.string().nullable().default(null),
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

/* -------------------------------------------------------------------------- */
/*                        The taxonomy endpoints (step 10)                    */
/* -------------------------------------------------------------------------- */

/**
 * A `{min, max}` band, in BOTH spellings Shopee uses for it.
 *
 * The limit pages spell every band `{min_limit, max_limit}`; the guide and some
 * neighbouring APIs spell the same idea `{min, max}`. Declaring all four keys —
 * every one nullable — means a body in either spelling parses, and the reader in
 * `apps/shopee` decides which one it found. A schema per spelling would have made
 * the wrong guess a whole-response parse failure.
 *
 * ⚠️ **Never `.nonnegative()`.** `days_to_ship_limit` carries **`-1`** to mean
 * "this category has no pre-sale" (guide 209 §4), so a non-negative bound would
 * reject a documented, meaningful value — and the meaning is carried by the
 * number itself, not by its absence.
 *
 * ⚠️ `wireNumber()`, not `wireInt()`: `price_limit` is documented FLOAT on both
 * limit pages, and one band schema serves every band.
 */
export const shopeeFaixaSchema = z
  .object({
    min_limit: wireNumber().nullable().default(null),
    max_limit: wireNumber().nullable().default(null),
    min: wireNumber().nullable().default(null),
    max: wireNumber().nullable().default(null),
  })
  .passthrough();
export type ShopeeFaixa = z.infer<typeof shopeeFaixaSchema>;

/* ------------------------------ get_category ------------------------------ */

/**
 * One row of the category tree.
 *
 * ⚠️ `has_children` is a STRICT `z.boolean()`. It is the only leaf signal Shopee
 * gives — a leaf is `has_children === false` (guide 209 §1.2) — and every write
 * step gates on it, so a `"false"` STRING must fail the parse rather than be
 * coerced. A coerced string is truthy in JS, so the cheap coercion would have
 * turned every leaf into a non-leaf; a tolerant one would invent a leaf out of a
 * value nobody verified. Both are worse than a loud failure.
 */
export const shopeeCategoriaSchema = z
  .object({
    category_id: wireInt(),
    /** `0` for a root category. A real, meaningful zero — never read it as absent. */
    parent_category_id: wireInt(),
    original_category_name: z.string().nullable().default(null),
    display_category_name: z.string().nullable().default(null),
    has_children: z.boolean(),
  })
  .passthrough();
export type ShopeeCategoria = z.infer<typeof shopeeCategoriaSchema>;

/** The inner payload of `get_category` — the whole tree, in one call, unpaged. */
export const shopeeCategoryListPayloadSchema = z
  .object({ category_list: z.array(shopeeCategoriaSchema) })
  .passthrough();
export type ShopeeCategoryList = z.infer<typeof shopeeCategoryListPayloadSchema>;

/** `GET /api/v2/product/get_category` — WRAPPED under `response`. */
export const shopeeCategoryListSchema = wrappedOp(shopeeCategoryListPayloadSchema);
export type ShopeeCategoryListResponse = z.infer<typeof shopeeCategoryListSchema>;

/* --------------------------- get_attribute_tree --------------------------- */

/** One translation row, on an attribute or on one of its values. */
export const shopeeMultiLangSchema = z
  .object({
    language: z.string().nullable().default(null),
    value: z.string().nullable().default(null),
  })
  .passthrough();
export type ShopeeMultiLang = z.infer<typeof shopeeMultiLangSchema>;

/**
 * `attribute_info` — the per-attribute editor metadata.
 *
 * ⚠️ Every enum here stays an INTEGER (`input_type` 1–5, `input_validation_type`
 * 0–4, `format_type` 1–2, `date_format_type` 0–1), exactly as this page declares
 * them. `get_recommend_attribute`'s sample carries STRING spellings of the same
 * ideas (`DROP_DOWN`, `DATE_TYPE` — the stale guide-217 vocabulary); those two
 * vocabularies must never share a schema, because a value from one is silently
 * meaningless in the other.
 */
export const shopeeAttributeInfoSchema = z
  .object({
    input_type: wireInt().nullable().default(null),
    input_validation_type: wireInt().nullable().default(null),
    format_type: wireInt().nullable().default(null),
    date_format_type: wireInt().nullable().default(null),
    attribute_unit_list: z.array(z.string()).nullable().default(null),
    max_value_count: wireInt().nullable().default(null),
    introduction: z.string().nullable().default(null),
    is_oem: z.boolean().nullable().default(null),
    /** `true` means the values come from `search_attribute_value_list` — a later step. */
    support_search_value: z.boolean().nullable().default(null),
  })
  .passthrough();
export type ShopeeAttributeInfo = z.infer<typeof shopeeAttributeInfoSchema>;

/**
 * One selectable value of an attribute.
 *
 * The tree is MUTUALLY recursive: a value carries `child_attribute_list`, whose
 * elements have the same shape as `attribute_tree`'s own rows. Shopee models
 * parent to child ONLY this way — there is no `parent_attribute_list` and no
 * `parent_brand_list` anywhere in its API.
 */
export interface ShopeeAttributeValue {
  value_id: number;
  name: string | null;
  value_unit: string | null;
  child_attribute_list: ShopeeAttribute[];
  multi_lang: ShopeeMultiLang[];
  [k: string]: unknown;
}

/** One attribute of a category, with its values and its editor metadata. */
export interface ShopeeAttribute {
  attribute_id: number;
  /** ⚠️ `mandatory`, NOT `is_mandatory` — the brand payload uses the other spelling. */
  mandatory: boolean;
  name: string | null;
  attribute_value_list: ShopeeAttributeValue[];
  attribute_info: ShopeeAttributeInfo | null;
  multi_lang: ShopeeMultiLang[];
  [k: string]: unknown;
}

/**
 * ⚠️ `z.lazy` + an explicit interface annotation on BOTH halves. Without the
 * annotation TypeScript refuses a schema that references itself through a
 * sibling; without `z.lazy` the two `const`s would read each other at module
 * evaluation time and one of them would be `undefined`.
 */
export const shopeeAtributoValorSchema: z.ZodType<ShopeeAttributeValue> = z.lazy(() =>
  z
    .object({
      /** `0` is a legal value id in Shopee's data — never read it as "absent". */
      value_id: wireInt(),
      name: z.string().nullable().default(null),
      value_unit: z.string().nullable().default(null),
      child_attribute_list: z.array(shopeeAtributoSchema).default([]),
      multi_lang: z.array(shopeeMultiLangSchema).default([]),
    })
    .passthrough(),
);

export const shopeeAtributoSchema: z.ZodType<ShopeeAttribute> = z.lazy(() =>
  z
    .object({
      attribute_id: wireInt(),
      mandatory: z.boolean(),
      name: z.string().nullable().default(null),
      attribute_value_list: z.array(shopeeAtributoValorSchema).default([]),
      attribute_info: shopeeAttributeInfoSchema.nullable().default(null),
      multi_lang: z.array(shopeeMultiLangSchema).default([]),
    })
    .passthrough(),
);

/**
 * One row of `get_attribute_tree.response.list` — one requested category.
 *
 * ⚠️ `warning` here is a PER-CATEGORY warning and has nothing to do with the
 * envelope's. The envelope's goes to the transport's `onWarning`; this one is a
 * fact about this category and belongs on the answer the caller receives.
 */
export const shopeeAttributeTreeRowSchema = z
  .object({
    category_id: wireInt(),
    warning: z.string().nullable().default(null),
    attribute_tree: z.array(shopeeAtributoSchema).default([]),
  })
  .passthrough();
export type ShopeeAttributeTreeRow = z.infer<typeof shopeeAttributeTreeRowSchema>;

/** The inner payload of `get_attribute_tree` — one row per requested category. */
export const shopeeAttributeTreePayloadSchema = z
  .object({ list: z.array(shopeeAttributeTreeRowSchema) })
  .passthrough();
export type ShopeeAttributeTree = z.infer<typeof shopeeAttributeTreePayloadSchema>;

/** `GET /api/v2/product/get_attribute_tree` — WRAPPED under `response`. */
export const shopeeAttributeTreeSchema = wrappedOp(shopeeAttributeTreePayloadSchema);
export type ShopeeAttributeTreeResponse = z.infer<typeof shopeeAttributeTreeSchema>;

/* ----------------------------- get_brand_list ----------------------------- */

/**
 * One brand of a leaf category.
 *
 * ⚠️ `brand_id: 0` is Shopee's **"No Brand"** (guide 209 §3) — a real choice an
 * operator makes, not a missing value. Anything downstream that reads this id
 * must not treat `0` as absent.
 *
 * ⚠️ `wireInt()` is not decoration here: observed ids exceed int32
 * (`2500139861`), so a 32-bit reader on the other side of this schema would
 * truncate one.
 */
export const shopeeMarcaSchema = z
  .object({
    brand_id: wireInt(),
    original_brand_name: z.string(),
    display_brand_name: z.string().nullable().default(null),
  })
  .passthrough();
export type ShopeeMarca = z.infer<typeof shopeeMarcaSchema>;

/**
 * The inner payload of `get_brand_list` — ONE page.
 *
 * ⚠️ `input_type` is `z.string()`, deliberately loose: the page's parameter table
 * says `DROP_DOWN` and its own sample says `TEXT_FILED` (Shopee's typo included).
 * A page that contradicts itself is not a page to build a strict enum from, and
 * nothing in this repo branches on the value.
 */
export const shopeeBrandListPayloadSchema = z
  .object({
    brand_list: z.array(shopeeMarcaSchema),
    has_next_page: z.boolean(),
    /** Feed this back as the next call's `offset`; it is NOT `offset + page_size`. */
    next_offset: wireInt().nullable().default(null),
    /** ⚠️ `is_mandatory` here, `mandatory` on an attribute. Both spellings are real. */
    is_mandatory: z.boolean().nullable().default(null),
    input_type: z.string().nullable().default(null),
  })
  .passthrough();
export type ShopeeBrandList = z.infer<typeof shopeeBrandListPayloadSchema>;

/** `GET /api/v2/product/get_brand_list` — WRAPPED under `response`. */
export const shopeeBrandListSchema = wrappedOp(shopeeBrandListPayloadSchema);
export type ShopeeBrandListResponse = z.infer<typeof shopeeBrandListSchema>;

/* ------------------------------ get_item_limit ---------------------------- */

/** Whether a GTIN is mandatory, flexible or optional for this shop or category. */
export const shopeeGtinLimitSchema = z
  .object({ gtin_validation_rule: z.string().nullable().default(null) })
  .passthrough();
export type ShopeeGtinLimit = z.infer<typeof shopeeGtinLimitSchema>;

/** `weight_limit` — declared identically on the item and the kit page. */
export const shopeeWeightLimitSchema = z
  .object({ weight_mandatory: z.boolean().nullable().default(null) })
  .passthrough();
export type ShopeeWeightLimit = z.infer<typeof shopeeWeightLimitSchema>;

/** `dimension_limit` — declared identically on the item and the kit page. */
export const shopeeDimensionLimitSchema = z
  .object({ dimension_mandatory: z.boolean().nullable().default(null) })
  .passthrough();
export type ShopeeDimensionLimit = z.infer<typeof shopeeDimensionLimitSchema>;

/** `size_chart_limit` — on the ITEM page only. Step 18 probes it. */
export const shopeeSizeChartLimitSchema = z
  .object({
    size_chart_mandatory: z.boolean().nullable().default(null),
    support_image_size_chart: z.boolean().nullable().default(null),
    support_template_size_chart: z.boolean().nullable().default(null),
  })
  .passthrough();
export type ShopeeSizeChartLimit = z.infer<typeof shopeeSizeChartLimitSchema>;

/**
 * `extended_description_limit` — the ITEM page's shape.
 *
 * ⚠️ Only `width_min` and `height_min` exist; there is no `_max` for either, and
 * the two aspect-ratio bounds are FLOATS.
 */
export const shopeeItemExtendedDescriptionLimitSchema = z
  .object({
    description_text_length_min: wireInt().nullable().default(null),
    description_text_length_max: wireInt().nullable().default(null),
    description_image_num_min: wireInt().nullable().default(null),
    description_image_num_max: wireInt().nullable().default(null),
    description_image_width_min: wireInt().nullable().default(null),
    description_image_height_min: wireInt().nullable().default(null),
    description_image_aspect_ratio_min: wireNumber().nullable().default(null),
    description_image_aspect_ratio_max: wireNumber().nullable().default(null),
  })
  .passthrough();
export type ShopeeItemExtendedDescriptionLimit = z.infer<
  typeof shopeeItemExtendedDescriptionLimitSchema
>;

/**
 * `dts_limit` — the ITEM page's shape. No `support_pre_order` here; the KIT page
 * is the one that declares it.
 */
export const shopeeItemDtsLimitSchema = z
  .object({
    days_to_ship_limit: shopeeFaixaSchema.nullable().default(null),
    non_pre_order_days_to_ship: wireInt().nullable().default(null),
  })
  .passthrough();
export type ShopeeItemDtsLimit = z.infer<typeof shopeeItemDtsLimitSchema>;

/**
 * The inner `response` of `get_item_limit` — the per-shop / per-category bands.
 *
 * ⚠️ **Every number the page shows is a SAMPLE, not a constant.** The bands are
 * per shop and per category (guide 209 §6), which is why nothing in this repo may
 * hardcode one and why the taxonomy cache is keyed by the integração.
 *
 * ⚠️ `gtin_limit` is declared HERE **and** as a sibling of `response` on
 * {@link shopeeItemLimitSchema}: the page renders it outside `response` and ships
 * no response sample, so which position the live API uses is unsettled. Both are
 * nullable and the reader merges them; a single guessed position would have been
 * a field that is silently always `null`.
 */
export const shopeeItemLimitPayloadSchema = z
  .object({
    price_limit: shopeeFaixaSchema.nullable().default(null),
    wholesale_price_threshold_percentage: shopeeFaixaSchema.nullable().default(null),
    stock_limit: shopeeFaixaSchema.nullable().default(null),
    item_name_length_limit: shopeeFaixaSchema.nullable().default(null),
    item_image_count_limit: shopeeFaixaSchema.nullable().default(null),
    item_description_length_limit: shopeeFaixaSchema.nullable().default(null),
    tier_variation_name_length_limit: shopeeFaixaSchema.nullable().default(null),
    tier_variation_option_length_limit: shopeeFaixaSchema.nullable().default(null),
    /** Declares `max_limit` only — the band schema carries the absent halves as `null`. */
    item_count_limit: shopeeFaixaSchema.nullable().default(null),
    extended_description_limit: shopeeItemExtendedDescriptionLimitSchema.nullable().default(null),
    dts_limit: shopeeItemDtsLimitSchema.nullable().default(null),
    weight_limit: shopeeWeightLimitSchema.nullable().default(null),
    dimension_limit: shopeeDimensionLimitSchema.nullable().default(null),
    size_chart_limit: shopeeSizeChartLimitSchema.nullable().default(null),
    gtin_limit: shopeeGtinLimitSchema.nullable().default(null),
  })
  .passthrough();
export type ShopeeItemLimit = z.infer<typeof shopeeItemLimitPayloadSchema>;

/**
 * `GET /api/v2/product/get_item_limit` — WRAPPED, plus a sibling.
 *
 * ⚠️ Composed by hand rather than through {@link wrappedOp}: this is the one
 * operation whose payload does not live entirely in one place. See the note on
 * `gtin_limit` above.
 */
export const shopeeItemLimitSchema = z
  .object({
    ...envelopeShape,
    response: shopeeItemLimitPayloadSchema,
    gtin_limit: shopeeGtinLimitSchema.nullable().default(null),
  })
  .passthrough();
export type ShopeeItemLimitResponse = z.infer<typeof shopeeItemLimitSchema>;

/* ---------------------------- get_kit_item_limit -------------------------- */

/**
 * `description_limit` — the KIT page's shape, and its own.
 *
 * ⚠️ It is NOT `extended_description_limit`: the key differs and it declares two
 * fields the item page does not (`description_length_min` / `_max`). The kit
 * bands are their own numbers everywhere — reusing the item ones was checked
 * field by field and is wrong.
 */
export const shopeeKitDescriptionLimitSchema = z
  .object({
    description_length_min: wireInt().nullable().default(null),
    description_length_max: wireInt().nullable().default(null),
    description_text_length_min: wireInt().nullable().default(null),
    description_text_length_max: wireInt().nullable().default(null),
    description_image_num_min: wireInt().nullable().default(null),
    description_image_num_max: wireInt().nullable().default(null),
    description_image_width_min: wireInt().nullable().default(null),
    description_image_height_min: wireInt().nullable().default(null),
    description_image_aspect_ratio_min: wireNumber().nullable().default(null),
    description_image_aspect_ratio_max: wireNumber().nullable().default(null),
  })
  .passthrough();
export type ShopeeKitDescriptionLimit = z.infer<typeof shopeeKitDescriptionLimitSchema>;

/** `dts_limit` — the KIT page's shape. This is the one that carries `support_pre_order`. */
export const shopeeKitDtsLimitSchema = z
  .object({
    non_pre_order_days_to_ship: wireInt().nullable().default(null),
    support_pre_order: z.boolean().nullable().default(null),
    days_to_ship_limit: shopeeFaixaSchema.nullable().default(null),
  })
  .passthrough();
export type ShopeeKitDtsLimit = z.infer<typeof shopeeKitDtsLimitSchema>;

/**
 * The inner `response` of `get_kit_item_limit`.
 *
 * ⚠️ A kit's bands are NEVER derived from `get_item_limit`'s. The two pages
 * disagree on the sample numbers (name length 5/99 vs 5/100, image count 1/10 vs
 * 1/9), on the description key, on `support_pre_order`, and this page alone
 * declares `component_count_limit_of_single_model`.
 */
export const shopeeKitItemLimitPayloadSchema = z
  .object({
    price_limit: shopeeFaixaSchema.nullable().default(null),
    item_name_length_limit: shopeeFaixaSchema.nullable().default(null),
    item_image_count_limit: shopeeFaixaSchema.nullable().default(null),
    description_limit: shopeeKitDescriptionLimitSchema.nullable().default(null),
    tier_variation_name_length_limit: shopeeFaixaSchema.nullable().default(null),
    tier_variation_option_length_limit: shopeeFaixaSchema.nullable().default(null),
    weight_limit: shopeeWeightLimitSchema.nullable().default(null),
    dimension_limit: shopeeDimensionLimitSchema.nullable().default(null),
    dts_limit: shopeeKitDtsLimitSchema.nullable().default(null),
    /** How many component items one kit model may hold. */
    component_count_limit_of_single_model: shopeeFaixaSchema.nullable().default(null),
  })
  .passthrough();
export type ShopeeKitItemLimit = z.infer<typeof shopeeKitItemLimitPayloadSchema>;

/** `GET /api/v2/product/get_kit_item_limit` — WRAPPED under `response`. */
export const shopeeKitItemLimitSchema = wrappedOp(shopeeKitItemLimitPayloadSchema);
export type ShopeeKitItemLimitResponse = z.infer<typeof shopeeKitItemLimitSchema>;

/* ------------------------------ get_variations ---------------------------- */

/**
 * One standardised option — the third level of the variation tree.
 *
 * ⚠️ `variation_option_id: 0` is undocumented and observed to mean a CUSTOM
 * option. It is a value, not an absence.
 */
export const shopeeVariationOptionSchema = z
  .object({
    variation_option_id: wireInt(),
    variation_option_name: z.string().nullable().default(null),
  })
  .passthrough();
export type ShopeeVariationOption = z.infer<typeof shopeeVariationOptionSchema>;

/** One group — the second level, which divides a variation's options. */
export const shopeeVariationGroupSchema = z
  .object({
    variation_group_id: wireInt(),
    variation_group_name: z.string().nullable().default(null),
    variation_option_list: z.array(shopeeVariationOptionSchema).default([]),
  })
  .passthrough();
export type ShopeeVariationGroup = z.infer<typeof shopeeVariationGroupSchema>;

/** One standardised variation — the top level (Cor, Tamanho, …). */
export const shopeeVariationSchema = z
  .object({
    /** 15-digit ids are routine here — `wireInt()` reads them quoted or bare. */
    variation_id: wireInt(),
    variation_name: z.string().nullable().default(null),
    variation_group_list: z.array(shopeeVariationGroupSchema).default([]),
  })
  .passthrough();
export type ShopeeVariation = z.infer<typeof shopeeVariationSchema>;

/** The inner payload of `get_variations` — nested under `data`, not `response`. */
export const shopeeVariationsPayloadSchema = z
  .object({ standardise_variation_list: z.array(shopeeVariationSchema) })
  .passthrough();
export type ShopeeVariations = z.infer<typeof shopeeVariationsPayloadSchema>;

/**
 * `GET /api/v2/product/get_variations` — the only `data`-wrapped operation.
 *
 * ⚠️ Its success sample carries `warning: "success"`. That is noise, not a
 * partial failure, and filtering it is the app's job — the transport hands every
 * `warning` to `onWarning` unchanged.
 */
export const shopeeVariationsSchema = dataOp(shopeeVariationsPayloadSchema);
export type ShopeeVariationsResponse = z.infer<typeof shopeeVariationsSchema>;

/* --------------------------- category_recommend --------------------------- */

/**
 * The inner payload of `category_recommend`.
 *
 * ⚠️ `category_id` is an ARRAY despite the singular name. Whether it is a ranked
 * list of candidates or a root-to-leaf path is undocumented; nothing here
 * decides, and the reader surfaces the position each id arrived in.
 */
export const shopeeCategoryRecommendPayloadSchema = z
  .object({ category_id: z.array(wireInt()) })
  .passthrough();
export type ShopeeCategoryRecommend = z.infer<typeof shopeeCategoryRecommendPayloadSchema>;

/** `GET /api/v2/product/category_recommend` — WRAPPED under `response`. */
export const shopeeCategoryRecommendSchema = wrappedOp(shopeeCategoryRecommendPayloadSchema);
export type ShopeeCategoryRecommendResponse = z.infer<typeof shopeeCategoryRecommendSchema>;

/* -------------------------------------------------------------------------- */
/*                          The push endpoints (step 4)                       */
/* -------------------------------------------------------------------------- */

/**
 * One entry of `get_lost_push_message.response.push_message_list`.
 *
 * ⚠️ `data` is a STRING carrying the whole ORIGINAL push envelope re-nested
 * (`{data, shop_id, code, timestamp}`). This package never `JSON.parse`s it:
 * that is the app's receiver-shaped concern, and its failure has to become a
 * durable row — which this package holds no store for.
 *
 * ⚠️ `timestamp` is "the message WAS LOST", not the event clock, so it is never
 * a watermark. SECONDS.
 *
 * ⚠️ `shop_id` is ABSENT for a partner-level push ("such as code: 1, 2, 12" —
 * the page's own "such as" makes that list non-exhaustive, so nothing may derive
 * partner-level-ness from a code).
 *
 * ⚠️ **Every field is per-field tolerant, and that is the whole point** — the
 * `mlMissedFeedSchema` reasoning one channel over, which applies harder here.
 * A Zod array fails ENTIRELY when one element fails (#1488), and this queue is
 * paged by ACKNOWLEDGEMENT: one malformed entry under a strict element would
 * reject the whole page, so the 99 readable entries behind it — and everything
 * queued after them — would be unreachable until the 3-day window expired them.
 * This feed IS the recovery path; a strict field here blocks every OTHER push's
 * recovery because of one bad neighbour.
 *
 * ⚠️ `data`'s catch STRINGIFIES rather than dropping: the "whole envelope as a
 * string" shape is evidenced by the sample only, so a page that ever answers
 * the envelope OBJECT itself hands the app the same bytes it would have parsed
 * instead of an unreadable row. Nothing is ever discarded — a value that is
 * neither becomes its own JSON text and the app's reader parks it with the
 * bytes intact.
 */
export const shopeeLostPushEntrySchema = z
  .object({
    shop_id: wireInt().nullable().default(null),
    code: wireInt().nullable().catch(null),
    timestamp: wireInt().nullable().catch(null),
    data: z.string().catch((ctx) => JSON.stringify(ctx.value) ?? 'null'),
  })
  .passthrough();
export type ShopeeLostPushEntry = z.infer<typeof shopeeLostPushEntrySchema>;

/**
 * The inner payload of `get_lost_push_message` — ONE page, "the earliest 100
 * lost within 3 days and not confirmed".
 *
 * ⚠️ `push_message_list` is `.nullable().default(null)` and NOT a bare required
 * array: an EMPTY queue is the overwhelmingly common case and no sample shows
 * what Shopee sends for it. A required array would turn the healthy state into a
 * `ShopeeSchemaError` every two hours.
 *
 * ⚠️ `last_message_id` is "the end entry of data returned in the current call" —
 * the watermark the caller confirms. It is never synthesized.
 */
export const shopeeLostPushPayloadSchema = z
  .object({
    push_message_list: z.array(shopeeLostPushEntrySchema).nullable().default(null),
    has_next_page: z.boolean(),
    last_message_id: wireInt(),
  })
  .passthrough();
export type ShopeeLostPush = z.infer<typeof shopeeLostPushPayloadSchema>;

/** `GET /api/v2/push/get_lost_push_message` — WRAPPED under `response`. */
export const shopeeLostPushSchema = wrappedOp(shopeeLostPushPayloadSchema);
/**
 * The WHOLE parsed operation — envelope fields (`error` / `message` / `warning`
 * / `request_id`) **and** the `response` payload.
 *
 * ⚠️ This is the one operation whose client method hands back the envelope
 * rather than `res.response`, and the reason is D1: this page is where Shopee
 * answers `"error": "-"` where every other page answers `""`, so the sweep logs
 * the GETTER's `error` VERBATIM to settle the contradiction with live traffic.
 * Unwrapping here would have put that answer out of the caller's reach — see
 * {@link ShopeeLostPush} for the inner payload alone.
 */
export type ShopeeLostPushResponse = z.infer<typeof shopeeLostPushSchema>;

/**
 * `POST /api/v2/push/confirm_consumed_lost_push_message` — the response is the
 * BARE envelope, with no `response` object at all.
 *
 * ⚠️ `flatOp({})` rather than reusing {@link shopeeEnvelopeSchema}: that one is
 * the TRANSPORT's stage-1 schema and must not become an operation's, or a change
 * to stage 1 would silently redefine this operation's contract.
 */
export const shopeeConfirmLostPushSchema = flatOp({});
export type ShopeeConfirmLostPush = z.infer<typeof shopeeConfirmLostPushSchema>;

/**
 * The inner payload of `get_app_push_config` — the app-wide push configuration
 * and its live health.
 *
 * ⚠️ `live_push_status` is `z.string()`, NOT an enum, and the trade is the
 * opposite of {@link shopeeShopStatusSchema}'s. There a strict enum is right
 * because a wrong read says "connected" about a BANNED shop. Here the page
 * contradicts itself on casing — its description says `Normal/Warning/Suspended`
 * and its own sample says `"suspended"` — and an enum miss would throw
 * `ShopeeSchemaError`, so the monitor would learn NOTHING about a status Shopee
 * added. A tolerant string lets the reader fold the case and LOG the unknown
 * value. Same reasoning as {@link shopeeBrandListPayloadSchema}'s `input_type`.
 *
 * ⚠️ `suspended_time` is SECONDS and is returned "only when live push status is
 * suspended". It is a suspension START, never a deadline.
 *
 * ⚠️ Every field is nullable: the page ships one sample and no statement about
 * which fields are always present, and this whole payload is a diagnostic — a
 * missing list must read as "Shopee said nothing", never as "the list is empty".
 * `blocked_shop_id` is `int[]` HERE and `blocked_shop_id_list` on the setter;
 * the two never share a type.
 */
export const shopeeAppPushConfigPayloadSchema = z
  .object({
    callback_url: z.string().nullable().default(null),
    live_push_status: z.string().nullable().default(null),
    suspended_time: wireInt().nullable().default(null),
    blocked_shop_id: z.array(wireInt()).nullable().default(null),
    push_config_on_list: z.array(wireInt()).nullable().default(null),
    push_config_off_list: z.array(wireInt()).nullable().default(null),
  })
  .passthrough();
export type ShopeeAppPushConfig = z.infer<typeof shopeeAppPushConfigPayloadSchema>;

/** `GET /api/v2/push/get_app_push_config` — WRAPPED under `response`. */
export const shopeeAppPushConfigSchema = wrappedOp(shopeeAppPushConfigPayloadSchema);
export type ShopeeAppPushConfigResponse = z.infer<typeof shopeeAppPushConfigSchema>;

/* -------------------------------------------------------------------------- */
/*                        The order endpoints (step 4/5)                      */
/* -------------------------------------------------------------------------- */

/**
 * One row of `get_order_list.response.order_list`.
 *
 * ⚠️ `order_sn` is `.min(1)`: a blank one FAILS the whole page, loudly. It is
 * the only payload this operation carries, and a blank value would collapse
 * every such row onto ONE synthesized identity downstream — a create-only doc id
 * that swallows the rest in silence.
 *
 * ⚠️ `order_status` and `booking_sn` are nullable EVEN WHEN
 * `response_optional_fields=order_status` was asked for: the page's own sample
 * answers bare `{order_sn}` rows regardless. Tolerating both shapes is the only
 * reading the page supports.
 */
export const shopeeOrderListRowSchema = z
  .object({
    order_sn: z.string().min(1),
    order_status: z.string().nullable().default(null),
    booking_sn: z.string().nullable().default(null),
  })
  .passthrough();
export type ShopeeOrderListRow = z.infer<typeof shopeeOrderListRowSchema>;

/**
 * The inner payload of `get_order_list` — ONE page.
 *
 * ⚠️ `more` is a STRICT `z.boolean()`. It is the loop's only termination signal
 * — the page's sample returns 10 rows for `page_size: 20` WITH `more: true`, so
 * a row count says nothing — and coercing a `"false"` STRING would either spin
 * the caller forever or truncate a window in silence. Same reasoning as
 * {@link shopeeCategoriaSchema}'s `has_children`.
 *
 * ⚠️ `next_cursor` is `""` when `more` is false ("the value of next_cursor will
 * be empty string when more is false"), and the cursor is OPAQUE (its format
 * changed on 2025-04-23). Nothing may synthesize one, and the drained sentinel
 * is never fed back as a resume cursor.
 */
export const shopeeOrderListPayloadSchema = z
  .object({
    more: z.boolean(),
    next_cursor: z.string().nullable().default(null),
    order_list: z.array(shopeeOrderListRowSchema),
  })
  .passthrough();
export type ShopeeOrderList = z.infer<typeof shopeeOrderListPayloadSchema>;

/** `GET /api/v2/order/get_order_list` — WRAPPED under `response`. */
export const shopeeOrderListSchema = wrappedOp(shopeeOrderListPayloadSchema);
export type ShopeeOrderListResponse = z.infer<typeof shopeeOrderListSchema>;

/* -------------------------------------------------------------------------- */
/*                  The order detail + the escrow (step 5)                    */
/* -------------------------------------------------------------------------- */

/**
 * One row of `get_order_detail.response.order_list[].item_list`.
 *
 * ⚠️ There is NO `is_kit`/`kit_items` here — those are ESCROW-only fields, and
 * only for a BR local seller. A kit line on the detail looks like any other.
 *
 * ⚠️ `model_id: 0` is a REAL value: it is what a non-variation item carries.
 * Nothing downstream may read it as "absent" (the legacy importer looked `0` up
 * as the STRING `"0"` and matched nothing, silently).
 */
export const shopeeOrderItemSchema = z
  .object({
    item_id: wireInt(),
    item_name: z.string().nullable().default(null),
    item_sku: z.string().nullable().default(null),
    model_id: wireInt().nullable().default(null),
    model_name: z.string().nullable().default(null),
    model_sku: z.string().nullable().default(null),
    model_quantity_purchased: wireInt().nullable().default(null),
    model_original_price: wireNumber().nullable().default(null),
    /**
     * ⚠️ `0` on a BUNDLE-DEAL line, by design: "as by design bundle deal discount
     * will not be breakdown to item/model level". Shopee's own page says to call
     * `get_escrow_detail` for that line's money, so a reader that takes this
     * value verbatim prices a whole bundle line at zero.
     */
    model_discounted_price: wireNumber().nullable().default(null),
    wholesale: z.boolean().nullable().default(null),
    weight: wireNumber().nullable().default(null),
    add_on_deal: z.boolean().nullable().default(null),
    main_item: z.boolean().nullable().default(null),
    add_on_deal_id: wireInt().nullable().default(null),
    /** Lossy by design: an item in several promotions shows only the top one. */
    promotion_type: z.string().nullable().default(null),
    /**
     * ⚠️ An OPAQUE STRING ({@link shopeeIdOpaco}), never a number: `uint64` since
     * 2026-07-31. Under `wireInt()`, one id above 2^53 failed Zod's `.int()` with
     * `too_big`, and that failed the WHOLE `get_order_detail` page — the order
     * import with it — over a field the import never reads. Real ids are ~15
     * digits today (below 2^53), so this is precautionary. A JSON number above
     * 2^53 still arrives already rounded ({@link idOpacoExato}). Lossy like
     * `promotion_type`: an item in several promotions shows only the top one.
     */
    promotion_id: shopeeIdOpaco(),
    order_item_id: wireInt().nullable().default(null),
    line_item_id: wireInt().nullable().default(null),
    promotion_group_id: wireInt().nullable().default(null),
    image_info: z
      .object({ image_url: z.string().nullable().default(null) })
      .passthrough()
      .nullable()
      .default(null),
    /**
     * ⚠️ STRING in the parameter table, ARRAY in the page's own sample — and the
     * SG sandbox order settled it: BOTH shapes arrive in ONE response (an array
     * here, a string on the package item below). Neither is folded into the
     * other; the reader normalises.
     */
    product_location_id: z
      .union([z.string(), z.array(z.string())])
      .nullable()
      .default(null),
    is_prescription_item: z.boolean().nullable().default(null),
    is_b2c_owned_item: z.boolean().nullable().default(null),
    promotion_list: z.array(z.unknown()).nullable().default(null),
    /** The four partial-fulfilment counters. `active` is not `purchased`. */
    active_qty: wireInt().nullable().default(null),
    cancel_requested_qty: wireInt().nullable().default(null),
    cancelled_qty: wireInt().nullable().default(null),
    return_requested_qty: wireInt().nullable().default(null),
    returned_qty: wireInt().nullable().default(null),
  })
  .passthrough();
export type ShopeeOrderItem = z.infer<typeof shopeeOrderItemSchema>;

/** One row of `package_list[].item_list` — the per-package split of the items. */
export const shopeePackageItemSchema = z
  .object({
    item_id: wireInt().nullable().default(null),
    model_id: wireInt().nullable().default(null),
    model_quantity: wireInt().nullable().default(null),
    order_item_id: wireInt().nullable().default(null),
    promotion_group_id: wireInt().nullable().default(null),
    /** ⚠️ A STRING here on the same payload where the order item sent an ARRAY. */
    product_location_id: z
      .union([z.string(), z.array(z.string())])
      .nullable()
      .default(null),
  })
  .passthrough();
export type ShopeePackageItem = z.infer<typeof shopeePackageItemSchema>;

/**
 * One row of `package_list` — one parcel of the order.
 *
 * ⚠️ **BOTH weight keys are declared and NEITHER is folded into the other.**
 * `parcel_chargeable_weight` is what the parameter table documents (an `int`
 * whose UNIT the page never states) and `parcel_chargeable_weight_gram` is what
 * the sample — and the SG sandbox order — actually sends. Declaring one key and
 * reading the other as its synonym is how the legacy wrote a gram value into a
 * kilogram field.
 */
export const shopeePackageSchema = z
  .object({
    package_number: z.string().nullable().default(null),
    logistics_status: z.string().nullable().default(null),
    logistics_channel_id: wireInt().nullable().default(null),
    shipping_carrier: z.string().nullable().default(null),
    allow_self_design_awb: z.boolean().nullable().default(null),
    item_list: z.array(shopeePackageItemSchema).nullable().default(null),
    parcel_chargeable_weight: wireNumber().nullable().default(null),
    parcel_chargeable_weight_gram: wireNumber().nullable().default(null),
    /** `0`, `null` and absent all mean "not combined" — never a truthiness read. */
    group_shipment_id: wireInt().nullable().default(null),
  })
  .passthrough();
export type ShopeePackage = z.infer<typeof shopeePackageSchema>;

/**
 * `recipient_address` — every field a nullable STRING, and nothing here judges.
 *
 * ⚠️ The coarse fields (`town`, `district`, `city`, `state`) are legitimately
 * EMPTY by region — the SG sandbox order sends four empty strings beside a clear
 * `full_address` — while a MASKED value is a partially starred non-empty string
 * (`P******n`, `******64`) or, on that same sandbox order, `"****"` in full.
 * Truthiness and length checks pass on every one of those, which is why the
 * usable-value predicate lives in `packages/schemas` and not in this schema.
 */
export const shopeeRecipientAddressSchema = z
  .object({
    name: z.string().nullable().default(null),
    phone: z.string().nullable().default(null),
    town: z.string().nullable().default(null),
    district: z.string().nullable().default(null),
    city: z.string().nullable().default(null),
    state: z.string().nullable().default(null),
    /**
     * ⚠️ The RECIPIENT region, and it is masking-gated. The estrangeiro signal is
     * the ORDER-level `region`, one of the eleven fields returned by default.
     */
    region: z.string().nullable().default(null),
    zipcode: z.string().nullable().default(null),
    full_address: z.string().nullable().default(null),
    /** Only for `logistics_channel_id` 90026. Carried, never read here. */
    geolocation: z.record(z.string(), z.unknown()).nullable().default(null),
  })
  .passthrough();
export type ShopeeRecipientAddress = z.infer<typeof shopeeRecipientAddressSchema>;

/**
 * One row of `payment_info` — BR only, added for NT 2025.001.
 *
 * Declared so a captured body records it and so step 6 can read it without a
 * package change. ⚠️ `payment_processor_register` is a **CNPJ**: it sits on the
 * fixture redaction denylist and must never reach a log line.
 */
export const shopeePaymentInfoSchema = z
  .object({
    payment_method: z.string().nullable().default(null),
    payment_processor_register: z.string().nullable().default(null),
    card_brand: z.string().nullable().default(null),
    transaction_id: z.string().nullable().default(null),
    payment_amount: wireNumber().nullable().default(null),
  })
  .passthrough();
export type ShopeePaymentInfo = z.infer<typeof shopeePaymentInfoSchema>;

/**
 * `invoice_data` — the NF-e Shopee holds for the order.
 *
 * ⚠️ **TRI-VALUED, and the three readings must stay apart:** `null` (a non-BR
 * order — what the SG sandbox order sends), `{}` (a BR order with no NF-e yet)
 * and a populated object (one exists). A `.default({})` on the row field would
 * fold the first two into each other, and a bare `z.record` would lose the
 * distinction on read.
 */
export const shopeeInvoiceDataSchema = z
  .object({
    number: z.string().nullable().default(null),
    series_number: z.string().nullable().default(null),
    /** ⚠️ The chave de acesso — fiscal PII. Redacted in every committed fixture. */
    access_key: z.string().nullable().default(null),
    issue_date: wireInt().nullable().default(null),
    total_value: wireNumber().nullable().default(null),
    products_total_value: wireNumber().nullable().default(null),
    tax_code: z.string().nullable().default(null),
    /** `valid` | `pending` — added 2026-08-06, with `pending_reason` beside it. */
    status: z.string().nullable().default(null),
    pending_reason: z.string().nullable().default(null),
  })
  .passthrough();
export type ShopeeInvoiceData = z.infer<typeof shopeeInvoiceDataSchema>;

/**
 * One row of `get_order_detail.response.order_list` — ONE order.
 *
 * ⚠️ **`order_status` is `z.string()`, never an enum**, and the trade is the same
 * one {@link shopeeAppPushConfigPayloadSchema}'s `live_push_status` takes: a
 * twelfth status Shopee invents would otherwise be a `ShopeeSchemaError` for the
 * WHOLE order, when the right answer is to import it and let the ladder mapper
 * answer "not on the ladder" with an ENUMERATED estado.
 *
 * ⚠️ `order_sn` is `.min(1)`, strict, exactly as {@link shopeeOrderListRowSchema}
 * is: it is the deterministic-id preimage, so a blank one would collapse every
 * such row onto ONE pedido document.
 *
 * ⚠️ **Shopee ZERO-FILLS absent numerics** — the SG sandbox order answered
 * `actual_shipping_fee: 0` while the buyer had paid 1.99, plus `edt_from: 0`,
 * `edt_to: 0`, `pickup_done_time: 0` and `parcel_chargeable_weight_gram: 0`. The
 * schema keeps the zeros VERBATIM; deciding that a `0` means absence is the
 * reader's job, and a `??` on any of those fields is a bug.
 *
 * ⚠️ An optional field that was not named in `response_optional_fields` comes
 * back ABSENT, not empty — see {@link SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS}.
 */
export const shopeeOrderDetailRowSchema = z
  .object({
    /* — the eleven fields Shopee returns by DEFAULT */
    order_sn: z.string().min(1),
    /** ⚠️ The ORDER-level region. Never masking-gated — this is the one to read. */
    region: z.string().nullable().default(null),
    currency: z.string().nullable().default(null),
    cod: z.boolean().nullable().default(null),
    order_status: z.string(),
    message_to_seller: z.string().nullable().default(null),
    /** Seller Centre's own note ("The note seller made for own reference") — asked for by default; it feeds `observacoesInternas`. */
    note: z.string().nullable().default(null),
    /** Seconds like every Shopee stamp; `0` (or absent) when there is no note. */
    note_update_time: wireInt().nullable().default(null),
    create_time: wireInt().nullable().default(null),
    update_time: wireInt().nullable().default(null),
    days_to_ship: wireInt().nullable().default(null),
    ship_by_date: wireInt().nullable().default(null),
    booking_sn: z.string().nullable().default(null),

    /* — the twenty-two asked for by SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS */
    item_list: z.array(shopeeOrderItemSchema).nullable().default(null),
    recipient_address: shopeeRecipientAddressSchema.nullable().default(null),
    /** "Only for Brazil order." A CPF — never logged, never in a fixture. */
    buyer_cpf_id: z.string().nullable().default(null),
    buyer_username: z.string().nullable().default(null),
    buyer_user_id: wireInt().nullable().default(null),
    /** NULL while the order is unpaid. */
    pay_time: wireInt().nullable().default(null),
    /** No closed enum exists: guide 31's BR block lists Ebanx entries only. */
    payment_method: z.string().nullable().default(null),
    payment_info: z.array(shopeePaymentInfoSchema).nullable().default(null),
    /** Only returned once the buyer has paid. */
    total_amount: wireNumber().nullable().default(null),
    package_list: z.array(shopeePackageSchema).nullable().default(null),
    invoice_data: shopeeInvoiceDataSchema.nullable().default(null),
    actual_shipping_fee: wireNumber().nullable().default(null),
    estimated_shipping_fee: wireNumber().nullable().default(null),
    shipping_carrier: z.string().nullable().default(null),
    order_chargeable_weight_gram: wireNumber().nullable().default(null),
    /** `buyer` | `seller` | `system` | `Ops` — a string, never an enum. */
    cancel_by: z.string().nullable().default(null),
    /** ⚠️ Observed samples sit OUTSIDE every documented list. */
    cancel_reason: z.string().nullable().default(null),
    buyer_cancel_reason: z.string().nullable().default(null),
    pickup_done_time: wireInt().nullable().default(null),
    fulfillment_flag: z.string().nullable().default(null),
    return_request_due_date: wireInt().nullable().default(null),

    /* — BR-only and flag-gated */
    /** BR only. `0` when unset — a zero-fill, never a 1970 date. */
    edt_from: wireInt().nullable().default(null),
    edt_to: wireInt().nullable().default(null),
    /**
     * ⚠️ `edt` is what the REQUEST asks for, but no `edt` field appears in any
     * response sample — `edt_from`/`edt_to` do. Carried as `unknown` so a reader
     * can log its TYPE once and settle it, with no schema change and no guessed
     * shape.
     */
    edt: z.unknown().nullable().default(null),
    /**
     * Returned only with `request_order_status_pending`. NOT an enum: the three
     * documented values (`SYSTEM_PENDING`, `KYC_PENDING`,
     * `ARRANGE_SHIPMENT_PENDING`) are a list Shopee grows.
     */
    pending_terms: z.array(z.string()).nullable().default(null),
    /** BR only, and only when `international_label` was requested. */
    is_international: z.boolean().nullable().default(null),
    hot_listing_order: z.boolean().nullable().default(null),
  })
  .passthrough();
export type ShopeeOrderDetailRow = z.infer<typeof shopeeOrderDetailRowSchema>;

/**
 * The inner payload of `get_order_detail` — one row per `order_sn` ASKED for.
 *
 * ⚠️ Shopee may answer with FEWER rows than were asked for (an `order_sn` that is
 * not this shop's simply does not come back), so a caller reconciles by
 * `order_sn` and never by position.
 */
export const shopeeOrderDetailPayloadSchema = z
  .object({ order_list: z.array(shopeeOrderDetailRowSchema) })
  .passthrough();
export type ShopeeOrderDetail = z.infer<typeof shopeeOrderDetailPayloadSchema>;

/** `GET /api/v2/order/get_order_detail` — WRAPPED under `response`. */
export const shopeeOrderDetailSchema = wrappedOp(shopeeOrderDetailPayloadSchema);
export type ShopeeOrderDetailResponse = z.infer<typeof shopeeOrderDetailSchema>;

/**
 * One component of a BR-local KIT line, inside `order_income.items[].kit_items`.
 *
 * ⚠️ **Every id here is `wireInt()` and must stay so**, and the reason is not the
 * usual one: `integration-response-numbers-tolerant` is LINE-based and does not
 * look inside a `z.union([...])`, which is how {@link shopeeEscrowItemSchema}
 * declares this schema. The guard reaches these lines only because the schema is
 * a named const; inlining it into that union would take them out of its sight.
 *
 * ⚠️ The page types the ids as FLOATS (its sample sends `0.1` for every one of
 * them), which is a documentation artefact rather than a wire fact — a product id
 * is an integer. `wireInt()` therefore REFUSES a real `0.1`, loudly, instead of
 * rounding an id nobody could recover.
 */
export const shopeeEscrowKitItemSchema = z
  .object({
    original_product_id: wireInt().nullable().default(null),
    original_model_id: wireInt().nullable().default(null),
    total_qty: wireInt().nullable().default(null),
    original_price: wireNumber().nullable().default(null),
    proportional_price: wireNumber().nullable().default(null),
  })
  .passthrough();
export type ShopeeEscrowKitItem = z.infer<typeof shopeeEscrowKitItemSchema>;

/**
 * One row of `order_income.items` — the per-line money.
 *
 * ⚠️ Nine escrow fields carry the sentence "It returns the subtotal of that
 * specific item if quantity exceeds 1", and `original_price`, `selling_price` and
 * `discounted_price` are three of them. Nothing here divides: the unit price is
 * the reader's job, and it must divide by THIS document's `quantity_purchased`.
 *
 * ⚠️ Money is FLOAT and negatives are legal on this page (`final_shipping_fee:
 * -10` in its own sample), so no bound is declared anywhere here.
 */
export const shopeeEscrowItemSchema = z
  .object({
    item_id: wireInt().nullable().default(null),
    item_name: z.string().nullable().default(null),
    item_sku: z.string().nullable().default(null),
    model_id: wireInt().nullable().default(null),
    model_name: z.string().nullable().default(null),
    model_sku: z.string().nullable().default(null),
    line_item_id: wireInt().nullable().default(null),
    original_price: wireNumber().nullable().default(null),
    selling_price: wireNumber().nullable().default(null),
    discounted_price: wireNumber().nullable().default(null),
    quantity_purchased: wireInt().nullable().default(null),
    seller_discount: wireNumber().nullable().default(null),
    shopee_discount: wireNumber().nullable().default(null),
    /** `0` on a bundle line — the page says so explicitly. */
    discount_from_coin: wireNumber().nullable().default(null),
    discount_from_voucher_shopee: wireNumber().nullable().default(null),
    discount_from_voucher_seller: wireNumber().nullable().default(null),
    /** `''` | `bundle_deal` | `add_on_deal` — a string, and the sample pads it. */
    activity_type: z.string().nullable().default(null),
    activity_id: wireInt().nullable().default(null),
    is_main_item: z.boolean().nullable().default(null),
    is_b2c_shop_item: z.boolean().nullable().default(null),
    ams_commission_fee: wireNumber().nullable().default(null),
    /** BR local only, so `null` means "unknown", never "false". */
    is_kit: z.boolean().nullable().default(null),
    /**
     * ⚠️ The page types this as ONE object (singular); a multi-component kit has
     * NO documented shape. Both parse and the READER normalises to an array —
     * never the other way round, because an object-only schema would reject a
     * real multi-component kit and cost the whole order its money.
     *
     * ⚠️ The response-numbers guard cannot see inside this union. See
     * {@link shopeeEscrowKitItemSchema}.
     */
    kit_items: z
      .union([shopeeEscrowKitItemSchema, z.array(shopeeEscrowKitItemSchema)])
      .nullable()
      .default(null),
    promotion_list: z.array(z.unknown()).nullable().default(null),
  })
  .passthrough();
export type ShopeeEscrowItem = z.infer<typeof shopeeEscrowItemSchema>;

/**
 * One entry of `order_income.tenure_info_list` — the instalment plan, as the
 * payment channel reported it.
 *
 * ⚠️ **THREE shapes are on record and all three parse**, which is why this exists
 * at all: the reference page types ONE object (singular) with a STRING
 * `instalment_plan`; announcement 1080 renders an ARRAY whose `instalment_plan`
 * is an INT (`1`, `3`); and the SG sandbox body is an array of ONE
 * `{ instalment_plan: "N/A" }` with no `payment_channel_name`. An object-only
 * schema rejects two of them, an array-only schema rejects the first, and a
 * strict `z.string()` rejects the announcement's ints — and each rejection costs
 * the WHOLE escrow parse, which is this order's money.
 *
 * ⚠️ `z.string()` comes FIRST in the union deliberately. `"N/A"` is a real VALUE,
 * not a missing one, and putting `wireInt()` first would hand it a string to
 * coerce. The FOLD (`"N/A"` ⇒ 1 parcela, `"3"` ⇒ 3) belongs to the ONE reader in
 * `apps/shopee`, never here: the package records what arrived.
 *
 * ⚠️ NAMED rather than inlined, for the {@link shopeeEscrowKitItemSchema} reason:
 * `integration-response-numbers-tolerant` is LINE-based and cannot see inside a
 * `z.union([...])`, so inlining these fields would take them out of its sight.
 */
export const shopeeTenureInfoSchema = z
  .object({
    payment_channel_name: z.string().nullable().default(null),
    /** `"N/A"` is a value; `1` and `3` are values. See the union order above. */
    instalment_plan: z.union([z.string(), wireInt()]).nullable().default(null),
  })
  .passthrough();
export type ShopeeTenureInfo = z.infer<typeof shopeeTenureInfoSchema>;

/**
 * `order_income` — the order-level money. `.passthrough()` still carries the
 * ~70 floats nothing reads (the SG body alone sends 88 keys).
 *
 * ⚠️ `discounted_price` AND `order_discounted_price` are both declared: the page
 * names one and the subtotal list names the other, and folding them would make
 * whichever Shopee actually sends read as `null` for ever.
 *
 * ⚠️ **The three FEE columns are `commission_fee`, `service_fee` and
 * `seller_transaction_fee`** — the exact three Shopee's own Income Report maps
 * (FAQ 479), and what the pagamento's `tarifas` is built from.
 * `credit_card_transaction_fee` is a ROLLUP the page defines as
 * `buyer_transaction_fee + seller_transaction_fee`, so summing it beside them
 * double-counts. Both are declared; neither is folded into the other.
 *
 * ⚠️ Money here is FLOAT and negatives are legal (`final_shipping_fee: -10` is
 * the page's own sample), so no bound is declared on any of these.
 */
export const shopeeOrderIncomeSchema = z
  .object({
    /** ⚠️ "will change before order is completed" — the escrow has no clock. */
    escrow_amount: wireNumber().nullable().default(null),
    buyer_total_amount: wireNumber().nullable().default(null),
    original_price: wireNumber().nullable().default(null),
    discounted_price: wireNumber().nullable().default(null),
    order_discounted_price: wireNumber().nullable().default(null),
    seller_discount: wireNumber().nullable().default(null),
    /** What the buyer was CHARGED for shipping — never a fabricated zero. */
    buyer_paid_shipping_fee: wireNumber().nullable().default(null),
    actual_shipping_fee: wireNumber().nullable().default(null),
    estimated_shipping_fee: wireNumber().nullable().default(null),
    escrow_amount_after_adjustment: wireNumber().nullable().default(null),
    /** FAQ 479 column 1. */
    commission_fee: wireNumber().nullable().default(null),
    /** FAQ 479 column 2. */
    service_fee: wireNumber().nullable().default(null),
    /** FAQ 479 column 3. */
    seller_transaction_fee: wireNumber().nullable().default(null),
    /** ⚠️ The page's own words: `= buyer_transaction_fee + seller_transaction_fee`. A ROLLUP — never summed beside its own parts. */
    credit_card_transaction_fee: wireNumber().nullable().default(null),
    buyer_transaction_fee: wireNumber().nullable().default(null),
    campaign_fee: wireNumber().nullable().default(null),
    /** BR only (announcement 1451) — ABSENT on the SG sandbox body, so `null` here means "not sent", never "zero". */
    net_commission_fee: wireNumber().nullable().default(null),
    /** BR only (announcement 1451). Same reading as `net_commission_fee`. */
    net_service_fee: wireNumber().nullable().default(null),
    /** ⚠️ NOT `buyer_payment_info.discount_pix`. Two spellings, two clocks, two values — never folded. */
    pix_discount: wireNumber().nullable().default(null),
    /** Declared for the refund step (17); step 6 records it and reads nothing from it. */
    seller_return_refund: wireNumber().nullable().default(null),
    /** Declared for the refund step (17). */
    drc_adjustable_refund: wireNumber().nullable().default(null),
    total_adjustment_amount: wireNumber().nullable().default(null),
    shipping_seller_protection_fee_amount: wireNumber().nullable().default(null),
    /** ⚠️ "could be negative or positive" — the page's own sample is `-10`. No bound. */
    final_shipping_fee: wireNumber().nullable().default(null),
    /** ⚠️ ORDER level only. The item-level twin of the same name keeps riding `.passthrough()`: it has no reader, and declaring both invites summing them twice. */
    seller_order_processing_fee: wireNumber().nullable().default(null),
    order_ams_commission_fee: wireNumber().nullable().default(null),
    escrow_tax: wireNumber().nullable().default(null),
    instalment_plan: z.string().nullable().default(null),
    buyer_payment_method: z.string().nullable().default(null),
    /** ⚠️ An ARRAY in reality and an OBJECT on the page. See {@link shopeeTenureInfoSchema}. */
    tenure_info_list: z
      .union([shopeeTenureInfoSchema, z.array(shopeeTenureInfoSchema)])
      .nullable()
      .default(null),
    items: z.array(shopeeEscrowItemSchema).nullable().default(null),
  })
  .passthrough();
export type ShopeeOrderIncome = z.infer<typeof shopeeOrderIncomeSchema>;

/**
 * `buyer_payment_info` — the checkout snapshot, and it is a DIFFERENT CLOCK from
 * `order_income`.
 *
 * ⚠️ **These are INITIAL values.** The page says they are "not updated after
 * return/refund or cancellation", while `order_income` keeps moving until the
 * order completes. So a namesake here is never folded onto its `order_income`
 * twin: `buyer_total_amount` appears in both and they may legitimately DISAGREE,
 * and reading whichever one happened to be handy would produce a figure that is
 * right on a quiet order and silently stale on a refunded one.
 *
 * ⚠️ **`discount_pix` here is NOT `order_income.pix_discount`.** Two spellings,
 * two clocks. Neither defaults from the other.
 *
 * Six fields are typed because a reader names them; the SG sandbox body carries
 * 33 keys and the rest ride `.passthrough()`.
 */
export const shopeeBuyerPaymentInfoSchema = z
  .object({
    is_paid_by_credit_card: z.boolean().nullable().default(null),
    buyer_payment_method: z.string().nullable().default(null),
    /** The checkout snapshot. See the clock warning above. */
    buyer_total_amount: wireNumber().nullable().default(null),
    /** [BR] */
    icms_tax_amount: wireNumber().nullable().default(null),
    /** [BR] */
    iof_tax_amount: wireNumber().nullable().default(null),
    /** ⚠️ [BR] NOT `order_income.pix_discount`. */
    discount_pix: wireNumber().nullable().default(null),
  })
  .passthrough();
export type ShopeeBuyerPaymentInfo = z.infer<typeof shopeeBuyerPaymentInfoSchema>;

/**
 * The inner payload of `get_escrow_detail` — ONE order's accounting.
 *
 * ⚠️ `buyer_user_name` is a DIFFERENT spelling from the detail's `buyer_username`
 * and the two are never folded: only one of them is what this page sends, and a
 * reader that guessed would read `null` for ever. Both are buyer data, and both
 * are redacted out of every committed fixture.
 */
export const shopeeEscrowDetailPayloadSchema = z
  .object({
    order_sn: z.string().min(1),
    buyer_user_name: z.string().nullable().default(null),
    return_order_sn_list: z.array(z.string()).nullable().default(null),
    order_income: shopeeOrderIncomeSchema.nullable().default(null),
    /**
     * ⚠️ `null` on a non-BR order (the SG sandbox sends the KEY with `null`),
     * and a different CLOCK from `order_income`. See
     * {@link shopeeBuyerPaymentInfoSchema}.
     */
    buyer_payment_info: shopeeBuyerPaymentInfoSchema.nullable().default(null),
  })
  .passthrough();
export type ShopeeEscrowDetail = z.infer<typeof shopeeEscrowDetailPayloadSchema>;

/** `GET /api/v2/payment/get_escrow_detail` — WRAPPED under `response`. */
export const shopeeEscrowDetailSchema = wrappedOp(shopeeEscrowDetailPayloadSchema);
export type ShopeeEscrowDetailResponse = z.infer<typeof shopeeEscrowDetailSchema>;

/* -------------------------------------------------------------------------- */
/*                    The settlement listing (step 6)                          */
/* -------------------------------------------------------------------------- */

/**
 * One row of `get_escrow_list.response.escrow_list`.
 *
 * ⚠️ `order_sn` is `.min(1)` — STRICT, exactly as it is on the two order pages.
 * It is the preimage of a deterministic document id, so a blank one would key
 * every such row onto ONE pagamento.
 *
 * ⚠️ `payout_amount` is stored VERBATIM and converted NOWHERE, because its unit
 * is unresolved: the page's own parameter table types it as a float and prints
 * `"5733.04"`, while the rendered response sample on the SAME page prints
 * `57334`. Units or cents cannot be told apart from one field, so the reader
 * logs it beside `escrow_amount` and their ratio, and the answer arrives as
 * data instead of as a guess baked into a schema.
 *
 * ⚠️ `escrow_release_time` is SECONDS and this page is the ONLY Shopee surface
 * that exposes it at all — `get_escrow_detail` does not carry it.
 */
export const shopeeEscrowListRowSchema = z
  .object({
    order_sn: z.string().min(1),
    payout_amount: wireNumber().nullable().default(null),
    escrow_release_time: wireInt().nullable().default(null),
  })
  .passthrough();
export type ShopeeEscrowListRow = z.infer<typeof shopeeEscrowListRowSchema>;

/**
 * The inner payload of `get_escrow_list` — ONE page of released orders.
 *
 * ⚠️ **Per-ELEMENT tolerance with a `null` sentinel.** An unreadable row becomes
 * `null` in place; it never fails the page. This page IS the settlement's only
 * feed, so one malformed row must not head-of-line-block a whole week of money
 * for every other order in the window — and the sentinel is `null`, which no
 * real row can be, so the reader counts it instead of mistaking it for data.
 *
 * ⚠️ This is deliberately NOT `mlMissedFeedSchema`'s idiom. Mercado Livre
 * catches per FIELD and its docblock bans an outer object catch precisely
 * because that would manufacture `{}` — an object that looks like a row. Here a
 * per-field catch would be worse still: it would manufacture a NULL IDENTITY on
 * `order_sn`, and a null identity is the one thing a settlement cannot recover
 * from.
 *
 * ⚠️ `.default([])` because a quiet weekly window is the ORDINARY state — a
 * response with `more: false` and no `escrow_list` key is "nothing was released",
 * not a malformed body.
 *
 * ⚠️ `more` is a STRICT `z.boolean()`, for {@link shopeeOrderListPayloadSchema}'s
 * reason: it is the loop's only termination signal, and a coerced `"false"`
 * either spins the caller forever or truncates a window in silence. The row
 * count decides nothing.
 */
export const shopeeEscrowListPayloadSchema = z
  .object({
    escrow_list: z.array(shopeeEscrowListRowSchema.nullable().catch(null)).default([]),
    more: z.boolean(),
  })
  .passthrough();
export type ShopeeEscrowList = z.infer<typeof shopeeEscrowListPayloadSchema>;

/** `GET /api/v2/payment/get_escrow_list` — WRAPPED under `response`. */
export const shopeeEscrowListSchema = wrappedOp(shopeeEscrowListPayloadSchema);
export type ShopeeEscrowListResponse = z.infer<typeof shopeeEscrowListSchema>;

/* -------------------------------------------------------------------------- */
/*                      The package detail (step 7)                            */
/* -------------------------------------------------------------------------- */

/**
 * `PackageFulfillmentStatus` — the ELEVEN values a PACKAGE's
 * `fulfillment_status` takes (`guide 31`, corroborated verbatim in `guide 229`
 * under the heading "Package Fulfillment Status / Logistics Status").
 *
 * ⚠️ **A named array, never a `z.enum`.** The schemas that carry this field
 * declare `z.string()`: a token Shopee adds tomorrow must PARSE and be folded by
 * the reader (which logs it once), not fail a whole order's shipment read. The
 * array exists so the fold can be checked against it and so a test can assert
 * the count.
 *
 * ⚠️ **Never shared with {@link SHOPEE_LOGISTICS_STATUS}.** They differ by
 * exactly two legacy values, and `guide 229` says so in its own words: "Due to
 * legacy logic, the package logistics status in get_order_detail will return 2
 * additional values".
 *
 * ⚠️ Spelling tolerance is the READER's, not this array's: `faq 207` writes
 * `LOGISTICS_NOT_STARTED` and `LOGISTICS_REQUEST_CANCELLED` (double L) against
 * this page's `LOGISTICS_NOT_START` / `LOGISTICS_REQUEST_CANCELED`. This array
 * is what Shopee's DATA DEFINITION page says; the aliases live with the fold, in
 * `apps/shopee`.
 */
export const SHOPEE_PACKAGE_FULFILLMENT_STATUS = [
  'LOGISTICS_NOT_START',
  'LOGISTICS_READY',
  'LOGISTICS_REQUEST_CREATED',
  'LOGISTICS_PICKUP_DONE',
  'LOGISTICS_DELIVERY_DONE',
  'LOGISTICS_INVALID',
  'LOGISTICS_REQUEST_CANCELED',
  'LOGISTICS_PICKUP_FAILED',
  'LOGISTICS_PICKUP_RETRY',
  'LOGISTICS_DELIVERY_FAILED',
  'LOGISTICS_LOST',
] as const;
export type ShopeePackageFulfillmentStatus = (typeof SHOPEE_PACKAGE_FULFILLMENT_STATUS)[number];

/**
 * `LogisticsStatus` — the THIRTEEN values
 * `get_order_detail.package_list[].logistics_status` and
 * `get_tracking_info.response.logistics_status` take: the eleven above plus
 * `LOGISTICS_PENDING_ARRANGE` and `LOGISTICS_COD_REJECTED`.
 *
 * ⚠️ Spread from {@link SHOPEE_PACKAGE_FULFILLMENT_STATUS} so the shared eleven
 * can never drift — and never the other way round: the package page carries only
 * the eleven, so folding the two lists into one would offer a package reader two
 * values that page cannot send.
 *
 * ⚠️ `LOGISTICS_PENDING_ARRANGE` is a RETURN-object value — `faq 207`: "This
 * state is only available for Return objects" — and `push 32`
 * (`return_updates_push`, code 29, step 17's) is where it is actually observed.
 * It should never appear on a forward package; tolerating it costs nothing and
 * refusing it would fail an order read over a value Shopee documents.
 */
export const SHOPEE_LOGISTICS_STATUS = [
  ...SHOPEE_PACKAGE_FULFILLMENT_STATUS,
  'LOGISTICS_PENDING_ARRANGE',
  'LOGISTICS_COD_REJECTED',
] as const;
export type ShopeeLogisticsStatus = (typeof SHOPEE_LOGISTICS_STATUS)[number];

/**
 * `TrackingLogisticsStatus` — the THIRTY-SIX values `get_tracking_info`'s
 * PER-EVENT `tracking_info[].logistics_status` takes.
 *
 * ⚠️ **Declared here although nothing in this repo consumes it, and that is the
 * point.** The `get_tracking_info` page says "See Data Definition -
 * LogisticsStatus" for BOTH of its fields named `logistics_status`; that is a
 * documentation bug, and its own sample value `FAILED_DELIVERED` is not a member
 * of the 13-value list. `guide 229` prints this list under the explicit heading
 * "Package logistics track status" followed by "(for get_tracking_info api)" —
 * that is the page to cite. Parsing a per-event value against `LogisticsStatus`
 * rejects every one of them; this array is what stops the next reader from
 * trying.
 */
export const SHOPEE_TRACKING_LOGISTICS_STATUS = [
  'INITIAL',
  'ORDER_INIT',
  'ORDER_SUBMITTED',
  'ORDER_FINALIZED',
  'ORDER_CREATED',
  'PICKUP_REQUESTED',
  'PICKUP_PENDING',
  'PICKED_UP',
  'DELIVERY_PENDING',
  'DELIVERED',
  'PICKUP_RETRY',
  'TIMEOUT',
  'LOST',
  'UPDATE',
  'UPDATE_SUBMITTED',
  'UPDATE_CREATED',
  'RETURN_STARTED',
  'RETURNED',
  'RETURN_PENDING',
  'RETURN_INITIATED',
  'EXPIRED',
  'CANCEL',
  'CANCEL_CREATED',
  'CANCELED',
  'FAILED_ORDER_INIT',
  'FAILED_ORDER_SUBMITTED',
  'FAILED_ORDER_CREATED',
  'FAILED_PICKUP_REQUESTED',
  'FAILED_PICKED_UP',
  'FAILED_DELIVERED',
  'FAILED_UPDATE_SUBMITTED',
  'FAILED_UPDATE_CREATED',
  'FAILED_RETURN_STARTED',
  'FAILED_RETURNED',
  'FAILED_CANCEL_CREATED',
  'FAILED_CANCELED',
] as const;
export type ShopeeTrackingLogisticsStatus = (typeof SHOPEE_TRACKING_LOGISTICS_STATUS)[number];

/**
 * `get_package_detail.package_list[].item_list[]` — the ORDER detail's
 * {@link shopeePackageItemSchema} PLUS the two SKUs.
 *
 * ⚠️ Extended rather than re-declared, so the six shared keys can never drift
 * (`types.test.ts` asserts the shared key set). The two SKUs are declared
 * because they are the only fields this page adds that a future package↔line
 * reconciliation would want — `get_order_detail.package_list[].item_list[]`
 * carries the ids but no SKU (survey B §1.4). The FFM block
 * (`is_fulfillment_mapping`, `bundle_sku_id`, `components[]`) and the item-level
 * prescription block (`consultation_id`, `is_prescription_item`,
 * `prescription_check_status`, `prescription_reject_reason`) stay in
 * `.passthrough()`: both are whitelist-gated and neither is BR.
 *
 * ⚠️ This page samples BOTH SKUs as `"-"` — its absence sentinel. They arrive
 * VERBATIM here, for {@link shopeePackageDetailRowSchema}'s reason.
 */
export const shopeePackageDetailItemSchema = shopeePackageItemSchema.extend({
  item_sku: z.string().nullable().default(null),
  model_sku: z.string().nullable().default(null),
});
export type ShopeePackageDetailItem = z.infer<typeof shopeePackageDetailItemSchema>;

/**
 * One row of `get_package_detail.package_list` — the per-package twin of
 * {@link shopeePackageSchema}, which is the ORDER detail's poorer version of the
 * same parcel (no `fulfillment_status`, no `tracking_number`, no `update_time`,
 * no `ship_by_date`).
 *
 * ⚠️ `order_sn` and `package_number` are `.min(1)` STRICT, exactly as
 * {@link shopeeEscrowListRowSchema}'s `order_sn` is: the first is the preimage of
 * a deterministic pedido id and the second is the identity the caller reconciles
 * on, so a blank one would key every such row onto ONE package.
 *
 * ⚠️ `fulfillment_status` is a FREE STRING with the enum declared SEPARATELY
 * ({@link SHOPEE_PACKAGE_FULFILLMENT_STATUS}) — the reader folds, the schema
 * does not judge. It is the same rule {@link shopeePackageSchema}'s
 * `logistics_status` follows.
 *
 * ⚠️ `tracking_number` arrives VERBATIM, `"-"` included. This page samples `"-"`
 * as an absence on it, on `item_sku`, on `model_sku`, on `product_location_id`,
 * on `consultation_id` and on `virtual_contact_number`; normalising here would
 * hide from a captured fixture the one wire fact the fixture exists to record.
 * The app normalises, in ONE function.
 *
 * ⚠️ **DELIBERATELY UNDECLARED, and the absence is the enforcement:**
 * `recipient_address` (with its `geolocation`), `driver_info`
 * (`driver_name`/`driver_phone`/`vehicle_type`/`license_plate`/`courier_photo`),
 * `virtual_contact_number`, `package_query_number`, `prescription_images`,
 * `pharmacist_name`, `buyer_proof_of_collection` and — on the ITEM, one level
 * down — `prescription_reject_reason`. They ride through `.passthrough()`, so a
 * CAPTURED fixture still records them and `redact.ts` still scrubs them (it
 * walks the JSON, not the schema), but nothing in this repo can reach them off a
 * TYPE. Step 7 reads shipment state; it has no consumer for a recipient, a
 * driver or a prescription, and a typed field is an invitation.
 * `types.test.ts` pins that none of these is a key of this schema's `.shape`.
 */
export const shopeePackageDetailRowSchema = z
  .object({
    order_sn: z.string().min(1),
    package_number: z.string().min(1),
    fulfillment_status: z.string().nullable().default(null),
    /** SECONDS. "the last time that there was a change in value of package". */
    update_time: wireInt().nullable().default(null),
    logistics_channel_id: wireInt().nullable().default(null),
    /**
     * ⚠️ Never key channel logic on this — Shopee renames carriers, and on
     * 90021/90025/90026 it appends a service code ("Entrega Turbo - M1020").
     */
    shipping_carrier: z.string().nullable().default(null),
    allow_self_design_awb: z.boolean().nullable().default(null),
    days_to_ship: wireInt().nullable().default(null),
    /** SECONDS. The PER-PACKAGE deadline — `get_order_detail`'s is order-level. */
    ship_by_date: wireInt().nullable().default(null),
    tracking_number: z.string().nullable().default(null),
    /** [TW only]. */
    tracking_number_expiration_date: wireInt().nullable().default(null),
    pickup_done_time: wireInt().nullable().default(null),
    is_split_up: z.boolean().nullable().default(null),
    item_list: z.array(shopeePackageDetailItemSchema).nullable().default(null),
    parcel_chargeable_weight_gram: wireNumber().nullable().default(null),
    /** `0`, `null` and absent all mean "not combined" — never a truthiness read. */
    group_shipment_id: wireInt().nullable().default(null),
    /**
     * ⚠️ STEP 15's duplicate-call guard, not a shipped signal: it is "only
     * effective when the package's logistics_status/fulfillment_status is
     * LOGISTICS_READY". Declared so the label flow needs no package change;
     * step 7 never reads it.
     */
    is_shipment_arranged: z.boolean().nullable().default(null),
    pending_terms: z.array(z.string()).nullable().default(null),
    pending_description: z.array(z.string()).nullable().default(null),
    /**
     * SECONDS. ⚠️ A SECOND deadline, and never folded into the shipping one: on
     * channels with Auto Call Driver it is when Shopee arranges the shipment
     * ITSELF and flips `LOGISTICS_READY` to `LOGISTICS_REQUEST_CREATED` with no
     * call from us. A step-15 signal.
     */
    preparation_end_time: wireInt().nullable().default(null),
    can_split_order: z.boolean().nullable().default(null),
    can_unsplit_order: z.boolean().nullable().default(null),
    is_pre_order: z.boolean().nullable().default(null),
    /** [TW 30029 only]. */
    sorting_group: z.string().nullable().default(null),
    status_info_tag: z
      .object({
        tag_id: wireInt().nullable().default(null),
        timestamp: wireInt().nullable().default(null),
      })
      .passthrough()
      .nullable()
      .default(null),
    invoice_pending: z
      .object({
        status: z.string().nullable().default(null),
        pending_reason: z.string().nullable().default(null),
      })
      .passthrough()
      .nullable()
      .default(null),
  })
  .passthrough();
export type ShopeePackageDetailRow = z.infer<typeof shopeePackageDetailRowSchema>;

/**
 * The inner payload of `get_package_detail` — 1…50 packages.
 *
 * ⚠️ **Per-ELEMENT tolerance with a `null` sentinel**, the
 * {@link shopeeEscrowListPayloadSchema} precedent and for its reason: this op is
 * batched to 50, and one malformed parcel must not cost the other 49. The
 * sentinel is `null`, which no real row can be, so the reader COUNTS it instead
 * of mistaking it for data — and the step-7 arm puts that count in its park
 * reason, which is the only diagnosis a `.catch` costs.
 *
 * ⚠️ Deliberately NOT per FIELD: `order_sn` and `package_number` are identities,
 * and a per-field catch would manufacture a NULL identity (the argument written
 * out at {@link shopeeEscrowListPayloadSchema}).
 *
 * ⚠️ `.default([])` because a caller that asked for a package Shopee no longer
 * knows gets an empty list, not a malformed body. The caller reconciles by
 * `package_number` and never by position, so FEWER rows than were asked for is a
 * valid answer.
 */
export const shopeePackageDetailPayloadSchema = z
  .object({
    package_list: z.array(shopeePackageDetailRowSchema.nullable().catch(null)).default([]),
  })
  .passthrough();
export type ShopeePackageDetail = z.infer<typeof shopeePackageDetailPayloadSchema>;

/** `GET /api/v2/order/get_package_detail` — WRAPPED under `response`. */
export const shopeePackageDetailSchema = wrappedOp(shopeePackageDetailPayloadSchema);
export type ShopeePackageDetailResponse = z.infer<typeof shopeePackageDetailSchema>;

/* -------------------------------------------------------------------------- */
/*                        The item reads (step 9)                              */
/* -------------------------------------------------------------------------- */

/* ------------------------------ get_item_list ----------------------------- */

/**
 * One row of `get_item_list.response.item`.
 *
 * ⚠️ `item_status` is a LOOSE `z.string()`, NOT the six-value enum. Shopee moved
 * this set once already — four values to six, `announcement 769`/`841` — and a
 * strict enum on a RESPONSE would fail the WHOLE page, and with it a whole
 * catalogue scan, for one value Shopee adds. The six values are refused or
 * accepted on the REQUEST side ({@link SHOPEE_ITEM_STATUS_WIRE} in `api.ts`),
 * where a wrong value is OUR bug.
 *
 * ⚠️ `tag` is nullable because the field was added 2024-10-18: a shop whose rows
 * predate it simply has none. `tag.kit` is the ONLY kit discovery channel that
 * exists — there is no kit LISTING endpoint — so a `false` here is DATA (this
 * item is not a kit), never an absence.
 */
export const shopeeItemListRowSchema = z
  .object({
    item_id: wireInt(),
    item_status: z.string().nullable().default(null),
    /** SECONDS. Informational on this row. */
    update_time: wireInt().nullable().default(null),
    tag: z
      .object({ kit: z.boolean().nullable().default(null) })
      .passthrough()
      .nullable()
      .default(null),
  })
  .passthrough();
export type ShopeeItemListRow = z.infer<typeof shopeeItemListRowSchema>;

/**
 * The inner payload of `get_item_list` — ONE page of item ids.
 *
 * ⚠️ `has_next_page` is a STRICT `z.boolean()`, the
 * {@link shopeeOrderListPayloadSchema} reading: it is the scan's only
 * termination signal, and a `"false"` STRING coerced to `true` would spin the
 * walk forever while coerced to `false` it would truncate a catalogue in
 * silence.
 *
 * ⚠️ `next_offset` is ECHOED BACK as the next `offset`, never recomputed as
 * `offset + page_size` — the page says "this value need set to next
 * request.offset" and the API reserves the right for the two to differ.
 *
 * ⚠️ MEASURED on the sandbox (2026-09-16, step 9's wave-0 probe): the response
 * carries FIVE keys — `item, total_count, has_next_page, next_offset, next` —
 * and `next_offset` was present only on a FULL page (page_size 1 on a 1-item
 * shop ⇒ `next_offset: 1`), ABSENT on a page with room left (page_size 10 on
 * the same shop). `next` is UNDOCUMENTED, always present, and a STRING (`""`
 * on every page seen). Both are declared so neither reading throws; the scan
 * echoes `next_offset` while `has_next_page` is true, and a `has_next_page:
 * true` with no usable `next_offset` is a TERMINAL job error, never a silent
 * end of the catalogue (register item 66).
 *
 * ⚠️ `total_count` is INFORMATIONAL. It is glossed "total count of all items"
 * and NO page says whether it honours the `item_status` filter, so nothing may
 * use it as a progress denominator or as a termination signal.
 */
export const shopeeItemListPayloadSchema = z
  .object({
    item: z.array(shopeeItemListRowSchema).default([]),
    total_count: wireInt().nullable().default(null),
    has_next_page: z.boolean(),
    next_offset: wireInt().nullable().default(null),
    /** Undocumented; a string on the sandbox (`""`). Observed, never consumed. */
    next: z.string().nullable().default(null),
  })
  .passthrough();
export type ShopeeItemList = z.infer<typeof shopeeItemListPayloadSchema>;

/** `GET /api/v2/product/get_item_list` — WRAPPED under `response`. */
export const shopeeItemListSchema = wrappedOp(shopeeItemListPayloadSchema);
export type ShopeeItemListResponse = z.infer<typeof shopeeItemListSchema>;

/* --------------------------- get_item_base_info --------------------------- */

/** One value of an item's attribute. `value_unit` is the unit the seller picked. */
export const shopeeAtributoValorDoItemSchema = z
  .object({
    value_id: wireInt().nullable().default(null),
    original_value_name: z.string().nullable().default(null),
    value_unit: z.string().nullable().default(null),
  })
  .passthrough();
export type ShopeeAtributoValorDoItem = z.infer<typeof shopeeAtributoValorDoItemSchema>;

/**
 * One attribute AS FILLED ON AN ITEM.
 *
 * ⚠️ Not {@link shopeeAtributoSchema}: that one is the CATEGORY's attribute
 * definition from `get_attribute_tree` (with its editor metadata and every
 * possible value), and this one is the item's own filled values. They share
 * field names and are different shapes.
 *
 * ⚠️ The kit page spells the container `attributes`; this page spells it
 * `attribute_list`. Same element shape, two names — both are declared, neither
 * is renamed.
 */
export const shopeeAtributoDoItemSchema = z
  .object({
    attribute_id: wireInt().nullable().default(null),
    original_attribute_name: z.string().nullable().default(null),
    is_mandatory: z.boolean().nullable().default(null),
    attribute_value_list: z.array(shopeeAtributoValorDoItemSchema).default([]),
  })
  .passthrough();
export type ShopeeAtributoDoItem = z.infer<typeof shopeeAtributoDoItemSchema>;

/**
 * An item's images — three PARALLEL-INDEXED arrays.
 *
 * ⚠️ `image_url_list[i]` and `image_id_list[i]` are the same picture. Nothing
 * here asserts the two lengths match; the reader pairs by index and counts what
 * it could not pair.
 */
export const shopeeItemImageSchema = z
  .object({
    image_url_list: z.array(z.string()).nullable().default(null),
    image_id_list: z.array(z.string()).nullable().default(null),
    image_ratio: z.string().nullable().default(null),
  })
  .passthrough();
export type ShopeeItemImage = z.infer<typeof shopeeItemImageSchema>;

/** One logistics channel the seller enabled on this item. */
export const shopeeLogisticInfoSchema = z
  .object({
    logistic_id: wireInt().nullable().default(null),
    logistic_name: z.string().nullable().default(null),
    enabled: z.boolean().nullable().default(null),
    shipping_fee: wireNumber().nullable().default(null),
    size_id: wireInt().nullable().default(null),
    is_free: z.boolean().nullable().default(null),
    estimated_shipping_fee: wireNumber().nullable().default(null),
  })
  .passthrough();
export type ShopeeLogisticInfo = z.infer<typeof shopeeLogisticInfoSchema>;

/**
 * One wholesale tier.
 *
 * ⚠️ The CONTAINER is `wholesales` (plural) on the read side and `wholesale` on
 * the write side — that rename is real. The INNER field is `unit_price` on BOTH
 * sides: an `unit → unit_price` rename is stale and re-applying it would read
 * the price off a field that does not exist.
 */
export const shopeeWholesaleSchema = z
  .object({
    min_count: wireInt().nullable().default(null),
    max_count: wireInt().nullable().default(null),
    unit_price: wireNumber().nullable().default(null),
    inflated_price_of_unit_price: wireNumber().nullable().default(null),
  })
  .passthrough();
export type ShopeeWholesale = z.infer<typeof shopeeWholesaleSchema>;

/**
 * One currency's prices, on an item or on a model.
 *
 * ⚠️ An ARRAY on both pages, never an object, and it is ABSENT on an item whose
 * `has_model` is true — per-model prices come from `get_model_list`.
 *
 * ⚠️ `current_price` is the PROMOTION price while one is running;
 * `original_price` is the shelf price. Which of the two an importer keeps is the
 * app's decision, not this schema's.
 */
export const shopeePriceInfoSchema = z
  .object({
    currency: z.string().nullable().default(null),
    original_price: wireNumber().nullable().default(null),
    current_price: wireNumber().nullable().default(null),
    inflated_price_of_original_price: wireNumber().nullable().default(null),
    inflated_price_of_current_price: wireNumber().nullable().default(null),
    sip_item_price: wireNumber().nullable().default(null),
    sip_item_price_source: z.string().nullable().default(null),
    local_price: wireNumber().nullable().default(null),
    local_promotion_price: wireNumber().nullable().default(null),
  })
  .passthrough();
export type ShopeePriceInfo = z.infer<typeof shopeePriceInfoSchema>;

/**
 * The stock block, on an item or on a model.
 *
 * ⚠️ `seller_stock` is the seller's OWN stock — the only one an import may sum.
 * `shopee_stock` is what sits in a Shopee warehouse and is not ours to read as
 * availability.
 *
 * ⚠️ `shopee_stock[].stock` is typed int32 on `get_item_base_info` and STRING on
 * `get_model_list` — one doc inconsistency, one `wireInt()`, which reads both.
 */
export const shopeeStockInfoV2Schema = z
  .object({
    summary_info: z
      .object({
        total_reserved_stock: wireInt().nullable().default(null),
        total_available_stock: wireInt().nullable().default(null),
      })
      .passthrough()
      .nullable()
      .default(null),
    seller_stock: z
      .array(
        z
          .object({
            location_id: z.string().nullable().default(null),
            stock: wireInt().nullable().default(null),
            if_saleable: z.boolean().nullable().default(null),
          })
          .passthrough(),
      )
      .nullable()
      .default(null),
    shopee_stock: z
      .array(
        z
          .object({
            location_id: z.string().nullable().default(null),
            stock: wireInt().nullable().default(null),
          })
          .passthrough(),
      )
      .nullable()
      .default(null),
    /** PH/VN/ID/MY selected shops only — carried, never read. */
    advance_stock: z.record(z.string(), z.unknown()).nullable().default(null),
  })
  .passthrough();
export type ShopeeStockInfoV2 = z.infer<typeof shopeeStockInfoV2Schema>;

/**
 * The BR fiscal block, returned only when `need_tax_info=true` is sent.
 *
 * ⚠️ **EVERY field is a STRING, including the numeric-looking codes**, and a
 * `wireInt()` anywhere here would be a defect: `"00"` on `ncm`/`cest` means
 * "this item has none", and `origin`, `operation_type`, `icms_cst` and `csosn`
 * carry meaningful LEADING ZEROS that a number read would destroy silently.
 * `tax_type` is the block's one int32, and it is TW-only.
 *
 * ⚠️ `same_state_cfop` is writable on `add_item` and ABSENT from this page's
 * response table. It is declared anyway, because a doc gap and a doc bug look
 * identical and `.passthrough()` would otherwise hide which one it is.
 *
 * ⚠️ `invoice_option`/`vat_rate` (PL), `hs_code`/`tax_code` (IN) ride the
 * passthrough undeclared: declaring a field this repo never reads is noise that
 * later reads like a contract.
 */
export const shopeeTaxInfoSchema = z
  .object({
    ncm: z.string().nullable().default(null),
    cest: z.string().nullable().default(null),
    csosn: z.string().nullable().default(null),
    origin: z.string().nullable().default(null),
    diff_state_cfop: z.string().nullable().default(null),
    same_state_cfop: z.string().nullable().default(null),
    export_cfop: z.string().nullable().default(null),
    measure_unit: z.string().nullable().default(null),
    pis: z.string().nullable().default(null),
    cofins: z.string().nullable().default(null),
    icms_cst: z.string().nullable().default(null),
    pis_cofins_cst: z.string().nullable().default(null),
    federal_state_taxes: z.string().nullable().default(null),
    operation_type: z.string().nullable().default(null),
    ex_tipi: z.string().nullable().default(null),
    fci_num: z.string().nullable().default(null),
    recopi_num: z.string().nullable().default(null),
    additional_info: z.string().nullable().default(null),
    group_item_info: z.record(z.string(), z.unknown()).nullable().default(null),
    /** ⚠️ TW-only, and the ONE int32 of this block. */
    tax_type: wireInt().nullable().default(null),
  })
  .passthrough();
export type ShopeeTaxInfo = z.infer<typeof shopeeTaxInfoSchema>;

/**
 * The `extended` description — an ORDERED list of text blocks and image blocks.
 *
 * ⚠️ Mutually exclusive with `description`: when `description_type` is
 * `extended`, `description` comes back EMPTY, and vice versa. A reader that
 * looks only at `description` sees nothing for every whitelisted seller's item.
 */
export const shopeeDescriptionInfoSchema = z
  .object({
    extended_description: z
      .object({
        field_list: z
          .array(
            z
              .object({
                /** `text` | `image` — loose, the enum has no Data Definition page. */
                field_type: z.string().nullable().default(null),
                text: z.string().nullable().default(null),
                image_info: z
                  .object({
                    image_id: z.string().nullable().default(null),
                    image_url: z.string().nullable().default(null),
                  })
                  .passthrough()
                  .nullable()
                  .default(null),
              })
              .passthrough(),
          )
          .default([]),
      })
      .passthrough()
      .nullable()
      .default(null),
  })
  .passthrough();
export type ShopeeDescriptionInfo = z.infer<typeof shopeeDescriptionInfoSchema>;

/**
 * The five fields whose NESTING `get_item_base_info` contradicts itself about:
 * its parameter table renders them as SIBLINGS of `item_list` under `response`,
 * while its own response SAMPLE puts them INSIDE each item.
 *
 * ⚠️ Declaring them in ONE place only is the silent failure — under the wrong
 * reading `tax_info` arrives `null` for every item and the whole fiscal block
 * vanishes with no error anywhere. So both positions are declared and the reader
 * prefers the ITEM one (the sample is the more plausible source: they are
 * per-item data) at the cost of one `??`.
 */
export const SHOPEE_NESTING_AMBIGUOUS_KEYS = [
  'tax_info',
  'description_type',
  'description_info',
  'stock_info_v2',
  'complaint_policy',
] as const;
export type ShopeeNestingAmbiguousKey = (typeof SHOPEE_NESTING_AMBIGUOUS_KEYS)[number];

const nestingAmbiguousShape = {
  tax_info: shopeeTaxInfoSchema.nullable().default(null),
  /** `normal` | `extended` — loose; the enum has no Data Definition page. */
  description_type: z.string().nullable().default(null),
  description_info: shopeeDescriptionInfoSchema.nullable().default(null),
  stock_info_v2: shopeeStockInfoV2Schema.nullable().default(null),
  /** PL-only and NEVER requested. Declared so the tolerant shape is total. */
  complaint_policy: z.record(z.string(), z.unknown()).nullable().default(null),
} as const;

/**
 * One row of `get_item_base_info.response.item_list`.
 *
 * ⚠️ `weight` is a **STRING in KG** on the read side and a float on the write
 * side. Never `wireNumber()` here: it would SUCCEED and hide the asymmetry from
 * the publish step, which has to send a number.
 *
 * ⚠️ `dimension` is in CM and its three members are integers. An absent one is
 * `null`, never `0` — a package 0 cm tall is not the same statement as a package
 * whose height was never set.
 *
 * ⚠️ `gtin_code: "00"` means "item without GTIN" and is a STRING. Numeric
 * coercion anywhere near it is a defect.
 *
 * ⚠️ `has_model` is deliberately NOT strict, unlike `has_next_page`: it
 * terminates no loop, and a `null` degrades to "no models", which the importer
 * treats as an ordinary no-variation listing.
 *
 * ⚠️ `promotion_id` is **absent by design**. It was REMOVED from this page on
 * 2026-04-03 and survives only in the page's stale sample; declaring it would
 * invite a read of a field that no longer arrives.
 *
 * ⚠️ `size_chart` is a URL and `size_chart_id` an id — there is no
 * `size_chart_info` on the read side. Both are carried and neither is consumed
 * (the size-chart step owns them).
 */
export const shopeeItemBaseInfoRowSchema = z
  .object({
    item_id: wireInt(),
    /** int32 here; the KIT page declares the same name as an int64 ARRAY. */
    category_id: wireInt().nullable().default(null),
    item_name: z.string().nullable().default(null),
    /** Empty when `description_type` is `extended` — see `description_info`. */
    description: z.string().nullable().default(null),
    /** The seller's own identifier, "sometimes called parent SKU". */
    item_sku: z.string().nullable().default(null),
    /** SECONDS. */
    create_time: wireInt().nullable().default(null),
    /** SECONDS. */
    update_time: wireInt().nullable().default(null),
    /** ⚠️ The READ name. The link document's own field is `attributes`. */
    attribute_list: z.array(shopeeAtributoDoItemSchema).nullable().default(null),
    price_info: z.array(shopeePriceInfoSchema).nullable().default(null),
    image: shopeeItemImageSchema.nullable().default(null),
    weight: z.string().nullable().default(null),
    dimension: z
      .object({
        package_length: wireInt().nullable().default(null),
        package_width: wireInt().nullable().default(null),
        package_height: wireInt().nullable().default(null),
      })
      .passthrough()
      .nullable()
      .default(null),
    logistic_info: z.array(shopeeLogisticInfoSchema).nullable().default(null),
    pre_order: z
      .object({
        is_pre_order: z.boolean().nullable().default(null),
        days_to_ship: wireInt().nullable().default(null),
      })
      .passthrough()
      .nullable()
      .default(null),
    /** ⚠️ PLURAL on the read side; the write side and the link doc say `wholesale`. */
    wholesales: z.array(shopeeWholesaleSchema).nullable().default(null),
    /** `NEW` | `USED`, and REQUIRED for BR on the write side. */
    condition: z.string().nullable().default(null),
    /** A URL. */
    size_chart: z.string().nullable().default(null),
    size_chart_id: wireInt().nullable().default(null),
    /** Loose, for {@link shopeeItemListRowSchema}'s reason. */
    item_status: z.string().nullable().default(null),
    /**
     * **SECONDS** since epoch — the scheduled publish instant of an UNLIST item.
     *
     * ⚠️ It is the ONLY thing that separates a *scheduled* listing from a paused
     * one: both sit at `item_status: 'UNLIST'` and the wire says nothing else
     * about the difference. A fold that reads status alone reports a listing
     * waiting to go live as one the seller paused.
     *
     * ⚠️ SECONDS, like `create_time`/`update_time` on this page and unlike every
     * produto stamp in this repo, which are MILLISECONDS. The conversion is the
     * app's (`agendadoParaMsDe`), never this schema's.
     *
     * `add_item` may only SET it on an UNLIST item, from now+1h to now+90d
     * (`add_item` request table); this page returns it on the row.
     */
    scheduled_publish_time: wireInt().nullable().default(null),
    has_model: z.boolean().nullable().default(null),
    /**
     * ⚠️ The page types it `boolean`; the sandbox sends the STRING `"FALSE"`
     * (measured 2026-09-16, step 9's wave-0 probe — a `z.boolean()` here
     * refused the WHOLE page, `ShopeeSchemaError` on
     * `response.item_list[].deboost`, and with it every import). Nothing reads
     * it, so both spellings are accepted verbatim and nothing folds them.
     */
    deboost: z.union([z.boolean(), z.string()]).nullable().default(null),
    has_promotion: z.boolean().nullable().default(null),
    is_fulfillment_by_shopee: z.boolean().nullable().default(null),
    /** ⚠️ `brand_id: 0` is "No brand" — data, not an absence. */
    brand: z
      .object({
        brand_id: wireInt().nullable().default(null),
        original_brand_name: z.string().nullable().default(null),
      })
      .passthrough()
      .nullable()
      .default(null),
    /** ID/MY local sellers only. */
    item_dangerous: wireInt().nullable().default(null),
    gtin_code: z.string().nullable().default(null),
    video_info: z
      .array(
        z
          .object({
            video_url: z.string().nullable().default(null),
            thumbnail_url: z.string().nullable().default(null),
            duration: wireInt().nullable().default(null),
          })
          .passthrough(),
      )
      .nullable()
      .default(null),
    tag: z
      .object({ kit: z.boolean().nullable().default(null) })
      .passthrough()
      .nullable()
      .default(null),
    ...nestingAmbiguousShape,
  })
  .passthrough();
export type ShopeeItemBaseInfoRow = z.infer<typeof shopeeItemBaseInfoRowSchema>;

/**
 * The inner payload of `get_item_base_info` — 1…50 items.
 *
 * ⚠️ It carries the five ambiguous fields TOO, as the page's parameter table
 * renders them. The reader prefers the row's copy and falls back to this one;
 * see {@link SHOPEE_NESTING_AMBIGUOUS_KEYS}.
 *
 * ⚠️ FEWER rows than were asked for is a valid answer. Reconcile by `item_id`,
 * never by position.
 *
 * ⚠️ **Per-ELEMENT tolerance with a `null` sentinel**, the
 * {@link shopeePackageDetailPayloadSchema} precedent and for its reason: this op
 * is batched to 50, and one malformed row must not cost the other 49. Without
 * it one listing whose `weight`, `gtin_code` or BR `tax_info` block disagrees
 * with a declared type refuses the WHOLE body, the mass-import drain rethrows,
 * the ladder burns every attempt and the job ends `failed` with the healthy
 * items of that batch never imported and no `failures[]` row naming anybody —
 * and every later job walks back into the same listing. The precondition the
 * precedent asks for is met here BECAUSE of the paragraph above: the caller
 * already reconciles by `item_id` and already has a per-item verdict for an id
 * with no row, so a `null` lands in a contained failure instead of a
 * dispatch-level throw.
 *
 * ⚠️ Deliberately NOT per FIELD, and NOT a substitute for a strict field type:
 * wire drift on this op is systematic (one field wrong on EVERY row), and a
 * per-field catch would manufacture a null identity. A body whose rows are ALL
 * sentinels still surfaces — as one failure row per id — rather than as data.
 */
export const shopeeItemBaseInfoPayloadSchema = z
  .object({
    item_list: z.array(shopeeItemBaseInfoRowSchema.nullable().catch(null)).default([]),
    ...nestingAmbiguousShape,
  })
  .passthrough();
export type ShopeeItemBaseInfo = z.infer<typeof shopeeItemBaseInfoPayloadSchema>;

/** `GET /api/v2/product/get_item_base_info` — WRAPPED under `response`. */
export const shopeeItemBaseInfoSchema = wrappedOp(shopeeItemBaseInfoPayloadSchema);
export type ShopeeItemBaseInfoResponse = z.infer<typeof shopeeItemBaseInfoSchema>;

/* ----------------------------- get_model_list ----------------------------- */

/**
 * One tier of the CUSTOM variation tree (`tier_variation`).
 *
 * ⚠️ Deprecated on the WRITE side only; it is still a documented RESPONSE field,
 * and for a BR shop outside Fashion it is the only tree with usable names.
 */
export const shopeeTierVariationSchema = z
  .object({
    name: z.string().nullable().default(null),
    option_list: z
      .array(
        z
          .object({
            option: z.string().nullable().default(null),
            image: z
              .object({
                image_id: z.string().nullable().default(null),
                image_url: z.string().nullable().default(null),
              })
              .passthrough()
              .nullable()
              .default(null),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
export type ShopeeTierVariation = z.infer<typeof shopeeTierVariationSchema>;

/**
 * One tier of the STANDARDISED variation tree.
 *
 * ⚠️ `variation_id: 0` and `variation_option_id: 0` are the documented CUSTOM
 * sentinel — a VALUE, not an absence — and for a BR shop outside Fashion every
 * id here is 0. A reader that treats 0 as "present" mints a shared identity for
 * every custom option in the catalogue.
 */
export const shopeeStandardiseTierVariationSchema = z
  .object({
    variation_id: wireInt().nullable().default(null),
    variation_name: z.string().nullable().default(null),
    variation_group_id: wireInt().nullable().default(null),
    variation_option_list: z
      .array(
        z
          .object({
            variation_option_id: wireInt().nullable().default(null),
            variation_option_name: z.string().nullable().default(null),
            image_id: z.string().nullable().default(null),
            image_url: z.string().nullable().default(null),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
export type ShopeeStandardiseTierVariation = z.infer<typeof shopeeStandardiseTierVariationSchema>;

/**
 * One model (variation) of an item.
 *
 * ⚠️ `promotion_id` is an OPAQUE STRING ({@link shopeeIdOpaco}), never a number,
 * and it is still NEVER stored. It became a **uint64** on 2026-07-31, and under
 * the `wireInt()` it carried until step 12 that was a live parse hazard rather
 * than a precision one: Zod 4's `.int()` answers `too_big` above
 * `Number.MAX_SAFE_INTEGER`, so ONE big id would have failed the whole
 * `get_model_list` page — step 9's import and step 11's model reconciliation
 * with it. The docblock said so and the code did the unsafe thing anyway; step
 * 12 made the code agree. A number that arrived already rounded still parses,
 * and {@link idOpacoExato} is how a caller asks. The value remains volatile
 * promotion state, re-readable from `get_item_promotion` at any time.
 *
 * ⚠️ `model_status` is a LOOSE `z.string()`, not the two-value enum: the LINK
 * schema is where that enum lives, and an unknown value must cost ONE item's
 * write, never a whole page's parse.
 *
 * ⚠️ `weight` is a STRING in KG here too, and `dimension` falls back to the
 * item's when the model does not set its own.
 */
export const shopeeModelSchema = z
  .object({
    model_id: wireInt(),
    tier_index: z.array(wireInt()).default([]),
    promotion_id: shopeeIdOpaco(),
    has_promotion: z.boolean().nullable().default(null),
    model_sku: z.string().nullable().default(null),
    model_status: z.string().nullable().default(null),
    price_info: z.array(shopeePriceInfoSchema).nullable().default(null),
    stock_info_v2: shopeeStockInfoV2Schema.nullable().default(null),
    pre_order: z
      .object({
        is_pre_order: z.boolean().nullable().default(null),
        days_to_ship: wireInt().nullable().default(null),
      })
      .passthrough()
      .nullable()
      .default(null),
    gtin_code: z.string().nullable().default(null),
    weight: z.string().nullable().default(null),
    dimension: z
      .object({
        package_length: wireInt().nullable().default(null),
        package_width: wireInt().nullable().default(null),
        package_height: wireInt().nullable().default(null),
      })
      .passthrough()
      .nullable()
      .default(null),
    is_fulfillment_by_shopee: z.boolean().nullable().default(null),
  })
  .passthrough();
export type ShopeeModel = z.infer<typeof shopeeModelSchema>;

/**
 * The inner payload of `get_model_list` — ONE item's trees and models.
 *
 * ⚠️ BOTH trees are nullable and BOTH may be absent, in any combination. The
 * legacy dereferenced `tier_variation` unconditionally while its own exporter
 * called that tree deprecated; the page still documents it as a live response
 * field. Tolerate every combination — the option identity falls back to the
 * NAME.
 *
 * ⚠️ There is no batch form and no paging: ONE call per variation-bearing item.
 * That is the throughput floor of a catalogue import, and the reason it must be
 * resumable.
 */
export const shopeeModelListPayloadSchema = z
  .object({
    tier_variation: z.array(shopeeTierVariationSchema).nullable().default(null),
    standardise_tier_variation: z
      .array(shopeeStandardiseTierVariationSchema)
      .nullable()
      .default(null),
    model: z.array(shopeeModelSchema).default([]),
  })
  .passthrough();
export type ShopeeModelList = z.infer<typeof shopeeModelListPayloadSchema>;

/** `GET /api/v2/product/get_model_list` — WRAPPED under `response`. */
export const shopeeModelListSchema = wrappedOp(shopeeModelListPayloadSchema);
export type ShopeeModelListResponse = z.infer<typeof shopeeModelListSchema>;

/* ---------------------------- get_kit_item_info --------------------------- */

/**
 * One component of one kit model.
 *
 * ⚠️ A component is addressed as a PAIR: `component_item_id` AND
 * `component_model_id`. `quantity` is how many of it compose the kit model.
 *
 * ⚠️ `component_item_or_model_image` is an image_id, not a URL.
 */
export const shopeeKitComponentSchema = z
  .object({
    component_item_id: wireInt(),
    component_item_name: z.string().nullable().default(null),
    component_model_id: wireInt().nullable().default(null),
    component_model_name: z.string().nullable().default(null),
    quantity: wireInt().nullable().default(null),
    main_component: z.boolean().nullable().default(null),
    component_item_or_model_image: z.string().nullable().default(null),
    component_item_or_model_sku: z.string().nullable().default(null),
  })
  .passthrough();
export type ShopeeKitComponent = z.infer<typeof shopeeKitComponentSchema>;

/**
 * One kit model — at most nine per kit, one tier only.
 *
 * ⚠️ `model_sku` is declared `int64` on the page and comes back `""` in its own
 * sample. It is a STRING here: a sku is an identifier, and reading `"001"` as
 * the number 1 would fold two different skus onto one.
 */
export const shopeeKitModelSchema = z
  .object({
    model_id: wireInt(),
    model_sku: z.string().nullable().default(null),
    original_price: wireNumber().nullable().default(null),
    tier_index: z.array(wireInt()).default([]),
    component_list: z.array(shopeeKitComponentSchema).default([]),
  })
  .passthrough();
export type ShopeeKitModel = z.infer<typeof shopeeKitModelSchema>;

/**
 * `get_kit_item_info.response.product_info` — ONE kit item.
 *
 * ⚠️ **Four field names differ from the item read on purpose**, and each is a
 * silent `null` if copied across: `attributes` (not `attribute_list`),
 * `brand_info` (not `brand`), `pre_order_info` (not `pre_order`) and
 * `tier_variation_list` (not `tier_variation`). The page's TABLE also says
 * `images` where its own SAMPLE says `image`, and its
 * `tier_variation_list[].option_list[].image` is an ARRAY where the item page's
 * is an object. Every one of those is declared in BOTH spellings rather than
 * guessed.
 *
 * ⚠️ `category_id` is declared `int64[]` and sampled as a SCALAR. Both parse;
 * the app normalises.
 *
 * ⚠️ **There is NO stock field anywhere on this page** — not here, not on
 * `add_kit_item`, not on `update_kit_item` — and the derivation rule is
 * undocumented. Nothing in this repo may infer one.
 */
export const shopeeKitItemSchema = z
  .object({
    item_id: wireInt(),
    item_name: z.string().nullable().default(null),
    category_id: z
      .union([wireInt(), z.array(wireInt())])
      .nullable()
      .default(null),
    item_status: z.string().nullable().default(null),
    item_sku: z.string().nullable().default(null),
    /** The page's TABLE spelling (1:1 ratio). */
    images: shopeeItemImageSchema.nullable().default(null),
    /** The page's own SAMPLE spelling. Both are read; neither is invented. */
    image: shopeeItemImageSchema.nullable().default(null),
    long_images: shopeeItemImageSchema.nullable().default(null),
    description: z.string().nullable().default(null),
    description_type: z.string().nullable().default(null),
    description_info: shopeeDescriptionInfoSchema.nullable().default(null),
    /** ⚠️ `attributes`, not `attribute_list`. */
    attributes: z.array(shopeeAtributoDoItemSchema).nullable().default(null),
    weight: z.string().nullable().default(null),
    dimension: z
      .object({
        package_length: wireInt().nullable().default(null),
        package_width: wireInt().nullable().default(null),
        package_height: wireInt().nullable().default(null),
      })
      .passthrough()
      .nullable()
      .default(null),
    /** ⚠️ `brand_info`, not `brand`. */
    brand_info: z
      .object({
        brand_id: wireInt().nullable().default(null),
        original_brand_name: z.string().nullable().default(null),
      })
      .passthrough()
      .nullable()
      .default(null),
    model_list: z.array(shopeeKitModelSchema).default([]),
    /** ⚠️ `pre_order_info`, not `pre_order`. */
    pre_order_info: z
      .object({
        is_pre_order: z.boolean().nullable().default(null),
        days_to_ship: wireInt().nullable().default(null),
      })
      .passthrough()
      .nullable()
      .default(null),
    /** ⚠️ `tier_variation_list`, and its `image` is an ARRAY here. */
    tier_variation_list: z
      .array(
        z
          .object({
            name: z.string().nullable().default(null),
            option_list: z
              .array(
                z
                  .object({
                    option: z.string().nullable().default(null),
                    image: z
                      .union([
                        z
                          .object({
                            image_id: z.string().nullable().default(null),
                            image_url: z.string().nullable().default(null),
                          })
                          .passthrough(),
                        z.array(
                          z
                            .object({
                              image_id: z.string().nullable().default(null),
                              image_url: z.string().nullable().default(null),
                            })
                            .passthrough(),
                        ),
                      ])
                      .nullable()
                      .default(null),
                  })
                  .passthrough(),
              )
              .default([]),
          })
          .passthrough(),
      )
      .nullable()
      .default(null),
    /** Sample-only fields, absent from the page's parameter table. SECONDS. */
    create_time: wireInt().nullable().default(null),
    update_time: wireInt().nullable().default(null),
    logistic_info: z.array(shopeeLogisticInfoSchema).nullable().default(null),
  })
  .passthrough();
export type ShopeeKitItem = z.infer<typeof shopeeKitItemSchema>;

/**
 * The inner payload of `get_kit_item_info` — ONE kit.
 *
 * ⚠️ `product_info: null` parses. It is the app's "this kit is unreadable", and
 * the app refuses the item for it — never a silent import of a kit as a simple
 * product.
 */
export const shopeeKitItemInfoPayloadSchema = z
  .object({ product_info: shopeeKitItemSchema.nullable().default(null) })
  .passthrough();
export type ShopeeKitItemInfo = z.infer<typeof shopeeKitItemInfoPayloadSchema>;

/** `GET /api/v2/product/get_kit_item_info` — WRAPPED under `response`. */
export const shopeeKitItemInfoSchema = wrappedOp(shopeeKitItemInfoPayloadSchema);
export type ShopeeKitItemInfoResponse = z.infer<typeof shopeeKitItemInfoSchema>;

/* -------------------------------------------------------------------------- */
/*                       The listing writes (step 11)                         */
/* -------------------------------------------------------------------------- */

/* --------------------- the wire bounds and the write enums ---------------- */

/**
 * `add_item`/`update_item` `item_status` — the only two values either page WRITES.
 *
 * ⚠️ NOT {@link shopeeItemListRowSchema}'s loose read string, and NOT
 * `SHOPEE_ITEM_STATUS_WIRE` (`api.ts`), which is the SIX-value REQUEST filter of
 * `get_item_list`. Two names because they are two sets: an item can BE `BANNED`
 * or `SELLER_DELETE`, and no write may ever say so.
 */
export const SHOPEE_ITEM_STATUS_WRITABLE = { normal: 'NORMAL', unlist: 'UNLIST' } as const;
export type ShopeeItemStatusWritable =
  (typeof SHOPEE_ITEM_STATUS_WRITABLE)[keyof typeof SHOPEE_ITEM_STATUS_WRITABLE];

/**
 * `condition` — `announcement 1528`: "only supports NEW or USED, case-insensitive",
 * and MANDATORY on every create AND update for BR.
 */
export const SHOPEE_CONDITION = { new: 'NEW', used: 'USED' } as const;
export type ShopeeCondition = (typeof SHOPEE_CONDITION)[keyof typeof SHOPEE_CONDITION];

/**
 * The four documented `fee_type` values of `get_channel_list`, for the CALLER's
 * branch.
 *
 * ⚠️ The schema field stays a LOOSE string ({@link shopeeLogisticsChannelSchema}):
 * an unknown value must cost ONE channel's usability, never the whole page. This
 * constant is how the caller names the four it knows.
 */
export const SHOPEE_LOGISTICS_FEE_TYPE = {
  sizeSelection: 'SIZE_SELECTION',
  sizeInput: 'SIZE_INPUT',
  fixedDefaultPrice: 'FIXED_DEFAULT_PRICE',
  customPrice: 'CUSTOM_PRICE',
} as const;
export type ShopeeLogisticsFeeType =
  (typeof SHOPEE_LOGISTICS_FEE_TYPE)[keyof typeof SHOPEE_LOGISTICS_FEE_TYPE];

/**
 * ⚠️ Every WIRE bound Shopee states lives HERE, in the package, and `apps/shopee`
 * declares no local copy of any of them. A second copy of a documented bound is
 * how the two drift the day a probe flips one.
 *
 * `init_tier_variation`: "Defining only color creates one tier, while color +
 * size creates two tiers (maximum supported)"; `error_param: The level of
 * tier-variation over 2.`
 */
export const SHOPEE_TIER_MAX_LEVELS = 2;

/**
 * Options per tier — **MEASURED on 2026-09-17**, no longer a judgement call.
 *
 * ⚠️ The pages contradict themselves: both `init_tier_variation` and
 * `update_tier_variation` carry BOTH `error_tier_opt_too_many: Count of
 * tier_variation option is larger than 20.` and `error_param: Count of
 * tier_variation options should be under 50.` — read 2026-09-17 on both pages.
 * The sandbox write probe settled it the same day: a raw `update_tier_variation`
 * carrying **21** options in ONE tier was ACCEPTED (`error: ''`) by the SG
 * sandbox shop. So the live bound is the `error_param` one, 50, and the
 * `error_tier_opt_too_many` string is stale or belongs to a scope this shop is
 * not in. What shipped before was the conservative arm of the contradiction (20)
 * and it refused bodies Shopee accepts; this value is now an OBSERVATION, and
 * changing it again takes another measurement.
 */
export const SHOPEE_TIER_MAX_OPTIONS = 50;

/**
 * `add_model.model_list` limits [1,50]; `update_model.model` "between 1 to 50";
 * `init_tier_variation.model` "model number at most 50".
 *
 * ⚠️ The CREATE-side bound, and it is NOT
 * {@link SHOPEE_UPDATE_STOCK_MAX_MODELS} even though both read 50 today. This
 * one bounds how many models an item may be GIVEN; that one bounds how many
 * fit in ONE stock write. They are stated by different pages, and a probe that
 * moves one must not move the other — so they are two constants, and a test
 * pins that they are separately declared.
 */
export const SHOPEE_MODEL_MAX_PER_ITEM = 50;

/** "model_sku length information needs to be no more than 100 characters" (every model page). */
export const SHOPEE_MODEL_SKU_MAX_LENGTH = 100;

/**
 * `upload_image`: "image number should be less than 9"; `get_item_limit`'s
 * `item_image_count_limit` samples a max of 9.
 *
 * ⚠️ The HARD ceiling, not the band: the real bound is per SHOP and per CATEGORY
 * and comes from `get_item_limit`. A body that fits this one can still be
 * refused by the band.
 */
export const SHOPEE_ITEM_IMAGE_MAX = 9;

/** `unlist_item.item_list`: "Length should be between 1 to 50." */
export const SHOPEE_UNLIST_MAX_ITEMS = 50;

/** `get_item_violation_info.item_id_list`: "limit [0,50]". */
export const SHOPEE_ITEM_VIOLATION_MAX_IDS = 50;

/** `upload_image`: "Max 10.0 MB each." */
export const SHOPEE_UPLOAD_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** `upload_image`: "Image format accepted: JPG, JPEG, PNG." */
export const SHOPEE_UPLOAD_IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/jpg', 'image/png'] as const;
export type ShopeeUploadImageContentType = (typeof SHOPEE_UPLOAD_IMAGE_CONTENT_TYPES)[number];

export type ShopeeUploadImageSigning = 'public' | 'shop';

/**
 * ⚠️ The signing mode of `upload_image` — the ONE literal that flips it.
 *
 * The page is `type=Public`: its Common params are only `partner_id`,
 * `timestamp` and `sign`, its sign description names four elements, and all four
 * request samples carry a query of exactly those three. Against that, its own
 * api-specific error list OPENS with `error_param: There is no access_token in
 * query.` and `error_auth: Invalid access_token.` — errors a call with no token
 * in its contract cannot produce — and the legacy PRODUCTION exporter signed it
 * with the SHOP signature. The legacy code proves what was SENT, never what was
 * ACCEPTED. Default `public`; the sandbox probe settles it.
 */
export const SHOPEE_UPLOAD_IMAGE_SIGNING: ShopeeUploadImageSigning = 'public';

/**
 * ⚠️ The multipart FIELD NAME — the second contradicted literal on the same page.
 * The request table, the cURL, PHP and Python samples all say `image`; the JAVA
 * sample says `file`. Three to one, and the legacy exporter sent `image` in
 * production for years.
 */
export const SHOPEE_UPLOAD_IMAGE_FIELD = 'image';

/**
 * `scene` — "normal: we will process the image as a square image, it is
 * recommended to use when uploading item image; desc: we will not process the
 * image".
 */
export const SHOPEE_UPLOAD_IMAGE_SCENE = { normal: 'normal', desc: 'desc' } as const;
export type ShopeeUploadImageScene =
  (typeof SHOPEE_UPLOAD_IMAGE_SCENE)[keyof typeof SHOPEE_UPLOAD_IMAGE_SCENE];

/**
 * The scene a listing photo is sent with.
 *
 * ⚠️ SENT rather than omitted, even though `normal` is the page's documented
 * default: the default is PROSE, and a listing image that silently stopped being
 * squared would surface as a rejected `add_item`, never as a missing parameter.
 */
export const SHOPEE_UPLOAD_IMAGE_SCENE_PADRAO: ShopeeUploadImageScene =
  SHOPEE_UPLOAD_IMAGE_SCENE.normal;

/* ---------------------- the stock bounds (step 12) ------------------------ */

/**
 * `update_stock.stock_list`: "Length should be between 1 to 50."
 *
 * ⚠️ The batch bound of ONE stock write, and deliberately a different constant
 * from {@link SHOPEE_MODEL_MAX_PER_ITEM}, which bounds how many models an item
 * may HAVE. An item at the model ceiling still takes exactly one call today;
 * the day either page moves, only the one that moved changes here.
 */
export const SHOPEE_UPDATE_STOCK_MAX_MODELS = 50;

/**
 * The floor of a stock value on the wire — `0` is a legal quantity on an
 * UPDATE, not an absence.
 *
 * ⚠️ It NAMES the floor; it does not enforce it. The outgoing guard on
 * `seller_stock[].stock` is `assertIdNaoNegativo` — `>= 0` **and** a safe
 * integer, which is why the check is not a bare comparison against this
 * constant — and a reader comparing the two must not be told otherwise.
 * `update_stock`'s own response sample prints `"stock": 0`, probe P6 measured a
 * `stock: 0` update accepted live, and announcement 1445 (BR) is the behaviour
 * that makes the value load-bearing: Shopee RESTORES stock by itself when an
 * earlier order is cancelled, so keeping a sold-out listing at zero is the
 * integrator's job.
 */
export const SHOPEE_STOCK_MIN_WIRE = 0;

/** `get_item_promotion.item_id_list`: "Item ID list, can send 1 to 50 items." */
export const SHOPEE_ITEM_PROMOTION_MAX_IDS = 50;

/**
 * `get_shop_holiday_mode.holiday_mode_type` — "1: Partial Holiday: seller can
 * still receive orders during partial holiday / 0: Full Holiday: seller can not
 * receive orders during full holiday".
 *
 * ⚠️ Named because the numbers read BACKWARDS: the bigger number is the milder
 * state. The page also says "only when holiday_mode_on = true will the
 * holiday_mode_type work", so the value means nothing on its own.
 */
export const SHOPEE_HOLIDAY_MODE_TYPE = { total: 0, parcial: 1 } as const;
export type ShopeeHolidayModeType =
  (typeof SHOPEE_HOLIDAY_MODE_TYPE)[keyof typeof SHOPEE_HOLIDAY_MODE_TYPE];

/**
 * `get_warehouse_detail.warehouse_type` — "1: Pickup Warehouse - 2: Return
 * Warehouse", "Default value is 1 (Pickup Warehouse)".
 */
export const SHOPEE_WAREHOUSE_TYPE = { coleta: 1, retorno: 2 } as const;
export type ShopeeWarehouseType =
  (typeof SHOPEE_WAREHOUSE_TYPE)[keyof typeof SHOPEE_WAREHOUSE_TYPE];

/**
 * The two `get_warehouse_detail` codes that mean "this shop has no
 * multi-warehouse regime", rather than "the read failed".
 *
 * - `warehouse.error_not_in_whitelist` — "This error will show if your shop has
 *   no permission to access multi-warehouse". It is the page's OWN response
 *   sample, i.e. the expected answer for an ordinary shop.
 * - `warehouse.error_can_not_find_warehouse` — "This error will show if there
 *   is no legal warehouse address for given shop id".
 *
 * ⚠️ Both spellings carry the `warehouse.` module prefix, which
 * `shopeeCodeSemPrefixoDeModulo` (`errors.ts`) strips for a SECOND lookup — the
 * caller matches verbatim first, then stripped, and never rewrites the code it
 * reports. Every OTHER code on that page is a real failure and must be rethrown
 * (rule 6): a shop that silently reads as "no multi-warehouse" when the call
 * merely failed would take the single-location write path against a
 * multi-location listing.
 */
export const SHOPEE_WAREHOUSE_SEM_ACESSO = [
  'warehouse.error_not_in_whitelist',
  'warehouse.error_can_not_find_warehouse',
] as const;
export type ShopeeWarehouseSemAcesso = (typeof SHOPEE_WAREHOUSE_SEM_ACESSO)[number];

/**
 * `get_item_promotion.promotion_staging` — "Could be ongoing/upcoming".
 *
 * ⚠️ The field stays a LOOSE `z.string()` on the schema: a third staging value
 * must cost one branch, never the page. This constant is how a caller names the
 * two documented ones.
 *
 * ⚠️ `upcoming` is not decoration. `has_promotion` on a model is documented
 * ONGOING-only, so it cannot rule out a promotion that has already reserved
 * stock for a window that has not started.
 */
export const SHOPEE_PROMOTION_STAGING = { ongoing: 'ongoing', upcoming: 'upcoming' } as const;
export type ShopeePromotionStaging =
  (typeof SHOPEE_PROMOTION_STAGING)[keyof typeof SHOPEE_PROMOTION_STAGING];

/* ------------------------- the envelope-only writes ----------------------- */

/**
 * `update_tier_variation`, `update_model`, `delete_model` and `delete_item` —
 * all four answer the BARE envelope, with no `response` object at all (verified
 * on all four Response-params tables and all four samples, 2026-09-17).
 *
 * ⚠️ `flatOp({})` rather than reusing {@link shopeeEnvelopeSchema}: that one is
 * the TRANSPORT's stage-1 schema and must not become an operation's — the
 * {@link shopeeConfirmLostPushSchema} rule.
 *
 * ⚠️ ONE constant over FOUR operations, and that is the edit hazard: if ONE of
 * them ever grows a `response`, it gets its OWN schema. Splitting is the edit;
 * widening this one is not.
 */
export const shopeeWriteAckSchema = flatOp({});
export type ShopeeWriteAck = z.infer<typeof shopeeWriteAckSchema>;

/* --------------------------- add_item / update_item ----------------------- */

/**
 * `add_item`'s echo of the item price — an OBJECT.
 *
 * ⚠️ {@link shopeePriceInfoSchema} is an ARRAY on every READ page. Reusing it
 * here refuses the whole `add_item` body; declaring the array shape here would
 * refuse the read. Two schemas for one concept, and the near-miss test pins that
 * neither parses the other page's sample.
 */
export const shopeePriceInfoObjetoSchema = z
  .object({
    current_price: wireNumber().nullable().default(null),
    original_price: wireNumber().nullable().default(null),
  })
  .passthrough();
export type ShopeePriceInfoObjeto = z.infer<typeof shopeePriceInfoObjetoSchema>;

/**
 * The echo of `add_item` AND of `update_item` — ONE schema for both pages.
 *
 * ⚠️ The decision rests on a passing sample PER PAGE (two tests), never on a
 * comment claiming the two are mirrors. They are not: `add_item` additionally
 * echoes `attribute`, `price_info`, `seller_stock`, `wholesale` and
 * `video_info`, and its `logistic_info` rows carry `size_id`/`shipping_fee`
 * where `update_item`'s carry `estimated_shipping_fee`/`logistic_name`. The
 * UNION of both positions is declared and every field but `item_id` is nullable,
 * so either body parses.
 *
 * ⚠️ NOTHING in step 11 reads this echo except `item_id`. State is read back
 * through `get_item_base_info` — `announcement 1394` recommends exactly that,
 * and `announcement 1395` is REMOVING `update_item`'s response logistics block,
 * so reading channel state off it would rot on a date already announced.
 *
 * ⚠️ `item_id` is the one required field: an `add_item` that answered without
 * one is unusable — the publish would have nothing to write back — and must fail
 * loudly rather than write a link with a null id.
 *
 * ⚠️ `images` (plural, with the two string lists) is the WRITE spelling;
 * `get_item_base_info` spells the same block `image`. `attribute` is the
 * Response-params spelling and `attributes` is what `add_item`'s own SAMPLE
 * prints — both are declared, neither is renamed, exactly as the kit page's four
 * renames are handled.
 */
export const shopeeItemWriteEchoPayloadSchema = z
  .object({
    item_id: wireInt(),
    item_status: z.string().nullable().default(null),
    item_name: z.string().nullable().default(null),
    description: z.string().nullable().default(null),
    /** `NEW` | `USED`. Loose here for {@link shopeeItemListRowSchema}'s reason. */
    condition: z.string().nullable().default(null),
    /** ⚠️ A FLOAT on the write side and a STRING in KG on the read side. */
    weight: wireNumber().nullable().default(null),
    dimension: z
      .object({
        package_length: wireInt().nullable().default(null),
        package_width: wireInt().nullable().default(null),
        package_height: wireInt().nullable().default(null),
      })
      .passthrough()
      .nullable()
      .default(null),
    category_id: wireInt().nullable().default(null),
    /** ⚠️ `brand_id: 0` is "No Brand" — data, not an absence. */
    brand: z
      .object({
        brand_id: wireInt().nullable().default(null),
        original_brand_name: z.string().nullable().default(null),
      })
      .passthrough()
      .nullable()
      .default(null),
    pre_order: z
      .object({
        is_pre_order: z.boolean().nullable().default(null),
        days_to_ship: wireInt().nullable().default(null),
      })
      .passthrough()
      .nullable()
      .default(null),
    item_dangerous: wireInt().nullable().default(null),
    description_type: z.string().nullable().default(null),
    description_info: shopeeDescriptionInfoSchema.nullable().default(null),
    /** PL-only. Carried, never read. */
    complaint_policy: z.record(z.string(), z.unknown()).nullable().default(null),
    /** ⚠️ PLURAL on the write side; the read page spells the same block `image`. */
    images: shopeeItemImageSchema.nullable().default(null),
    /** The Response-params spelling. */
    attribute: z.array(shopeeAtributoDoItemSchema).nullable().default(null),
    /** ⚠️ The spelling `add_item`'s own response SAMPLE prints. */
    attributes: z.array(shopeeAtributoDoItemSchema).nullable().default(null),
    /** ⚠️ An OBJECT here — see {@link shopeePriceInfoObjetoSchema}. */
    price_info: shopeePriceInfoObjetoSchema.nullable().default(null),
    seller_stock: z
      .array(
        z
          .object({
            location_id: z.string().nullable().default(null),
            stock: wireInt().nullable().default(null),
          })
          .passthrough(),
      )
      .nullable()
      .default(null),
    /** ⚠️ SINGULAR on the write side; the read page says `wholesales`. */
    wholesale: z.array(shopeeWholesaleSchema).nullable().default(null),
    video_info: z
      .array(
        z
          .object({
            video_url: z.string().nullable().default(null),
            thumbnail_url: z.string().nullable().default(null),
            duration: wireInt().nullable().default(null),
          })
          .passthrough(),
      )
      .nullable()
      .default(null),
    /**
     * ⚠️ {@link shopeeLogisticInfoSchema} is reused because it already declares
     * all seven names the two pages use between them. It is NEVER read back as
     * channel state — `announcement 1395` deprecates these fields in the
     * response.
     */
    logistic_info: z.array(shopeeLogisticInfoSchema).nullable().default(null),
  })
  .passthrough();
export type ShopeeItemWriteEcho = z.infer<typeof shopeeItemWriteEchoPayloadSchema>;

/** `POST /api/v2/product/{add_item,update_item}` — WRAPPED under `response`. */
export const shopeeItemWriteSchema = wrappedOp(shopeeItemWriteEchoPayloadSchema);
export type ShopeeItemWriteResponse = z.infer<typeof shopeeItemWriteSchema>;

/* ---------------------- init_tier_variation / add_model ------------------- */

/**
 * One model row as `init_tier_variation` and `add_model` echo it.
 *
 * ⚠️ `tier_index` is typed `object[]` on `init_tier_variation`'s response table
 * and `int32[]` on `add_model`'s. It is a doc typing bug: both REQUEST tables say
 * `int32[]`, `get_model_list` says `int32[]`, and `init_tier_variation`'s own
 * sample prints `[0,0]`. It is read as int[]; a row that really carried objects
 * costs ONE row, not the page — see the sentinel on the payload.
 *
 * ⚠️ `model_id` is REQUIRED inside the row. A row without one is not a model, and
 * `variacaoShopeeLinkSchema.model_id` is required and non-nullable — a
 * `model_id: null` riding through here would be written into `variashopee` as a
 * link to nothing.
 *
 * ⚠️ `weight` is a float HERE and a STRING on the read pages. This is the write
 * side.
 */
export const shopeeTierWriteRowSchema = z
  .object({
    model_id: wireInt(),
    tier_index: z.array(wireInt()).default([]),
    model_sku: z.string().nullable().default(null),
    price_info: z
      .array(z.object({ original_price: wireNumber().nullable().default(null) }).passthrough())
      .nullable()
      .default(null),
    seller_stock: z
      .array(
        z
          .object({
            location_id: z.string().nullable().default(null),
            stock: wireInt().nullable().default(null),
          })
          .passthrough(),
      )
      .nullable()
      .default(null),
    weight: wireNumber().nullable().default(null),
    dimension: z
      .object({
        package_height: wireInt().nullable().default(null),
        package_length: wireInt().nullable().default(null),
        package_width: wireInt().nullable().default(null),
      })
      .passthrough()
      .nullable()
      .default(null),
  })
  .passthrough();
export type ShopeeTierWriteRow = z.infer<typeof shopeeTierWriteRowSchema>;

/**
 * The payload of `init_tier_variation` AND of `add_model`.
 *
 * ⚠️ ONE schema for two pages, justified by a passing sample per page:
 * `init_tier_variation` additionally answers `item_id` and the DEPRECATED
 * `tier_variation[]` read shape, `add_model` answers only `model[]`. Both extra
 * fields are nullable, so either body parses.
 *
 * ⚠️ **PER-ELEMENT tolerance with a `null` sentinel**, the
 * {@link shopeeItemBaseInfoPayloadSchema} precedent and for a SHARPER reason:
 * this response arrives AFTER Shopee has already minted the models. A whole-body
 * refusal would leave Shopee holding models the ERP has no id for. The
 * precondition the precedent asks for is met — the publisher uses this pairing
 * only as a cross-check and reconciles against a FRESH `get_model_list`, so a
 * `null` row costs one un-cross-checked model and nothing durable.
 *
 * ⚠️ `add_model`'s own response SAMPLE prints a `model[]` row with NO `model_id`
 * (read 2026-09-17). Under the sentinel that row parses as `null` instead of
 * refusing the page — which is exactly the shape the reconciliation read repairs.
 */
export const shopeeTierWritePayloadSchema = z
  .object({
    item_id: wireInt().nullable().default(null),
    tier_variation: z.array(shopeeTierVariationSchema).nullable().default(null),
    model: z.array(shopeeTierWriteRowSchema.nullable().catch(null)).default([]),
  })
  .passthrough();
export type ShopeeTierWrite = z.infer<typeof shopeeTierWritePayloadSchema>;

/** `POST /api/v2/product/{init_tier_variation,add_model}` — WRAPPED under `response`. */
export const shopeeTierWriteSchema = wrappedOp(shopeeTierWritePayloadSchema);
export type ShopeeTierWriteResponse = z.infer<typeof shopeeTierWriteSchema>;

/* ------------------------------- unlist_item ------------------------------ */

/**
 * `unlist_item` — the THIRD partial-failure encoding in the Product module.
 *
 * ⚠️ `success_list[].unlist` ECHOES THE REQUEST FLAG. It is NOT the item's new
 * `item_status`: a re-list request answers `unlist: false` on success. The page's
 * own mixed sample shows exactly that. Whoever needs the new status re-reads
 * `get_item_base_info`.
 *
 * ⚠️ Both arrays `.default([])` rather than `.nullable()`: an absent
 * `failure_list` means "nothing failed", and a `null` there would make every
 * caller write `?? []` — one of which will forget.
 *
 * ⚠️ NO per-element `.catch(null)` here, deliberately: the rows are two scalars
 * each, and a sentinel would produce an entry with no `item_id`, which is
 * unreconcilable. A malformed row is a page-level refusal, and unlike
 * `init_tier_variation` a refusal here costs nothing durable — the pause either
 * happened or did not, and the status comes from a read-back anyway.
 */
export const shopeeUnlistItemPayloadSchema = z
  .object({
    success_list: z
      .array(
        z
          .object({
            item_id: wireInt(),
            unlist: z.boolean().nullable().default(null),
          })
          .passthrough(),
      )
      .default([]),
    failure_list: z
      .array(
        z
          .object({
            item_id: wireInt(),
            failed_reason: z.string().nullable().default(null),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
export type ShopeeUnlistItem = z.infer<typeof shopeeUnlistItemPayloadSchema>;

/** `POST /api/v2/product/unlist_item` — WRAPPED under `response`. */
export const shopeeUnlistItemSchema = wrappedOp(shopeeUnlistItemPayloadSchema);
export type ShopeeUnlistItemResponse = z.infer<typeof shopeeUnlistItemSchema>;

/* ------------------------ get_item_violation_info ------------------------- */

/**
 * One violation detail, on the status side or the deboost side.
 *
 * ⚠️ `fix_deadline_time` and `update_time` are SECONDS ("Empty if no deadline").
 * The link document stores MILLISECONDS; the conversion is the app's.
 *
 * ⚠️ `suggested_category` is declared on the DEBOOST side only by the page, and
 * is declared HERE for both: a doc gap and a doc bug look identical, and
 * `.passthrough()` would hide which one it is.
 */
export const shopeeViolationDetailSchema = z
  .object({
    violation_type: z.string().nullable().default(null),
    violation_reason: z.string().nullable().default(null),
    suggestion: z.string().nullable().default(null),
    /** SECONDS. */
    fix_deadline_time: wireInt().nullable().default(null),
    /** SECONDS. */
    update_time: wireInt().nullable().default(null),
    suggested_category: z
      .array(
        z
          .object({
            category_id: wireInt().nullable().default(null),
            category_name: z.string().nullable().default(null),
          })
          .passthrough(),
      )
      .nullable()
      .default(null),
  })
  .passthrough();
export type ShopeeViolationDetail = z.infer<typeof shopeeViolationDetailSchema>;

/**
 * One row of `get_item_violation_info.response.item_list`.
 *
 * ⚠️ `fail_error` / `fail_message` are IN BAND — a THIRD partial-failure
 * encoding, per ROW. `unlist_item` uses `success_list`/`failure_list`; this page
 * puts the failure on the row itself. There is no generic batch parser here and
 * there must not be one: the caller reconciles by `item_id` and reads
 * `fail_error`.
 *
 * ⚠️ `deboost` is `boolean | string`, like `get_item_base_info`'s: the sandbox
 * answered the STRING `"FALSE"` there (measured 2026-09-16) and a `z.boolean()`
 * refused the whole page. Nothing folds it HERE — the app's fold owns that, and
 * it must handle both spellings.
 *
 * ⚠️ `deboosted_details` is declared beside `deboost_details` because push 18's
 * own sample prints THAT spelling against a `deboost_details` parameter table,
 * and the push's detail objects are byte-identical to this pull's. Both names
 * are declared, NEITHER is folded into the other, and the reader prefers
 * `deboost_details` — a parser that declared only one would silently drop every
 * deboost payload of the other.
 */
export const shopeeItemViolationRowSchema = z
  .object({
    item_id: wireInt(),
    item_name: z.string().nullable().default(null),
    /** Loose, for {@link shopeeItemListRowSchema}'s reason. */
    item_status: z.string().nullable().default(null),
    deboost: z.union([z.boolean(), z.string()]).nullable().default(null),
    item_status_details: z.array(shopeeViolationDetailSchema).nullable().default(null),
    deboost_details: z.array(shopeeViolationDetailSchema).nullable().default(null),
    /** ⚠️ Push 18's SAMPLE spelling. Declared, never folded. */
    deboosted_details: z.array(shopeeViolationDetailSchema).nullable().default(null),
    fail_error: z.string().nullable().default(null),
    fail_message: z.string().nullable().default(null),
  })
  .passthrough();
export type ShopeeItemViolationRow = z.infer<typeof shopeeItemViolationRowSchema>;

/**
 * The inner payload of `get_item_violation_info`.
 *
 * ⚠️ **Both of this page's response samples carry NO `error` key at all** (read
 * 2026-09-17: `{"message": null, "request_id": …, "response": {…}}`), while its
 * Response-params table declares one — and the sandbox probe MEASURED the LIVE
 * body doing exactly that on 2026-09-17 (register 73): the op answered
 * `{message, request_id, response: {item_list: […]}}` and stage 1 refused it
 * with `ShopeeSchemaError campos=["error"]`. The samples were right and the
 * table is the odd one out.
 *
 * ⚠️ **The schemas here are unchanged by that, and must stay unchanged.**
 * {@link shopeeEnvelopeSchema} has no `.default('')` on `error` BY DESIGN — a
 * body carrying neither `error` nor `response` cannot be judged, and defaulting
 * would read it as a success for EVERY operation. The tolerance is the
 * TRANSPORT's and it is per operation (`call.ts`, set on `getItemViolationInfo`
 * alone): an ABSENT `error` reads as `''` only when the body carries a
 * `response` object. Parsing this page's sample through the schema ALONE still
 * fails, and a test pins that.
 *
 * ⚠️ The caller's contract stands regardless, because the op can still fail for
 * every other reason: every call site treats a throw of any class as "no
 * violation detail this time" and proceeds on `get_item_base_info`'s status +
 * deboost.
 *
 * ⚠️ Per-ELEMENT sentinel: the op is batched to 50 and one malformed row must
 * not cost the other 49 — the {@link shopeeItemBaseInfoPayloadSchema} precedent,
 * whose precondition is met here too (the caller already reconciles by
 * `item_id`).
 */
export const shopeeItemViolationInfoPayloadSchema = z
  .object({
    item_list: z.array(shopeeItemViolationRowSchema.nullable().catch(null)).default([]),
  })
  .passthrough();
export type ShopeeItemViolationInfo = z.infer<typeof shopeeItemViolationInfoPayloadSchema>;

/** `GET /api/v2/product/get_item_violation_info` — WRAPPED under `response`. */
export const shopeeItemViolationInfoSchema = wrappedOp(shopeeItemViolationInfoPayloadSchema);
export type ShopeeItemViolationInfoResponse = z.infer<typeof shopeeItemViolationInfoSchema>;

/* ---------------------------- get_channel_list ---------------------------- */

/**
 * One logistics channel of the SHOP, as `get_channel_list` returns it.
 *
 * ⚠️ `size_list[].size_id` is a **STRING** here and an `int32` on
 * `add_item.logistic_info[].size_id` — same concept, two types, one call apart.
 * It is NEVER `wireInt()`: a `"0"` that round-tripped as `0` would send a size
 * the seller did not pick. The conversion (and the refusal when the value is not
 * a safe integer) belongs to the caller that builds the item's logistics.
 *
 * ⚠️ `weight_limit` / `volume_limit`: "If the value is 0 or null, that means
 * there is no limit." `0` is NOT a bound. Nothing here folds it; the caller does.
 *
 * ⚠️ `fee_type` is a LOOSE string — {@link SHOPEE_LOGISTICS_FEE_TYPE} names the
 * four documented values for the caller's branch, and an unknown value costs ONE
 * channel, never the page.
 *
 * ⚠️ `mask_channel_id: 0` means this IS a checkout (masked) channel; non-zero
 * means it is a fulfillment channel hanging off one.
 *
 * ⚠️ `compulsory_channel`: "If the value is true, at least one such channel must
 * be enabled." `channel_relation_rules` carries the auto-enable and
 * block-on-disable sets.
 *
 * ⚠️ There is **NO `preferred` field** on this page — the response table has no
 * such name and neither does its sample. It survives only in a legacy DTO, and
 * declaring it here would resurrect a phantom the caller could then branch on.
 *
 * ⚠️ `auto_call_driver_setting.preparation_time_limit` is
 * `min_preparation_time` / `max_preparation_time`, NOT `{min,max}`.
 */
/**
 * The relation rules of ONE channel — `announcement 1394`'s related-enable /
 * dependent-block sets. `related_disabled_channels` is NOT on the page: the live
 * sandbox body carries it (measured 2026-09-17), so it is declared rather than
 * left to `.passthrough()`, where a caller could not read it typed.
 */
export const shopeeChannelRelationRulesSchema = z
  .object({
    related_enabled_channels: z.array(wireInt()).nullable().default(null),
    related_disabled_channels: z.array(wireInt()).nullable().default(null),
    related_dependent_block_channels: z.array(wireInt()).nullable().default(null),
  })
  .passthrough();
export type ShopeeChannelRelationRules = z.infer<typeof shopeeChannelRelationRulesSchema>;

export const shopeeLogisticsChannelSchema = z
  .object({
    logistics_channel_id: wireInt(),
    logistics_channel_name: z.string().nullable().default(null),
    cod_enabled: z.boolean().nullable().default(null),
    /** SHOP level. A channel not enabled here cannot sensibly be enabled on an item. */
    enabled: z.boolean().nullable().default(null),
    fee_type: z.string().nullable().default(null),
    /** Only for `fee_type: SIZE_SELECTION`. */
    size_list: z
      .array(
        z
          .object({
            /** ⚠️ A STRING. Never `wireInt()` — see the block comment. */
            size_id: z.string().nullable().default(null),
            name: z.string().nullable().default(null),
            default_price: wireNumber().nullable().default(null),
          })
          .passthrough(),
      )
      .nullable()
      .default(null),
    weight_limit: z
      .object({
        item_max_weight: wireNumber().nullable().default(null),
        item_min_weight: wireNumber().nullable().default(null),
      })
      .passthrough()
      .nullable()
      .default(null),
    item_max_dimension: z
      .object({
        height: wireNumber().nullable().default(null),
        width: wireNumber().nullable().default(null),
        length: wireNumber().nullable().default(null),
        /** Sample `cm`, and `UNKNOWN` on a channel with no limit. Carried, never assumed. */
        unit: z.string().nullable().default(null),
        dimension_sum: wireNumber().nullable().default(null),
      })
      .passthrough()
      .nullable()
      .default(null),
    volume_limit: z
      .object({
        item_max_volume: wireNumber().nullable().default(null),
        item_min_volume: wireNumber().nullable().default(null),
      })
      .passthrough()
      .nullable()
      .default(null),
    logistics_description: z.string().nullable().default(null),
    /** "If true, sellers cannot close this channel." */
    force_enable: z.boolean().nullable().default(null),
    mask_channel_id: wireInt().nullable().default(null),
    block_seller_cover_shipping_fee: z.boolean().nullable().default(null),
    support_cross_border: z.boolean().nullable().default(null),
    seller_logistic_has_configuration: z.boolean().nullable().default(null),
    logistics_capability: z
      .object({ seller_logistics: z.boolean().nullable().default(null) })
      .passthrough()
      .nullable()
      .default(null),
    preprint: z.boolean().nullable().default(null),
    /** `instant` | `same_day` | null. */
    service_type_identifier: z.string().nullable().default(null),
    auto_call_driver_setting: z
      .object({
        auto_call_driver_eligible: z.boolean().nullable().default(null),
        auto_call_driver_enabled: z.boolean().nullable().default(null),
        /** MINUTES. */
        preparation_time: wireInt().nullable().default(null),
        preparation_time_limit: z
          .object({
            min_preparation_time: wireInt().nullable().default(null),
            max_preparation_time: wireInt().nullable().default(null),
          })
          .passthrough()
          .nullable()
          .default(null),
      })
      .passthrough()
      .nullable()
      .default(null),
    support_pause: z.boolean().nullable().default(null),
    compulsory_channel: z.boolean().nullable().default(null),
    /**
     * ⚠️ TWO shapes, both declared, neither folded (the `gtin_limit` technique).
     * The page's response table declares `object[]`; the LIVE sandbox body
     * (measured 2026-09-17, step-11 probe) carries ONE object — with an
     * UNDOCUMENTED third key, `related_disabled_channels`. A schema that only
     * knew the table's array turned every real channel into the `null`
     * sentinel below, and a whole-shop logistics build saw zero channels. The
     * caller normalises to a list; the package records what arrived.
     */
    channel_relation_rules: z
      .union([shopeeChannelRelationRulesSchema, z.array(shopeeChannelRelationRulesSchema)])
      .nullable()
      .default(null),
  })
  .passthrough();
export type ShopeeLogisticsChannel = z.infer<typeof shopeeLogisticsChannelSchema>;

/**
 * The inner payload of `get_channel_list`.
 *
 * ⚠️ Per-element sentinel: the list is whole-SHOP, and one unreadable channel
 * must not cost the logistics build of every publish.
 */
export const shopeeChannelListPayloadSchema = z
  .object({
    logistics_channel_list: z
      .array(shopeeLogisticsChannelSchema.nullable().catch(null))
      .default([]),
  })
  .passthrough();
export type ShopeeChannelList = z.infer<typeof shopeeChannelListPayloadSchema>;

/** `GET /api/v2/logistics/get_channel_list` — WRAPPED under `response`. */
export const shopeeChannelListSchema = wrappedOp(shopeeChannelListPayloadSchema);
export type ShopeeChannelListResponse = z.infer<typeof shopeeChannelListSchema>;

/* ----------------------------- upload_image ------------------------------- */

/** One uploaded image: its id and one URL per region. */
export const shopeeImageInfoSchema = z
  .object({
    image_id: z.string().nullable().default(null),
    image_url_list: z
      .array(
        z
          .object({
            image_url_region: z.string().nullable().default(null),
            image_url: z.string().nullable().default(null),
          })
          .passthrough(),
      )
      .nullable()
      .default(null),
  })
  .passthrough();
export type ShopeeImageInfo = z.infer<typeof shopeeImageInfoSchema>;

/**
 * `upload_image`'s payload — BOTH documented positions, and NEITHER is preferred
 * here.
 *
 * `image_info` is the single-file convenience field; `image_info_list[]` is the
 * multi-file form and carries a PER-INDEX `error`/`message`, so a 200 can
 * contain a per-file failure. Both travel to the caller, which is the only layer
 * that can log WHICH one arrived — the `gtin_limit` technique.
 *
 * ⚠️ `image_id` is nullable even though it is the only field anyone wants: a
 * per-index failure row carries `error` and an `image_info` with nothing in it.
 * Requiring it here would refuse the body; the caller turns "no id" into a
 * per-photo failure and keeps the other photos.
 */
export const shopeeUploadImagePayloadSchema = z
  .object({
    image_info: shopeeImageInfoSchema.nullable().default(null),
    image_info_list: z
      .array(
        z
          .object({
            /** The INDEX of the image in the request, not an id. */
            id: wireInt().nullable().default(null),
            error: z.string().nullable().default(null),
            message: z.string().nullable().default(null),
            image_info: shopeeImageInfoSchema.nullable().default(null),
          })
          .passthrough(),
      )
      .nullable()
      .default(null),
  })
  .passthrough();
export type ShopeeUploadImage = z.infer<typeof shopeeUploadImagePayloadSchema>;

/** `POST /api/v2/media_space/upload_image` — WRAPPED under `response`. */
export const shopeeUploadImageSchema = wrappedOp(shopeeUploadImagePayloadSchema);
export type ShopeeUploadImageResponse = z.infer<typeof shopeeUploadImageSchema>;

/* -------------------------------------------------------------------------- */
/*                         The stock sync (step 12)                           */
/* -------------------------------------------------------------------------- */

/* ------------------------------ update_stock ------------------------------ */

/**
 * `update_stock`'s payload — the FOURTH partial-failure encoding in the Product
 * module, and the only one whose failure and its detail can arrive TOGETHER.
 *
 * ⚠️ `error` and the lists COEXIST here. The page's own error list carries
 * `error_busi_update_stock_failed` — "Update stock failed, please check
 * failure_list for detailed reason" — so the envelope says the call failed while
 * `response.failure_list` says WHICH models did. The transport throws on any
 * non-empty `error`, so the body would ordinarily be discarded before anyone
 * could read that attribution; `call.ts` keeps it for this operation alone and
 * the sender narrows on the subclass that carries it. NOTHING here tolerates the
 * error: this schema parses a failing body exactly as it parses a succeeding
 * one, and judging success stays the transport's job.
 *
 * ⚠️ Both arrays `.default([])` rather than `.nullable()`, the
 * {@link shopeeUnlistItemPayloadSchema} rule: an absent `failure_list` means
 * "nothing failed", and a `null` would make every caller write `?? []` — one of
 * which will forget. On this page, forgetting reads as "no model was refused",
 * which is the silent half of a partial write.
 *
 * ⚠️ `success_list[].stock` and `.location_id` are "returned in pairs" and only
 * "if seller stock is used in the request", so both are nullable: a body that
 * confirms the models without echoing the numbers is a documented success, not a
 * malformed one. Whether those echoed numbers are the REQUEST or the shop's
 * stored state is UNVERIFIED — the sandbox probe settles it, and nothing here
 * assumes either.
 *
 * ⚠️ NO per-element `.catch(null)`: each row is two or three scalars keyed on
 * `model_id`, and a sentinel row with no `model_id` is unreconcilable — the
 * {@link shopeeUnlistItemPayloadSchema} argument, with the same conclusion.
 */
export const shopeeUpdateStockPayloadSchema = z
  .object({
    failure_list: z
      .array(
        z
          .object({
            model_id: wireInt(),
            failed_reason: z.string().nullable().default(null),
          })
          .passthrough(),
      )
      .default([]),
    success_list: z
      .array(
        z
          .object({
            model_id: wireInt(),
            /** "This field and the stock field are returned in pairs". */
            location_id: z.string().nullable().default(null),
            /** "returned if seller stock is used in the request". */
            stock: wireInt().nullable().default(null),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
export type ShopeeUpdateStock = z.infer<typeof shopeeUpdateStockPayloadSchema>;

/**
 * `POST /api/v2/product/update_stock` — WRAPPED under `response`.
 *
 * ⚠️ Its client method answers THIS, the whole envelope, not the unwrapped
 * payload: a write's `warning` is a partial-failure channel and the caller has
 * to see it. The three READS of step 12 unwrap; this write does not.
 */
export const shopeeUpdateStockSchema = wrappedOp(shopeeUpdateStockPayloadSchema);
export type ShopeeUpdateStockResponse = z.infer<typeof shopeeUpdateStockSchema>;

/* ------------------------- update_price (step 13) ------------------------- */

/**
 * `update_price.price_list`: "Length should be between 1 to 50."
 *
 * ⚠️ Its OWN constant, and deliberately NOT {@link SHOPEE_UPDATE_STOCK_MAX_MODELS}
 * even though both read 50 today — the rule {@link SHOPEE_MODEL_MAX_PER_ITEM}'s
 * docblock states. This one bounds how many models fit in ONE price write; that
 * one bounds ONE stock write. Two pages state them, and a probe that moves one
 * must not move the other.
 */
export const SHOPEE_UPDATE_PRICE_MAX_MODELS = 50;

/**
 * `update_price`'s payload (`api v2.product.update_price`) — the per-model
 * result of setting the shelf price of ONE item.
 *
 * ⚠️ The documented partial failure is a SUCCESS envelope: the page's response
 * sample carries `error: ""` with BOTH lists populated, and — unlike
 * {@link shopeeUpdateStockPayloadSchema} — this page's error list has no "check
 * failure_list" code, so nothing documents a non-empty `error` arriving WITH the
 * lists. Step 12's probe P9 measured the stock twin answering a mixed batch that
 * way (HTTP 200, `error: ''`, both lists); for price the same shape is
 * UNVERIFIED until step 13's probe P9/P10 runs it. Whoever writes the result
 * back reads BOTH lists, never the absence of a throw.
 *
 * ⚠️ Both arrays `.default([])` rather than `.nullable()`, for
 * {@link shopeeUpdateStockPayloadSchema}'s reason: an absent `failure_list` means
 * "nothing failed", and a `null` would make every caller write `?? []` — one of
 * which will forget, and forgetting reads as "no model was refused".
 *
 * ⚠️ `failed_reason` is FREE TEXT. The page enumerates no values (its sample
 * says `"fail"`; the stock sibling measured `"model ID not exist in sku"`), so it
 * is classified by the app and stored verbatim — never matched here.
 *
 * ⚠️ `success_list[].original_price` is a FLOAT in the listing currency's MAJOR
 * units — two decimals in BR and in SG, the page verbatim — read by
 * `wireNumber()`, never `wireInt()`: a quoted `"12.5"` is a price, and an integer
 * reader would fail the whole page on the first centavo. Nullable, because a
 * confirmation without the number is a documented success. Whether the echo is
 * the REQUEST or the STORED value is UNVERIFIED — the probe settles it, and
 * nothing here assumes either.
 *
 * ⚠️ `model_id` is `0` for a no-model item — the page's own echo keys that row
 * as `0` — so it is read as an integer with no positivity check. NO per-element
 * `.catch(null)`: a row with no `model_id` is unreconcilable (the
 * {@link shopeeUnlistItemPayloadSchema} argument).
 */
export const shopeeUpdatePricePayloadSchema = z
  .object({
    failure_list: z
      .array(
        z
          .object({
            model_id: wireInt(),
            /** FREE TEXT — classified by the app, stored verbatim. */
            failed_reason: z.string().nullable().default(null),
          })
          .passthrough(),
      )
      .default([]),
    success_list: z
      .array(
        z
          .object({
            model_id: wireInt(),
            /** The echo — a FLOAT in major units; request vs stored is UNVERIFIED. */
            original_price: wireNumber().nullable().default(null),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
export type ShopeeUpdatePrice = z.infer<typeof shopeeUpdatePricePayloadSchema>;

/**
 * `POST /api/v2/product/update_price` — WRAPPED under `response`.
 *
 * ⚠️ Its client method answers THIS, the whole envelope, not the unwrapped
 * payload — {@link shopeeUpdateStockSchema}'s rule: a write's `warning` is a
 * partial-failure channel and the caller has to see it.
 */
export const shopeeUpdatePriceSchema = wrappedOp(shopeeUpdatePricePayloadSchema);
export type ShopeeUpdatePriceResponse = z.infer<typeof shopeeUpdatePriceSchema>;

/* --------------------------- get_item_promotion --------------------------- */

/**
 * One promotion of one model, as `get_item_promotion` reports it.
 *
 * ⚠️ `promotion_id` is `uint64` on the page and therefore an OPAQUE STRING here
 * ({@link shopeeIdOpaco}); a `wireInt()` would fail the whole page on the first
 * id above 2^53.
 *
 * ⚠️ `start_time` / `end_time` are SECONDS. Every Shopee document in this
 * channel stores MILLISECONDS, and the conversion belongs to the app.
 *
 * ⚠️ The stock a promotion holds back arrives in TWO documented positions, and
 * BOTH are declared. The page's response table renders `summary_info` and
 * `total_reserved_stock` as SIBLINGS under `promotion_stock_info_v2`; its own
 * JSON sample nests the number inside `summary_info`. This is the `gtin_limit`
 * situation — both positions travel to the caller and
 * {@link reservadoDaPromocao} is the ONE reader that decides which wins. Folding
 * them here would hide which one a live shop actually sends, which is still an
 * open probe question.
 *
 * ⚠️ `promotion_price_info` is carried and never read by this step — the floor
 * is about quantities, not prices. Declared rather than left to
 * `.passthrough()`, so a later price step can reach it typed.
 *
 * ⚠️ `promotion_type` and `promotion_staging` are LOOSE strings
 * ({@link SHOPEE_PROMOTION_STAGING} names the two documented staging values): a
 * new promotion kind must cost one branch, never the page.
 */
export const shopeePromocaoDeItemSchema = z
  .object({
    promotion_type: z.string().nullable().default(null),
    promotion_id: shopeeIdOpaco(),
    model_id: wireInt().nullable().default(null),
    /** SECONDS. */
    start_time: wireInt().nullable().default(null),
    /** SECONDS. */
    end_time: wireInt().nullable().default(null),
    promotion_price_info: z
      .array(z.object({ promotion_price: wireNumber().nullable().default(null) }).passthrough())
      .nullable()
      .default(null),
    /** `ongoing` | `upcoming` — LOOSE. */
    promotion_staging: z.string().nullable().default(null),
    promotion_stock_info_v2: z
      .object({
        /** The SAMPLE's position. */
        summary_info: z
          .object({ total_reserved_stock: wireInt().nullable().default(null) })
          .passthrough()
          .nullable()
          .default(null),
        /** ⚠️ The response TABLE's position, one level up. Declared, never folded. */
        total_reserved_stock: wireInt().nullable().default(null),
      })
      .passthrough()
      .nullable()
      .default(null),
  })
  .passthrough();
export type ShopeePromocaoDeItem = z.infer<typeof shopeePromocaoDeItemSchema>;

/**
 * The stock a promotion is holding back on one model — the NESTED position
 * first, then the sibling one level up, else `null`.
 *
 * ⚠️ ONE reader, because the page states the field twice and the two positions
 * mean the same thing. `null` is "the page said nothing", never zero: a caller
 * that read a missing value as `0` would compute a floor of zero and conclude
 * every write is safe, which is the one direction that oversells.
 *
 * ⚠️ `??`, not `||`: a legitimate `0` is falsy, and on this field `0` is the
 * common answer (a promotion holding nothing back). `||` would fall through from
 * a nested `0` to the sibling and then to `null`.
 */
export function reservadoDaPromocao(p: ShopeePromocaoDeItem): number | null {
  return (
    p.promotion_stock_info_v2?.summary_info?.total_reserved_stock ??
    p.promotion_stock_info_v2?.total_reserved_stock ??
    null
  );
}

/**
 * The inner payload of `get_item_promotion` — success and failure per ITEM.
 *
 * ⚠️ Both lists `.default([])`, {@link shopeeUpdateStockPayloadSchema}'s reason.
 *
 * ⚠️ `promotion` is `.default([])` too: an item with no promotion is the
 * ordinary case, and it must read as an empty list rather than as an absence a
 * caller could mistake for "unknown".
 */
export const shopeeItemPromotionPayloadSchema = z
  .object({
    success_list: z
      .array(
        z
          .object({
            item_id: wireInt(),
            promotion: z.array(shopeePromocaoDeItemSchema).default([]),
          })
          .passthrough(),
      )
      .default([]),
    failure_list: z
      .array(
        z
          .object({
            item_id: wireInt(),
            failed_reason: z.string().nullable().default(null),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
export type ShopeeItemPromotionPayload = z.infer<typeof shopeeItemPromotionPayloadSchema>;

/** `GET /api/v2/product/get_item_promotion` — WRAPPED under `response`. */
export const shopeeItemPromotionSchema = wrappedOp(shopeeItemPromotionPayloadSchema);
export type ShopeeItemPromotionResponse = z.infer<typeof shopeeItemPromotionSchema>;

/* ------------------------- get_shop_holiday_mode -------------------------- */

/**
 * The inner payload of `get_shop_holiday_mode`.
 *
 * ⚠️ WRAPPED under `response`, NOT flat — read off the cached page on
 * 2026-09-21: its Response params declare `response` as an object with these
 * seven children, and its response sample prints them nested inside it. The
 * step-12 seam described this operation as FLAT; the page is the arbiter and
 * says otherwise, so its client method unwraps like the other two reads here.
 *
 * ⚠️ The page declares NO `warning` field at all — the only step-12 operation
 * that does not. Nothing is lost: the envelope defaults it to `null`, so a body
 * that omits it parses and a body that grows one is carried.
 *
 * ⚠️ `holiday_mode_type` means nothing unless `holiday_mode_on` is true ("only
 * when holiday_mode_on = true will the holiday_mode_type work"), and its
 * polarity reads backwards — {@link SHOPEE_HOLIDAY_MODE_TYPE} names it. Whether
 * a PARTIAL holiday actually refuses a stock write is UNVERIFIED; declaring the
 * field is what makes the question askable.
 *
 * ⚠️ The three time fields are SECONDS, like every other Shopee timestamp.
 *
 * ⚠️ `debug_msg` is the seventh field and is declared rather than left to
 * `.passthrough()`: it is the only place the page explains a body that is
 * otherwise empty, and a caller cannot log what it cannot reach typed.
 */
export const shopeeShopHolidayModePayloadSchema = z
  .object({
    holiday_mode_on: z.boolean().nullable().default(null),
    /** SECONDS — "The last time the holiday mode was modifies" [sic]. */
    holiday_mode_mtime: wireInt().nullable().default(null),
    /** 1 PARTIAL · 0 FULL. See {@link SHOPEE_HOLIDAY_MODE_TYPE}. */
    holiday_mode_type: wireInt().nullable().default(null),
    /** SECONDS. */
    holiday_mode_start_time: wireInt().nullable().default(null),
    /** SECONDS. */
    holiday_mode_end_time: wireInt().nullable().default(null),
    holiday_mode_description: z.string().nullable().default(null),
    debug_msg: z.string().nullable().default(null),
  })
  .passthrough();
export type ShopeeShopHolidayMode = z.infer<typeof shopeeShopHolidayModePayloadSchema>;

/** `GET /api/v2/shop/get_shop_holiday_mode` — WRAPPED under `response`. */
export const shopeeShopHolidayModeSchema = wrappedOp(shopeeShopHolidayModePayloadSchema);
export type ShopeeShopHolidayModeResponse = z.infer<typeof shopeeShopHolidayModeSchema>;

/* -------------------------- get_warehouse_detail -------------------------- */

/**
 * One warehouse address of the shop.
 *
 * ⚠️ `location_id` is a SHORT OPAQUE STRING (`IDZ`, `SGZ`) and is NEVER
 * `wireInt()` — "Different location_ids represent that your addresses are in
 * different item stocks". It is the value a stock write echoes back, and the one
 * a multi-warehouse write has to carry for EVERY location in a single call.
 *
 * ⚠️ `holiday_mode_state` is per ADDRESS and has four values — "0: not in
 * holiday mode 1: holiday mode active 2: holiday mode is turning of [sic] 3:
 * holiday mode is turning on". It is a different fact from the SHOP's holiday
 * mode; which of the four refuses a stock write is UNVERIFIED.
 *
 * The rest of the address (`state`, `city`, `district`, `town`, `address`,
 * `zipcode`, `state_code`) is deliberately left to `.passthrough()`: nothing in
 * this channel reads a seller's postal address, and declaring it would invite a
 * reader.
 */
export const shopeeWarehouseSchema = z
  .object({
    warehouse_id: wireInt(),
    warehouse_name: z.string().nullable().default(null),
    /** 1 pickup · 2 return. See {@link SHOPEE_WAREHOUSE_TYPE}. */
    warehouse_type: wireInt().nullable().default(null),
    /** ⚠️ A STRING. See the block comment. */
    location_id: z.string().nullable().default(null),
    address_id: wireInt().nullable().default(null),
    region: z.string().nullable().default(null),
    /** 0 none · 1 active · 2 turning OFF · 3 turning ON. */
    holiday_mode_state: wireInt().nullable().default(null),
  })
  .passthrough();
export type ShopeeWarehouse = z.infer<typeof shopeeWarehouseSchema>;

/**
 * `GET /api/v2/shop/get_warehouse_detail` — WRAPPED, and its payload is a
 * top-level ARRAY.
 *
 * ⚠️ The only operation in this package whose `response` is an array rather than
 * an object, and the two are NOT interchangeable: the same body under an object
 * payload fails, which a near-miss pins. Which shape an operation has is the
 * schema's to state — the {@link dataOp} rule — so no caller has to know.
 *
 * ⚠️ Its ordinary answer for a normal shop is an ERROR, not a list:
 * {@link SHOPEE_WAREHOUSE_SEM_ACESSO}. That fold lives in the client method, so
 * that no app string-matches a wire code.
 *
 * ⚠️ The type of the FOLD — the `lista` / `sem-multi-armazem` union the method
 * answers — is `api.ts`'s and is deliberately NOT declared here, so the two
 * names cannot collide through the package's wildcard re-exports.
 */
export const shopeeWarehouseDetailSchema = wrappedOp(z.array(shopeeWarehouseSchema));
export type ShopeeWarehouseDetailResponse = z.infer<typeof shopeeWarehouseDetailSchema>;
