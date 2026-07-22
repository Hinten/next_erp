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

/**
 * One embedded item/variation attribute (`attributes[]` /
 * `attribute_combinations[]`). Every field is optional so a single odd entry
 * (or ML drift) never fails the whole item parse; the import mapper filters by
 * `id` (`SELLER_SKU`, `WEIGHT`, `SELLER_PACKAGE_*`, `SIZE`, `COLOR`…).
 */
export const itemAttributeSchema = z
  .object({
    id: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    value_id: z.string().nullable().optional(),
    value_name: z.string().nullable().optional(),
    attribute_group_id: z.string().nullable().optional(),
    attribute_group_name: z.string().nullable().optional(),
    unit_id: z.string().nullable().optional(),
  })
  .passthrough();
export type MlItemAttribute = z.infer<typeof itemAttributeSchema>;

/** One item picture (`pictures[]`). `secure_url` carries a size-code suffix. */
export const itemPictureSchema = z
  .object({
    id: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    secure_url: z.string().nullable().optional(),
    size: z.string().nullable().optional(),
    max_size: z.string().nullable().optional(),
  })
  .passthrough();
export type MlItemPicture = z.infer<typeof itemPictureSchema>;

/** A variation inside an item (`variations[]`). */
export const itemVariationSchema = z
  .object({
    // ML has sent numeric and (rarely) string ids over time — accept both.
    id: z.union([z.number(), z.string()]).nullable().optional(),
    available_quantity: z.number().nullable().optional(),
    price: z.number().nullable().optional(),
    seller_custom_field: z.string().nullable().optional(),
    /** User-Products model: each variation is its own item. */
    item_relations: z.array(z.unknown()).nullable().optional(),
    attribute_combinations: z.array(itemAttributeSchema).nullable().optional(),
    attributes: z.array(itemAttributeSchema).nullable().optional(),
    picture_ids: z.array(z.string()).nullable().optional(),
  })
  .passthrough();
export type MlItemVariation = z.infer<typeof itemVariationSchema>;

