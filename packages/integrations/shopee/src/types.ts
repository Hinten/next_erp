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
 * ⚠️ **The `error === ''` invariant has exactly ONE exception, and it is
 * per-operation.** The two lost-push pages CONTRADICT THEMSELVES: their
 * parameter tables sample `error` as `""` ("Empty if no error happened") while
 * their rendered response samples print `"-"` for `error`, `message` AND
 * `warning`. Every other cached page — `get_app_push_config` included — samples
 * `""`. So `-` is a doc-authoring placeholder on two pages, not a protocol
 * variant, and it is tolerated ONLY on those two operations, through
 * `ShopeeCallParams.emptyErrorAliases` in `call.ts`. The schemas here are
 * unchanged by it: `error` is still `z.string()` with no default, and `'-'`
 * still parses as the string `'-'`.
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
 */
export const shopeeLostPushEntrySchema = z
  .object({
    shop_id: wireInt().nullable().default(null),
    code: wireInt(),
    timestamp: wireInt(),
    data: z.string(),
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