/** `GET /items/{id}` (and the `POST/PUT /items` response) — the listing. */
export const itemSchema = z
  .object({
    id: z.string(),
    title: z.string().nullable().optional(),
    /** User-Products model — ML titles the listing from the family. */
    family_name: z.string().nullable().optional(),
    /** User-Products model — groups sibling items (one MLB item per variation, #521). */
    family_id: z.union([z.string(), z.number()]).nullable().optional(),
    user_product_id: z.string().nullable().optional(),
    /** User-Products model — the variation identity lives at the item ROOT (no `variations[]`). */
    attribute_combinations: z.array(itemAttributeSchema).nullable().optional(),
    category_id: z.string().nullable().optional(),
    price: z.number().nullable().optional(),
    /** Normal price (promo/`price` may be lower); import uses `base_price ?? price`. */
    base_price: z.number().nullable().optional(),
    available_quantity: z.number().nullable().optional(),
    condition: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    /** ML sub-status (`deleted`/`suspended`/`freezed`/`out_of_stock`…) — bot filtering. */
    sub_status: z.array(z.string()).nullable().optional(),
    listing_type_id: z.string().nullable().optional(),
    seller_id: z.number().int().nullable().optional(),
    seller_custom_field: z.string().nullable().optional(),
    permalink: z.string().nullable().optional(),
    date_created: z.string().nullable().optional(),
    video_id: z.string().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
    shipping: z
      .object({ free_shipping: z.boolean().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    attributes: z.array(itemAttributeSchema).nullable().optional(),
    pictures: z.array(itemPictureSchema).nullable().optional(),
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

/** `GET /categories/{id}` — one category node. */
export const categorySchema = z
  .object({
    id: z.string(),
    name: z.string().nullable().optional(),
    path_from_root: z
      .array(z.object({ id: z.string(), name: z.string().nullable().optional() }).passthrough())
      .nullable()
      .optional(),
    settings: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();
export type MlCategory = z.infer<typeof categorySchema>;

/** One entry of `GET /categories/{id}/attributes`. */
export const categoryAttributeSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable().optional(),
    value_type: z.string().nullable().optional(),
    values: z
      .array(
        z
          .object({ id: z.string().nullable().optional(), name: z.string().nullable().optional() })
          .passthrough(),
      )
      .nullable()
      .optional(),
    tags: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();
export const categoryAttributesSchema = z.array(categoryAttributeSchema);
export type MlCategoryAttribute = z.infer<typeof categoryAttributeSchema>;

/** One entry of `GET /sites/MLB/domain_discovery/search?q=` (category suggestion). */
export const domainDiscoverySchema = z.array(
  z
    .object({
      domain_id: z.string().nullable().optional(),
      domain_name: z.string().nullable().optional(),
      category_id: z.string(),
      category_name: z.string().nullable().optional(),
      attributes: z.array(z.unknown()).nullable().optional(),
    })
    .passthrough(),
);
export type MlDomainDiscovery = z.infer<typeof domainDiscoverySchema>;

/** `POST /pictures/items/upload` — the uploaded picture's ML id. */
export const pictureUploadSchema = z
  .object({
    id: z.string(),
    variations: z.array(z.unknown()).nullable().optional(),
  })
  .passthrough();
export type MlPictureUpload = z.infer<typeof pictureUploadSchema>;

/** `GET/POST/PUT /items/{id}/description` — plain-text description. */
export const itemDescriptionSchema = z
  .object({
    plain_text: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    last_updated: z.string().nullable().optional(),
  })
  .passthrough();
export type MlItemDescription = z.infer<typeof itemDescriptionSchema>;

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

/* --------------------- User-Products family fan-out (#521) --------------------- */

/**
 * `GET /sites/{siteId}/user-products-families/{familyId}` — the sibling
 * User-Product ids (`UPtin…`) of a family, keyed by `user_products_ids`
 * (legacy `providers/importacao.dart:174`: `familySearch['user_products_ids']`).
 */
export const userProductFamilySchema = z
  .object({
    user_products_ids: z.array(z.string()).default([]),
  })
  .passthrough();
export type MlUserProductFamily = z.infer<typeof userProductFamilySchema>;

/**
 * `GET /users/{sellerId}/items/search?user_product_id=<csv>` — the MLB item
 * ids for a batch of User-Product ids, keyed by `results` (legacy
 * `providers/importacao.dart:179`: `mlbIdSearch['results']`).
 */
export const userProductItemsSearchSchema = z
  .object({
    results: z.array(z.string()).default([]),
  })
  .passthrough();
export type MlUserProductItemsSearch = z.infer<typeof userProductItemsSearchSchema>;

/* --------------------- Mass import seller scan (#621) --------------------- */

/**
 * `GET /users/{sellerId}/items/search?search_type=scan[&scroll_id=]` — the
 * seller's full listing set, one page (up to ~100 ids) per call. Keyed by
 * `results` (MLB item ids) + `scroll_id` (legacy `importacao.dart:119-188`:
 * `resultado['results']` / `resultado['scroll_id']`); the caller stops paging
 * once `results` is empty OR `scroll_id` comes back absent/empty — there is no
 * `limit` param on this endpoint (unlike `searchItemsByUserProduct`).
 */
export const sellerItemsScanSchema = z
  .object({
    scroll_id: z.string().nullable().optional(),
    results: z.array(z.string()).default([]),
    paging: z
      .object({ total: z.number().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type MlSellerItemsScan = z.infer<typeof sellerItemsScanSchema>;

/* --------------------- User-Products migration (#441) --------------------- */

/**
 * One entry of `GET /items/{id}/migration_live_listing` — only the two fields
 * the migration handler consumes (legacy `tasks.dart:871-1036`):
 * `new_item_id` (the new User-Products member's MLB item id) and
 * `variation_id` (the OLD numeric legacy variation id it replaces). ML has
 * sent both as string and number over time — accept either.
 */
export const migrationNewItemSchema = z
  .object({
    new_item_id: z.union([z.string(), z.number()]).nullable().optional(),
    variation_id: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .passthrough();
export type MlMigrationNewItem = z.infer<typeof migrationNewItemSchema>;

/**
 * `GET /items/{id}/migration_live_listing` — the new User-Products items a
 * legacy `variations[]` listing was migrated to, keyed by `new_items`
 * (legacy `tasks.dart:871-1036`).
 */
export const migrationLiveListingSchema = z
  .object({
    new_items: z.array(migrationNewItemSchema).default([]),
  })
  .passthrough();
export type MlMigrationLiveListing = z.infer<typeof migrationLiveListingSchema>;

/* ------------------------------ Size charts ------------------------------ */

/**
 * `GET /domains/{id}/technical_specs` and the `?section=grids` POST variant —
 * the spec tree the chart-cadastro UI renders (groups → components →
 * attributes with tags like `grid_template_required` / `grid_filter` /
 * `main_attribute_candidate`). Deliberately near-opaque: the shape is deep,
 * ML-owned and consumed by the UI, so every level is passthrough.
 */
export const technicalSpecsSchema = z
  .object({
    attributes: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
    groups: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  })
  .passthrough();
export type MlTechnicalSpecs = z.infer<typeof technicalSpecsSchema>;

/** One row of a chart API response (`rows[].id` = `'<chartId>:<n>'`). */
export const sizeChartApiRowSchema = z
  .object({
    id: z.union([z.string(), z.number()]).nullable().optional(),
    attributes: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  })
  .passthrough();

/**
 * `POST /catalog/charts` / `PUT /catalog/charts/{id}` / row endpoints — the
 * full chart the API echoes back (create AND row calls return the whole
 * chart; the legacy write-back reads `id`, `main_attribute_id` and the
 * per-index `rows[].id`).
 */
export const sizeChartApiSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    main_attribute_id: z.string().nullable().optional(),
    rows: z.array(sizeChartApiRowSchema).nullable().optional(),
  })
  .passthrough();
export type MlSizeChartApi = z.infer<typeof sizeChartApiSchema>;

/** `GET /catalog/charts/{site}/configurations/active_domains`. */
export const activeChartDomainsSchema = z
  .object({
    domains: z.array(z.object({ domain_id: z.string() }).passthrough()).default([]),
  })
  .passthrough();
export type MlActiveChartDomains = z.infer<typeof activeChartDomainsSchema>;

/** `GET /catalog_domains/{id}` — human label for the domain picker. */
export const catalogDomainSchema = z
  .object({
    id: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
  })
  .passthrough();
export type MlCatalogDomain = z.infer<typeof catalogDomainSchema>;
