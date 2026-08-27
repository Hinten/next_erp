import { z } from 'zod';

import { wireInt, wireNumber } from '@delfrance/core/wire';

/**
 * Zod shapes for Mercado Livre payloads (OAuth + REST resources). Tolerant by
 * design (user point #3 — ML silently changes fields): unknown keys ride through
 * `.passthrough()`, response fields are mostly `.nullable().optional()`, and only
 * the identifiers we actually key on are required. A field ML renames or drops
 * therefore degrades gracefully instead of throwing.
 *
 * ⚠️ **Every numeric field goes through `wireNumber()` / `wireInt()`** (`@delfrance/core/wire`),
 * never a bare `z.number()`, because ML is inconsistent about whether a number
 * arrives as a JSON number or as a quoted string — and a `z.number()` that meets
 * a string rejects the WHOLE resource, not just that field. #1087 is the worked
 * example: one quoted `order_id` on `GET /collections/{id}` stopped a payment
 * importing at all. The helper carries the autopsy and the reason
 * `z.coerce.number()` is not the answer. Enforced by
 * `packages/config-eslint/rules/integration-response-numbers-tolerant.test.js`.
 *
 * ⚠️ The `z.union([z.number(), z.string()])` fields are the OLDER, per-field form
 * of the same tolerance and stay as they are. They are not all numeric —
 * `mlShipmentAddressSchema.street_number` really does carry `'S/N'` and `'123-A'`
 * — and the id ones exist because every consumer compares them as STRINGS.
 * Do not "unify" them onto the helper.
 *
 * ⚠️ **This file holds RESPONSE schemas only** — there is not one request schema
 * in it. That is what makes the blanket tolerance above safe: widening a shape
 * here can never make this ERP SEND a coerced value to ML.
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
    expires_in: wireNumber(),
    scope: z.string().nullable().optional(),
    user_id: wireInt().nullable().optional(),
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
    status: wireNumber().optional(),
  })
  .passthrough();
export type TokenError = z.infer<typeof tokenErrorSchema>;

/* -------------------------------------------------------------------------- */
/*                              REST resources                                */
/* -------------------------------------------------------------------------- */

/** `GET /users/me` (and `/users/{id}`) — only the fields we key on. */
export const userSchema = z
  .object({
    id: wireInt(),
    nickname: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    site_id: z.string().nullable().optional(),
    // Account capability tags — `warehouse_management` marks multiorigin
    // accounts, whose stock cannot be sent via PUT /items.
    tags: z.array(z.string()).nullable().optional(),
  })
  .passthrough();
export type MlUser = z.infer<typeof userSchema>;

/**
 * `POST /users/test_user` — a throwaway production account ML hands out in place
 * of the sandbox it does not have.
 *
 * ⚠️ **This is the only response in this file that contains a password**, and ML
 * never shows it again («Se você perder a senha da conta de teste, não é possível
 * recuperar»). `criarUsuarioTeste` therefore does NOT route it through `parseOk`:
 * that helper puts the raw body into `MercadoLivreValidationError` on a non-JSON
 * response and the Zod issues on a shape mismatch, and #1015 is the worked
 * example of a credential response reaching Cloud Logging exactly that way.
 *
 * `password` is `.min(1)` on purpose: a blank one parses as success while being
 * unusable, and the caller would persist it and burn one of ten permanent slots.
 */
export const testUserSchema = z
  .object({
    id: wireInt(),
    nickname: z.string().min(1),
    password: z.string().min(1),
    site_status: z.string().nullable().optional(),
    site_id: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
  })
  .passthrough();
export type MlTestUser = z.infer<typeof testUserSchema>;

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
    /**
     * A `number_unit` measurement, split the way ML stores it.
     *
     * ⚠️ This is the ONLY place an item response states the unit. ML answers
     * `GET /items` with `value_name: '355 mL'` — the unit baked into the text —
     * and **no `unit_id` at all**; `unit_id` is a field we SEND, not one we get
     * back. The schema is `.passthrough()`, so this key already survived the
     * parse and was merely untyped, which is why the import mapper could not
     * read it and every imported measurement arrived unitless.
     */
    value_struct: z
      .object({
        number: wireNumber().nullable().optional(),
        unit: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    /**
     * ML's `values[]` — read for ONE thing: `values[0].struct`.
     *
     * ⚠️ **The struct is not always at the attribute root.** A live
     * `GET /items/{id}?include_attributes=all` (MLB5146021467, 27/08/2026) returned
     * every `number_unit` attribute as `value_name: '10 cm'`, `unit_id: null`,
     * **no** top-level `value_struct`, and the split only here:
     * `values: [{ id: null, name: '10 cm', struct: { number: 10, unit: 'cm' } }]`.
     * So a reader that consults `value_struct` alone sees nothing on that response.
     *
     * ⚠️ **`id` and `name` are deliberately NOT typed, and the `.catch` is not
     * decoration.** This key used to be inert — unknown to the schema, preserved by
     * `.passthrough()`, incapable of failing anything. Typing it makes every element
     * of every attribute of every item a validation surface, and this object has no
     * outer `.catch()`: one odd `values[0].id` (a NUMBER, which ML has form for — see
     * {@link itemVariationSchema}'s own id union) would fail the WHOLE
     * `GET /items` parse and kill the import, the publish, `itemsStatusSync` and the
     * notification handlers for that listing. That directly contradicts this
     * schema's stated invariant one docblock up: *"Every field is optional so a
     * single odd entry (or ML drift) never fails the whole item parse."* Nothing in
     * the repo reads `id` or `name` here, so typing them buys no reader anything and
     * costs a new way to lose a produto. Same reasoning, same remedy as
     * {@link mlMissedFeedSchema}'s per-field catches.
     *
     * The `.catch(undefined)` covers the shapes narrowing cannot: a non-array
     * `values`, or a `struct` whose `number`/`unit` drift. Drift degrades to "no
     * struct" — `cmFromMeasurement` then falls through to `value_name` — rather
     * than throwing.
     */
    values: z
      .array(
        z
          .object({
            struct: z
              .object({
                number: wireNumber().nullable().optional(),
                unit: z.string().nullable().optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional()
      .catch(undefined),
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
    available_quantity: wireNumber().nullable().optional(),
    price: wireNumber().nullable().optional(),
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
    price: wireNumber().nullable().optional(),
    /** Normal price (promo/`price` may be lower); import uses `base_price ?? price`. */
    base_price: wireNumber().nullable().optional(),
    available_quantity: wireNumber().nullable().optional(),
    condition: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    /** ML sub-status (`deleted`/`suspended`/`freezed`/`out_of_stock`…) — bot filtering. */
    sub_status: z.array(z.string()).nullable().optional(),
    listing_type_id: z.string().nullable().optional(),
    seller_id: wireInt().nullable().optional(),
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
 * ML's documented Multiget cap (*Busca de itens* → "Multiget": "um máximo de 20
 * resultados com uma única chamada").
 *
 * ⚠️ ML does not error on an over-long multiget — it TRUNCATES, so a caller that
 * does not chunk gets a silent prefix and, if it is deciding what to DELETE or
 * CLOSE from the difference, acts on a set it only partly verified. That is why
 * `getItemsByIds` refuses locally instead of forwarding the request: the trap is
 * invisible at the ML end, so the seam has to be the one that says no.
 */
export const ML_MULTIGET_MAX_IDS = 20;

/**
 * `GET /items?ids=<csv>&attributes=<csv>` — ML's **Multiget**, capped at 20 ids.
 *
 * ⚠️ The response is NOT an array of items. Multiget answers in the *verbose*
 * envelope — `[{ code, body }, …]`, one entry per requested id, each carrying its
 * OWN status code — so a partial failure is a 200 overall with a non-200 entry
 * inside it. A caller that reads `body` without checking `code` treats a missing
 * or forbidden item as an item with no fields, which for
 * {@link https://developers.mercadolivre.com.br/pt_br/itens-e-buscas | the docs'}
 * own example shape is indistinguishable from a real one.
 *
 * `body` is modelled narrow on purpose: the only caller asks for two attributes
 * (`sweepRemovedMembers`' membership check), and `attributes=` makes ML omit
 * everything else, so reusing `itemSchema` here would claim fields the request
 * never asked for. `.passthrough()` keeps whatever else a wider caller requests.
 */
export const itemsMultigetSchema = z.array(
  z
    .object({
      // `wireInt()`, not `z.number().int()`: ML quoting a number is serializer-level
      // drift and `parseOk` validates the WHOLE body, so one strict field costs
      // the entire multiget. Here that would be silent in the worst way — every
      // entry would fail `code !== 200`, the sweep would confirm nothing, and it
      // would stop closing anything at all.
      code: wireInt().nullable().optional(),
      body: z
        .object({
          id: z.string().nullable().optional(),
          user_product_id: z.string().nullable().optional(),
        })
        .passthrough()
        .nullable()
        .optional(),
    })
    .passthrough(),
);
export type MlItemsMultiget = z.infer<typeof itemsMultigetSchema>;

/**
 * `conditions` of one `GET /items/{id}/prices` entry — the applicability
 * window plus channel restrictions. `context_restrictions` values include
 * `channel_marketplace` and legacy `channel_mshops` (Mercado Shops is
 * discontinued — mshops-restricted entries are ignored by the handler).
 */
export const itemPricesConditionsSchema = z
  .object({
    context_restrictions: z.array(z.string()).nullable().optional(),
    start_time: z.string().nullable().optional(),
    end_time: z.string().nullable().optional(),
  })
  .passthrough();
export type MlItemPricesConditions = z.infer<typeof itemPricesConditionsSchema>;

/**
 * One `prices[]` entry of `GET /items/{id}/prices` — `type` is
 * `'standard' | 'promotion'` in practice but stays a plain string (ML adds
 * price types without notice).
 */
export const itemPricesEntrySchema = z
  .object({
    id: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
    amount: wireNumber().nullable().optional(),
    regular_amount: wireNumber().nullable().optional(),
    currency_id: z.string().nullable().optional(),
    last_updated: z.string().nullable().optional(),
    conditions: itemPricesConditionsSchema.nullable().optional(),
  })
  .passthrough();
export type MlItemPricesEntry = z.infer<typeof itemPricesEntrySchema>;

/**
 * `GET /items/{id}/prices` — the listing's full price set, consulted on the
 * `items_prices` webhook topic. Tolerance is deliberate (ML drifts fields
 * silently): only the entries the price handler keys on are typed.
 */
export const itemPricesSchema = z
  .object({
    id: z.string().nullable().optional(),
    prices: z.array(itemPricesEntrySchema).nullable().default([]),
  })
  .passthrough();
export type MlItemPrices = z.infer<typeof itemPricesSchema>;

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
    quantity: wireNumber().nullable().optional(),
    unit_price: wireNumber().nullable().optional(),
    currency_id: z.string().nullable().optional(),
    element_id: z.union([z.number(), z.string()]).nullable().optional(),
    /**
     * Multiorigin (`warehouse_management`) accounts only — the PHYSICAL origin
     * of this line, per the `gestao-packs` reference: `store_id` "identifies the
     * store or specific physical location where the stock of an item is held",
     * `network_node_id` "represents the seller node or the specific physical
     * location the item comes from".
     *
     * ⚠️ Modelled, not persisted. This ERP binds ONE depósito per conta
     * (`integracao.depositoOuterRef`), so under the single-depósito multiorigin
     * tier #706 supports, the origin is already known and storing it would add
     * a `pedidos` schema change (and a ruleset regeneration) for no reader.
     * It becomes load-bearing with `multiwarehouse` — see #1177, where a sale
     * has to debit the depósito it actually shipped from.
     */
    stock: z
      .array(
        z
          .object({
            store_id: z.union([z.string(), z.number()]).nullable().optional(),
            network_node_id: z.union([z.string(), z.number()]).nullable().optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional()
      // ⚠️ `.catch(null)` because this field has NO readers yet. Every other
      // field on this line is load-bearing and rightly fails the parse when ML
      // sends a shape we cannot use; this one is documentation until #1177, so
      // an unexpected shape must not fail `orderItemSchema` → `orderSchema` →
      // the whole ORDER IMPORT for a value nobody consumes. Same idiom the
      // notification schema below uses, and for the same reason.
      .catch(null),
  })
  .passthrough();

/** `GET /orders/{id}`. Can arrive `206 Partial Content` with `order_items` empty. */
export const orderSchema = z
  .object({
    id: wireInt(),
    status: z.string().nullable().optional(),
    date_created: z.string().nullable().optional(),
    last_updated: z.string().nullable().optional(),
    pack_id: wireInt().nullable().optional(),
    order_items: z.array(orderItemSchema).nullable().optional(),
    total_amount: wireNumber().nullable().optional(),
    currency_id: z.string().nullable().optional(),
    buyer: z.object({ id: wireInt().nullable().optional() }).passthrough().nullable().optional(),
    shipping: z.object({ id: wireInt().nullable().optional() }).passthrough().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
    /**
     * The feedback "operação concretizada" flag, surfaced on the order itself.
     *
     * ⚠️ It is NOT a shipping status and NOT related to Fulfillment/FULL. ML's
     * feedback reference defines it as *"Indica se a operação foi ou não foi
     * concretizada"*, and — the part that makes it load-bearing here — says the
     * seller's confirmation *"deverá sempre ser aplicada para mudar o status
     * para entregue em vendas sem Mercado Envios"*. On an order with no
     * shipment it IS the delivery confirmation, and the only one: the
     * `delivered`/`not_delivered` TAGS are no longer added automatically
     * ("o integrador deverá realizar um PUT com a tag correspondente"), so a
     * delivered sem-envio order still reads `not_delivered` forever.
     *
     * ⚠️ `false` does not mean "not delivered yet" — it means the sale did NOT
     * happen (it requires a `reason` such as `OUT_OF_STOCK`/`BUYER_REGRETS`,
     * carries `restock_item`, and drives the order back to `status=confirmed`
     * with the payment refunded). Only `true` is actionable; see
     * `applyFreteSemEnvioStep`, the single reader.
     */
    fulfilled: z.boolean().nullable().optional(),
  })
  .passthrough();
export type MlOrder = z.infer<typeof orderSchema>;

/** `GET /orders/search` — paged results. */
export const orderSearchSchema = z
  .object({
    results: z.array(orderSchema).default([]),
    paging: z
      .object({
        total: wireNumber().nullable().optional(),
        offset: wireNumber().nullable().optional(),
        limit: wireNumber().nullable().optional(),
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
    /**
     * Empty ⇒ this is a LEAF. The whole category walk keys on it, and ML only
     * serves listing types and attributes for leaves (`cadastroSlim.dart:93-96`,
     * `:114-116` both early-return `[]` on a non-leaf).
     */
    children_categories: z
      .array(z.object({ id: z.string(), name: z.string().nullable().optional() }).passthrough())
      .nullable()
      .optional(),
    settings: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();
export type MlCategory = z.infer<typeof categorySchema>;

/** `GET /sites/MLB/categories` — the root of the category tree. */
export const siteCategoriesSchema = z.array(
  z.object({ id: z.string(), name: z.string().nullable().optional() }).passthrough(),
);
export type MlSiteCategory = z.infer<typeof siteCategoriesSchema>[number];

/** `GET /categories/{id}/listing_types` — the types available for a LEAF category. */
export const categoryListingTypesSchema = z.array(
  z
    .object({
      id: z.string(),
      name: z.string().nullable().optional(),
      site_id: z.string().nullable().optional(),
    })
    .passthrough(),
);
export type MlCategoryListingType = z.infer<typeof categoryListingTypesSchema>[number];

/**
 * `GET /sites/MLB/listing_prices?price=&listing_type_id=&category_id=`
 *
 * ML answers an OBJECT when `listing_type_id` is supplied and an ARRAY when it
 * is not; only the single-type form is wrapped, because the fee preview is
 * always asked for one chosen listing type.
 */
export const listingPricesSchema = z
  .object({
    listing_type_id: z.string().nullable().optional(),
    /** Commission charged on a sale — the link doc's `comissao`. */
    sale_fee_amount: wireNumber().nullable().optional(),
    /** Up-front listing fee (0 for the free/classic types). */
    listing_fee_amount: wireNumber().nullable().optional(),
    currency_id: z.string().nullable().optional(),
  })
  .passthrough();
export type MlListingPrices = z.infer<typeof listingPricesSchema>;

/**
 * One entry of `GET /categories/{id}/attributes`.
 *
 * ⚠️ Almost every predicate a form needs — `required`, `catalog_required`,
 * `hidden`, `multivalued`, `variation_attribute`, `allow_variations`,
 * `read_only` — lives inside **`tags`**, not at the root (the legacy Dart
 * getters at `api_response.dart:287-308` all read through it). Use
 * {@link attrTag} rather than indexing `tags` by hand.
 *
 * ⚠️ ML sends `tags` as a MAP on some categories and as an ARRAY of names on
 * others; {@link attrTag} normalises both (`_tagsFromJson`, `api_response.dart:225`).
 */
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
    tags: z
      .union([z.record(z.string(), z.unknown()), z.array(z.string())])
      .nullable()
      .optional(),
    /** `FAMILY` marks an attribute that identifies a User-Products family. */
    hierarchy: z.string().nullable().optional(),
    /** ML's own ordering hint — lower is more important. */
    relevance: wireNumber().nullable().optional(),
    tooltip: z.string().nullable().optional(),
    hint: z.string().nullable().optional(),
    /** Max characters ML accepts; over-long values are rejected on publish. */
    value_max_length: wireInt().nullable().optional(),
    default_unit: z.string().nullable().optional(),
    default_unit_id: z.string().nullable().optional(),
    allowed_units: z
      .array(
        z
          .object({ id: z.string().nullable().optional(), name: z.string().nullable().optional() })
          .passthrough(),
      )
      .nullable()
      .optional(),
    attribute_group_id: z.string().nullable().optional(),
    attribute_group_name: z.string().nullable().optional(),
  })
  .passthrough();
export const categoryAttributesSchema = z.array(categoryAttributeSchema);
export type MlCategoryAttribute = z.infer<typeof categoryAttributeSchema>;

/**
 * Read a boolean ML attribute tag, tolerating both wire shapes ML uses:
 * `{ required: true }` and `['required', 'hidden']`.
 */
export function attrTag(attr: MlCategoryAttribute, tag: string): boolean {
  const tags = attr.tags;
  if (tags == null) return false;
  if (Array.isArray(tags)) return tags.includes(tag);
  return tags[tag] === true;
}

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
    id: wireInt(),
    status: z.string().nullable().optional(),
    orders: z.array(z.object({ id: wireInt() }).passthrough()).default([]),
    shipment: z.object({ id: wireInt().nullable().optional() }).passthrough().nullable().optional(),
  })
  .passthrough();
export type MlPack = z.infer<typeof packSchema>;

/* --------------------- Order payments + shipments (Step 9 order import) --------------------- */

/** One entry of `payment.charge_details`/`charges_details[]` — fee/charge line items (legacy `ChargeDetailsMercadoLivre`, models.dart:4941-4979). Only the fields `toPagamento`'s tarifas calc reads are typed. */
export const mlPaymentChargeDetailSchema = z
  .object({
    accounts: z
      .object({ from: z.string().nullable().optional(), to: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    amounts: z
      .object({
        original: wireNumber().nullable().optional(),
        refunded: wireNumber().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type MlPaymentChargeDetail = z.infer<typeof mlPaymentChargeDetailSchema>;

/** One entry of `payment.fee_details[]` (legacy `FeeDetailsMercadoLivrePayment`, models.dart:4787-4800) — only `amount` feeds `toPagamento`'s tarifas total; `fee_payer`/`type` ride through `.passthrough()` untyped. */
export const mlPaymentFeeDetailSchema = z
  .object({
    amount: wireNumber().nullable().optional(),
  })
  .passthrough();
export type MlPaymentFeeDetail = z.infer<typeof mlPaymentFeeDetailSchema>;

/** One entry of `payment.refunds[]` (legacy `MercadoLivreRefund`, models.dart:4813-4845) — only `amount` feeds `toPagamento`'s refund total. */
export const mlPaymentRefundSchema = z
  .object({
    amount: wireNumber().nullable().optional(),
  })
  .passthrough();
export type MlPaymentRefund = z.infer<typeof mlPaymentRefundSchema>;

/**
 * `GET /collections/{paymentId}` (legacy `get_payment`, api.dart:1446-1454) — a
 * Mercado Pago payment tied to an ML order. Tolerant: only the fields
 * `MercadoLivrePayment.toPagamento` (legacy models.dart:4455-4693) consumes are
 * typed — `payer` is unused by the mapper and rides through `.passthrough()`
 * untyped, and `card` is typed only down to `last_four_digits`.
 */
export const mlPaymentSchema = z
  .object({
    id: wireInt(),
    date_created: z.string().nullable().optional(),
    date_approved: z.string().nullable().optional(),
    date_last_updated: z.string().nullable().optional(),
    last_modified: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    transaction_amount: wireNumber().nullable().optional(),
    total_paid_amount: wireNumber().nullable().optional(),
    shipping_cost: wireNumber().nullable().optional(),
    coupon_amount: wireNumber().nullable().optional(),
    status: z.string().nullable().optional(),
    /** Consumed by the payments-topic handler (legacy tasks.dart:1172/1176 — NONE-marketplace skip + order-key resolution). */
    marketplace: z.string().nullable().optional(),
    /** Consumed by the payments-topic handler for order-key resolution (legacy tasks.dart:1176). */
    external_reference: z.string().nullable().optional(),
    /** Consumed by the payments-topic handler for order-key resolution (legacy tasks.dart:1176). */
    order_id: wireInt().nullable().optional(),
    installments: wireNumber().nullable().optional(),
    payment_type: z.string().nullable().optional(),
    payment_type_id: z.string().nullable().optional(),
    payment_method_id: z.string().nullable().optional(),
    card_id: wireNumber().nullable().optional(),
    card: z
      .object({ last_four_digits: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    authorization_code: z.string().nullable().optional(),
    marketplace_fee: wireNumber().nullable().optional(),
    fee_details: z.array(mlPaymentFeeDetailSchema).nullable().optional(),
    charge_details: z.array(mlPaymentChargeDetailSchema).nullable().optional(),
    charges_details: z.array(mlPaymentChargeDetailSchema).nullable().optional(),
    refunds: z.array(mlPaymentRefundSchema).nullable().optional(),
  })
  .passthrough();
export type MlPayment = z.infer<typeof mlPaymentSchema>;

/** One `lead_time.estimated_*` sub-object — every variant is `{ date: string|null, ... }`; only `date` is consumed. */
const mlShipmentEstimatedDateSchema = z
  .object({ date: z.string().nullable().optional() })
  .passthrough();

/**
 * `shipment.lead_time` — the delivery-window/cost block of the `x-format-new`
 * shipment body. Replaces the legacy top-level `shipping_option`
 * (`ShippingOption`, models.dart:6052-6127), which carried the same children.
 *
 * ⚠️ `estimated_handling_limit` is deliberately NOT typed here. ML deprecated it
 * on 2025-05-13 — "a informação só poderá ser consumida no recurso de SLA" — and
 * `resolvePrazoDespacho` reads the SLA resource first anyway. Typing a field ML
 * has stopped filling would only invite a reader that silently gets null.
 *
 * ⚠️ `cost` is deliberately NOT typed here, even though the payload carries it.
 * It looks like a replacement for the legacy top-level `base_cost` and is not
 * one: on the free-shipping shipment captured at `.old/…/models.dart:3150` it is
 * `0` (a 100% discount) while `base_cost` is 38.90, and on the paid one at
 * `:5142` it equals `list_cost` with no discount at all while `base_cost` is
 * nearly double. Typing it invites exactly the substitution that would wipe
 * `custoCalculado` — see `shipmentBaseCost` for the full autopsy (#957). It
 * still rides through `.passthrough()` for anyone who needs it knowingly.
 */
export const mlShipmentLeadTimeSchema = z
  .object({
    list_cost: wireNumber().nullable().optional(),
    estimated_delivery_limit: mlShipmentEstimatedDateSchema.nullable().optional(),
    estimated_delivery_time: mlShipmentEstimatedDateSchema.nullable().optional(),
  })
  .passthrough();
export type MlShipmentLeadTime = z.infer<typeof mlShipmentLeadTimeSchema>;

/** `shipment.destination.shipping_address` — the buyer's address in the `x-format-new` body (was the top-level `receiver_address`). */
const mlShipmentAddressSchema = z
  .object({
    street_name: z.string().nullable().optional(),
    street_number: z.union([z.number(), z.string()]).nullable().optional(),
    zip_code: z.string().nullable().optional(),
    comment: z.string().nullable().optional(),
    neighborhood: z
      .object({ name: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    city: z.object({ name: z.string().nullable().optional() }).passthrough().nullable().optional(),
    state: z.object({ name: z.string().nullable().optional() }).passthrough().nullable().optional(),
  })
  .passthrough();

/**
 * `GET /shipments/{shipmentId}` in the **`x-format-new: true`** shape (ML docs,
 * *Gerenciamento de Envios*). That header is mandatory on shipments requests as
 * of 2025-10-12 and the plugin now sends it — see `getShipment` (#957).
 *
 * Three legacy fields are gone from the wire and therefore from this schema:
 *  - `order_id` (+ `external_reference`) — **discontinued** on the same date.
 *    Resolve the order through `GET /shipments/{id}/orders` instead
 *    (`getShipmentOrders`); the passthrough keeps the raw value readable for as
 *    long as ML still happens to send it.
 *  - `base_cost` — no counterpart IN THIS BODY, and `lead_time.cost` is
 *    emphatically not one (see `shipmentBaseCost`). What the seller actually
 *    pays now comes from `GET /shipments/{id}/costs` — `senders[].cost`,
 *    `mlShipmentCostsSchema` below.
 *  - `logistic_type` — moved under `logistic.type`.
 *
 * Still tolerant per house style: only what the readers consume is typed, and
 * everything else rides through `.passthrough()`.
 */
export const mlShipmentSchema = z
  .object({
    id: wireInt(),
    status: z.string().nullable().optional(),
    substatus: z.string().nullable().optional(),
    tracking_number: z.string().nullable().optional(),
    last_updated: z.string().nullable().optional(),
    logistic: z
      .object({
        mode: z.string().nullable().optional(),
        type: z.string().nullable().optional(),
        direction: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    lead_time: mlShipmentLeadTimeSchema.nullable().optional(),
    destination: z
      .object({ shipping_address: mlShipmentAddressSchema.nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type MlShipment = z.infer<typeof mlShipmentSchema>;

/**
 * One entry of `GET /shipments/{shipmentId}/payments` — **the endpoint returns
 * a bare JSON ARRAY**, not `{ results: [...] }` (legacy `get_shipment_payments`,
 * api.dart:1652-1661, returns `List<Map<String,dynamic>>`). Only `status` +
 * `amount` are consumed (legacy `toFrete`, models.dart:5372-5378); `amount` has
 * been observed as both a JSON number and a numeric string in the wild, hence
 * the union.
 */
export const mlShipmentPaymentSchema = z
  .object({
    status: z.string().nullable().optional(),
    amount: z.union([z.number(), z.string()]).nullable().optional(),
  })
  .passthrough();
export type MlShipmentPayment = z.infer<typeof mlShipmentPaymentSchema>;
/** The array wrapper for `getShipmentPayments` — see `mlShipmentPaymentSchema`. */
export const mlShipmentPaymentsSchema = z.array(mlShipmentPaymentSchema);

/**
 * One party's side of `GET /shipments/{shipmentId}/costs` — `receiver` (the
 * buyer) or one entry of `senders` (a seller). `cost` is that party's FINAL
 * share of the shipment, net of every discount ML applied to them.
 *
 * ⚠️ `save` is deliberately NOT typed — but NOT for the reason the docs give.
 * ML's *Gerenciamento de Envios* page says it stopped being filled in Oct/2024
 * ("todos os casos o campo receberá o valor 0") and was removed from the resource
 * in Jan/2025. **Both halves are false on the wire**: a live capture on 2026-08-27,
 * ~20 months later, still carries it and still carries it NON-ZERO (`save: 11.81`
 * on a receiver, `3.92` on a sender). It is left untyped because a field ML has
 * publicly deprecated is not one to build on, not because it is absent — do not
 * "correct" this comment by adding it back when you see it in a payload.
 *
 * The live body is a strict SUPERSET of the documented one in other ways too, all
 * riding the passthrough and none consumed: `fees`, `compensations` (plural,
 * beside the documented singular `compensation`), `charges.charge_flex` on a
 * sender, `cost_details[]` on the receiver, and a root `base_exchange`. `discounts`
 * is untyped on the same footing: nothing reads the breakdown.
 */
const mlShipmentCostPartySchema = z
  .object({
    user_id: wireInt().nullable().optional(),
    cost: wireNumber().nullable().optional(),
    compensation: wireNumber().nullable().optional(),
  })
  .passthrough();

/**
 * `GET /shipments/{shipmentId}/costs` — "os custos do envio a serem pagos pelo
 * usuário" (ML docs, *Gerenciamento de Envios* → Costs). **The authoritative
 * answer to "what does the SELLER pay for this shipment?"**, which the
 * `x-format-new` body no longer carries: it dropped `base_cost` and offers no
 * counterpart (see `shipmentBaseCost` for why `lead_time.cost` is not one).
 *
 * ⚠️ **`senders` is a LIST, and the first entry is not necessarily ours.** ML's
 * own note: "um só envio poderá conter produtos de diferentes vendedores". The
 * entry to read is the one whose `user_id` is the connected account's seller id —
 * `senders[0]` would book another seller's freight cost onto our pedido, and on a
 * single-seller shipment it would look right every time. `resolveShipmentSellerCost`
 * in `apps/mercado-livre` is the only reader and matches on `user_id` (#957).
 *
 * ⚠️ A `cost` of `0` is a REAL value — a fully subsidised shipment genuinely
 * costs the seller nothing — never a missing one.
 *
 * Unlike `/shipments/{id}/payments`, this resource does NOT require the shipment
 * to be tied to a `pack_id`.
 *
 * `gross_amount` is the shipment total before any discount (the nearest analogue
 * of the legacy top-level `base_cost`); it is typed because it makes a stored
 * `senders[].cost` auditable, not because anything maps it today.
 *
 * ⚠️ **`gross_amount - receiver.cost` is NOT the seller's cost.** The identity is
 * `gross_amount = Σ over parties of (cost + Σ discounts[].promoted_amount)`, verified
 * to the centavo against two LIVE shipments on 2026-08-27:
 *
 * | shipment | gross | receiver cost + promoted | sender cost + promoted |
 * | --- | --- | --- | --- |
 * | `47868202073` | 38.86 | 12.99 + 12.80 | **9.15** + 3.92 |
 * | `47868991350` | 154.20 | 85.99 + 30.00 | **26.75** + 11.46 |
 *
 * The subtraction gives 25.87 and 68.21 — nowhere near the real 9.15 and 26.75,
 * because every party's discounts sit between them. So `senders[].cost` is read
 * DIRECTLY and never derived; anyone reconciling by hand has to add the
 * `promoted_amount`s back, which this schema deliberately leaves on the passthrough.
 *
 * ⚠️ The second row is a CANCELLED, fully refunded pack shipment and its sender
 * cost is 26.75, not 0 — a refund does not zero what the seller pays here, so do
 * not treat a cancelled shipment as free.
 */
export const mlShipmentCostsSchema = z
  .object({
    gross_amount: wireNumber().nullable().optional(),
    receiver: mlShipmentCostPartySchema.nullable().optional(),
    senders: z.array(mlShipmentCostPartySchema).nullable().optional(),
  })
  .passthrough();
export type MlShipmentCosts = z.infer<typeof mlShipmentCostsSchema>;

/**
 * One entry of `GET /shipments/{shipmentId}/orders` — "Vendas associadas a um
 * envio" (ML docs, *Gerenciamento de Envios*). **The endpoint returns a bare
 * JSON ARRAY** and requires the `X-New-Domain: true` header. One row per
 * (order, listing, variation) covered by the shipment, carrying the units the
 * buyer asked for.
 *
 * This is the modern replacement for legacy's `get_shipment_items`
 * (`GET /shipments/{id}/items`, api.dart:1679-1685), used by the
 * shipment↔pedido item cross-check (`applyFreteStep`, #669). Chosen over
 * `/items` on three counts:
 *  - `requested_quantity` is the quantity the buyer ORDERED, which is what
 *    `ItemDoPedido.quantidade` holds (it comes from `order_items[].quantity`);
 *    `/items`' `quantity` is the quantity in THIS shipment, which legitimately
 *    differs on a partial shipment and would flag correct orders.
 *  - `variation_id` here is a documented nullable Long. `/items` uses `0` as
 *    its "no variation" sentinel, which does not exist on the order side — an
 *    asymmetry that silently mismatches variation sales.
 *  - ML declared `order_id`/`external_reference` discontinued in the shipments
 *    resources as of 2025-10-12; `/items` carries them, this resource is the
 *    one ML is steering toward.
 *
 * Tolerant per house style: the docs type `order_id`/`pack_id` as String and
 * `variation_id`/`seller_id` as Long, but ML has sent ids both ways across this
 * API, so every id takes the number|string union. Everything not consumed by
 * the cross-check rides through `.passthrough()`.
 */
export const mlShipmentOrderSchema = z
  .object({
    order_id: z.union([z.number(), z.string()]).nullable().optional(),
    pack_id: z.union([z.number(), z.string()]).nullable().optional(),
    item_id: z.string().nullable().optional(),
    variation_id: z.union([z.number(), z.string()]).nullable().optional(),
    user_product_id: z.string().nullable().optional(),
    seller_id: z.union([z.number(), z.string()]).nullable().optional(),
    requested_quantity: z.union([z.number(), z.string()]).nullable().optional(),
  })
  .passthrough();
export type MlShipmentOrder = z.infer<typeof mlShipmentOrderSchema>;

/**
 * The array wrapper for `getShipmentOrders` — see `mlShipmentOrderSchema`.
 *
 * ⚠️ The `.nullish().transform()` is load-bearing, not cosmetic. The docs list
 * `204 No Content` ("Shipment não possui pedidos") as a normal response, and
 * `parseOk` leaves the parsed body `null` when it is empty — which a bare
 * `z.array(...)` rejects, turning a documented 204 into a
 * `MercadoLivreValidationError` and a parked import. Callers must therefore
 * treat `[]` as "ML told us nothing", never as "the shipment covers no items".
 */
export const mlShipmentOrdersSchema = z
  .array(mlShipmentOrderSchema)
  .nullish()
  .transform((v) => v ?? []);

/** `GET /shipments/{shipmentId}/sla` (legacy `get_shipment_sla`, api.dart:1671-1677) — only `expected_date` is consumed (legacy `_getPrazoDespacho`, tasks.dart:38-43). */
export const mlShipmentSlaSchema = z
  .object({
    expected_date: z.string().nullable().optional(),
  })
  .passthrough();
export type MlShipmentSla = z.infer<typeof mlShipmentSlaSchema>;

/**
 * `POST/GET /shipments/{shipmentId}/invoice_data` — the saved invoice record
 * (JSON) ML keeps for a shipment after the NF-e XML upload (Step 12, #739).
 * Tolerant: only the identifiers + `status` the caller keys on are typed; every
 * other field ML sends (`invoice_number`, `fiscal_key`…) rides through
 * `.passthrough()` untyped.
 */
export const mlShipmentInvoiceSchema = z
  .object({
    id: wireInt().nullable().optional(),
    shipment_id: wireInt().nullable().optional(),
    status: z.string().nullable().optional(),
  })
  .passthrough();
export type MlShipmentInvoice = z.infer<typeof mlShipmentInvoiceSchema>;

/** One weekday entry of the seller shipping schedule (legacy `_getPrazoDespacho`, tasks.dart:112-133: `schedule[day]['work']` / `schedule[day]['detail'][0]['cutoff']`). */
export const mlSellerShippingScheduleDaySchema = z
  .object({
    work: z.boolean().nullable().optional(),
    detail: z
      .array(z.object({ cutoff: z.string().nullable().optional() }).passthrough())
      .nullable()
      .optional(),
  })
  .passthrough();
export type MlSellerShippingScheduleDay = z.infer<typeof mlSellerShippingScheduleDaySchema>;

/**
 * `GET /users/{sellerId}/shipping/schedule/{logisticType}` (legacy
 * `get_horarios_despacho`, api.dart:1687-1693) — the seller's weekly dispatch
 * window, keyed by lowercase English weekday name (`monday`…`sunday`).
 */
export const mlSellerShippingScheduleSchema = z
  .object({
    schedule: z.record(z.string(), mlSellerShippingScheduleDaySchema).nullable().optional(),
  })
  .passthrough();
export type MlSellerShippingSchedule = z.infer<typeof mlSellerShippingScheduleSchema>;

/**
 * `GET /users/{sellerId}/shipping_options/free` — ML's own estimate of what an
 * item costs to ship, plus the weight it BILLS for.
 *
 * Reached with `item_id` (ML documents `item_id` OR `dimensions` as the one
 * mandatory pair), and the only field the importer reads is
 * `coverage.all_country.billable_weight`.
 *
 * ⚠️ **`billable_weight` is in GRAMS, and it is not a measured mass.** Grams is
 * the unit throughout ML's shipping API (`dimensions=AxBxC,peso`,
 * `shipment.dimensions.weight`). It is a BILLABLE figure — ML's own assumed
 * package, and potentially volumetric — so it belongs in a produto's GROSS weight
 * and never in its net one. See `mapMlItemToImport`.
 *
 * ⚠️ Every field is optional: ML omits `discount` entirely when none applies,
 * and this is a cost SIMULATION, so a partial body must never fail the parse and
 * lose the import along with it.
 */
export const mlFreeShippingOptionsSchema = z
  .object({
    coverage: z
      .object({
        all_country: z
          .object({
            list_cost: wireNumber().nullable().optional(),
            currency_id: z.string().nullable().optional(),
            billable_weight: wireNumber().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type MlFreeShippingOptions = z.infer<typeof mlFreeShippingOptionsSchema>;

/**
 * `GET /orders/{orderId}/billing_info` sent with header `x-version: 2` (legacy
 * `get_billing_info_v2`, api.dart:1432-1444) — the buyer's fiscal identity +
 * address for NF-e emission. Tolerant: only the fields `BillingInfoResponse`'s
 * `toEndereco`/`toCliente` (legacy api_types/billing_info.dart:74-113) consume
 * are typed; `seller` and `attributes` ride through `.passthrough()` untyped.
 */
export const mlBillingInfoSchema = z
  .object({
    site_id: z.string().nullable().optional(),
    buyer: z
      .object({
        cust_id: z.union([z.string(), z.number()]).nullable().optional(),
        billing_info: z
          .object({
            name: z.string().nullable().optional(),
            last_name: z.string().nullable().optional(),
            identification: z
              .object({
                type: z.string().nullable().optional(),
                number: z.string().nullable().optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
            taxes: z
              .object({
                inscriptions: z
                  .object({ state_registration: z.string().nullable().optional() })
                  .passthrough()
                  .nullable()
                  .optional(),
                taxpayer_type: z
                  .object({ description: z.string().nullable().optional() })
                  .passthrough()
                  .nullable()
                  .optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
            address: z
              .object({
                street_name: z.string().nullable().optional(),
                street_number: z.string().nullable().optional(),
                city_name: z.string().nullable().optional(),
                comment: z.string().nullable().optional(),
                neighborhood: z.string().nullable().optional(),
                state: z
                  .object({ name: z.string().nullable().optional() })
                  .passthrough()
                  .nullable()
                  .optional(),
                zip_code: z.string().nullable().optional(),
                country_id: z.string().nullable().optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type MlBillingInfo = z.infer<typeof mlBillingInfoSchema>;

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
    /**
     * ML's own paging block. ⚠️ Load-bearing for `resolveFamilyItemIds`: without
     * `total` there is no way to tell a complete answer from ML's default first
     * page, and the publish orphan sweep decides what to CLOSE from this. Kept
     * optional — a missing block degrades to the short-page test, never to a
     * false claim of completeness.
     */
    paging: z
      .object({
        total: wireInt().nullable().optional(),
        limit: wireInt().nullable().optional(),
        offset: wireInt().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type MlUserProductItemsSearch = z.infer<typeof userProductItemsSearchSchema>;

/* ------------------ User-Products stock by location (#706) ----------------- */

/**
 * The three `stock_locations` typologies (ML "Estoque distribuído"). Only two
 * are writable by a seller, and only ONE of those exists on MLB:
 *
 * - `meli_facility` — Fulfillment. **ML manages it**; a seller write is refused,
 *   and — the dangerous part — a `seller_warehouse` write aimed at a Full
 *   listing returns SUCCESS and changes nothing. Such a listing must be
 *   skipped, never "sent".
 * - `selling_address` — the seller's origin address for non-fulfillment
 *   logistics. Writable **only on MLA and MLC**; on MLB the endpoint answers
 *   "the site is blocked for modifications to the selling address".
 * - `seller_warehouse` — multiple seller-managed origins. The only writable
 *   type on MLB, and the one this ERP pushes stock through.
 *
 * ⚠️ A single UP can carry at most two typologies at once — either
 * (`selling_address` + `meli_facility`) or (`seller_warehouse` + `meli_facility`).
 */
export const stockLocationTypeSchema = z.enum([
  'meli_facility',
  'selling_address',
  'seller_warehouse',
]);
export type MlStockLocationType = z.infer<typeof stockLocationTypeSchema>;

/** Named members of {@link stockLocationTypeSchema} (`prefer-schema-enum`). */
export const STOCK_LOCATION_TYPE = {
  meliFacility: 'meli_facility',
  sellingAddress: 'selling_address',
  sellerWarehouse: 'seller_warehouse',
} as const satisfies Record<string, MlStockLocationType>;

/**
 * One entry of `GET /user-products/{id}/stock` → `locations[]`.
 *
 * ⚠️ `store_id` / `network_node_id` are present **only** on `seller_warehouse`
 * rows — the `selling_address` and `meli_facility` shapes carry `type` +
 * `quantity` and nothing else. `type` itself is tolerant (a new ML typology must
 * not fail the read of a UP we can still write): unknown values survive as a
 * plain string and are simply never selected as a write target.
 */
export const userProductStockLocationSchema = z
  .object({
    type: z.string().nullable().optional(),
    store_id: z.union([z.string(), z.number()]).nullable().optional(),
    network_node_id: z.union([z.string(), z.number()]).nullable().optional(),
    quantity: wireNumber().nullable().optional(),
  })
  .passthrough();
export type MlUserProductStockLocation = z.infer<typeof userProductStockLocationSchema>;

/**
 * `GET /user-products/{USER_PRODUCT_ID}/stock` and the response of
 * `PUT …/stock/type/seller_warehouse`.
 *
 * ⚠️ The body is only half the answer — the **`x-version` response header** is
 * the other half, and it is what the PUT must echo back. `getUserProductStock`
 * returns both; see `MercadoLivreApi.getUserProductStock`.
 *
 * ⚠️ A UP whose stock was never initialised answers `stock-locations not found`
 * rather than an empty `locations` array — the resource does not exist until a
 * location does.
 */
export const userProductStockSchema = z
  .object({
    id: z.string().nullable().optional(),
    user_id: z.union([z.number(), z.string()]).nullable().optional(),
    locations: z.array(userProductStockLocationSchema).nullable().default([]),
  })
  .passthrough();
export type MlUserProductStock = z.infer<typeof userProductStockSchema>;

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
      .object({ total: wireNumber().nullable().optional() })
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
 * `POST /catalog/charts` / `GET|PUT /catalog/charts/{id}` / row endpoints — the
 * full chart the API echoes back (create AND row calls return the whole
 * chart; the legacy write-back reads `id`, `main_attribute_id` and the
 * per-index `rows[].id`).
 *
 * `chart_status` only appears while ML is processing a deletion request:
 * `ACTIVE` = still linked to at least one listing (nothing was removed),
 * `INACTIVE` = the chart is gone. Absent on a chart nobody asked to delete.
 */
export const sizeChartApiSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    main_attribute_id: z.string().nullable().optional(),
    names: z.record(z.string(), z.string()).nullable().optional(),
    domain_id: z.string().nullable().optional(),
    site_id: z.string().nullable().optional(),
    measure_type: z.string().nullable().optional(),
    chart_status: z.string().nullable().optional(),
    attributes: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
    rows: z.array(sizeChartApiRowSchema).nullable().optional(),
  })
  .passthrough();
export type MlSizeChartApi = z.infer<typeof sizeChartApiSchema>;

/**
 * `DELETE /catalog/charts/{id}` — the deletion REQUEST ack. ML answers 200 with
 * an explanatory message and only then checks, asynchronously (up to 24h),
 * whether the chart is still linked to a listing; the outcome is read back off
 * `chart_status` via `getSizeChart`.
 */
export const sizeChartDeleteResponseSchema = z
  .object({
    message: z.string().nullable().optional(),
  })
  .passthrough();
export type MlSizeChartDeleteResponse = z.infer<typeof sizeChartDeleteResponseSchema>;

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

/* --------------------- Claims / reclamações (Step 14) --------------------- */

/**
 * One entry of a player's `available_actions` — what THAT party may do on the
 * claim right now (ML "Gerenciar reclamações" → players.available_actions).
 *
 * `action` is a plain nullable string, NEVER an enum: the documented seller set
 * alone is a dozen values (`send_message_to_complainant`,
 * `send_message_to_mediator`, `refund`, `open_dispute`, `allow_return`,
 * `allow_partial_refund`, `send_tracking_number`, `return_review`, …) and ML
 * adds to it without notice. An unknown action must read as "an action we do not
 * implement", never as a parse failure that parks the whole claim.
 */
export const mlClaimAvailableActionSchema = z
  .object({
    action: z.string().nullable().default(null),
    /** True when ML requires it before `due_date`. */
    mandatory: z.boolean().nullable().default(null),
    due_date: z.string().nullable().default(null),
  })
  .passthrough();
export type MlClaimAvailableAction = z.infer<typeof mlClaimAvailableActionSchema>;

/**
 * One `players[]` entry of a claim (legacy `_Players`, models.dart:4007-4034).
 * `role` is `complainant`/`respondent`/`mediator` and `type` is the per-resource
 * party name (`buyer`/`seller`, `payer`/`collector`, `receiver`/`sender`,
 * `internal`) — both stay plain strings (NEVER enums): ML adds vocabulary
 * without notice and an unknown value must not fail the claim parse.
 *
 * ⚠️ `available_actions` is now TYPED (it used to ride through
 * `.passthrough()`): it is the field that decides whether the seller can still
 * DO anything on this claim, which is what the import gates the chat conversa
 * on. An absent or null array normalises to `[]` — "no actions available" — so
 * the gate reads the same whether ML omits the key or sends it empty.
 */
export const mlClaimPlayerSchema = z
  .object({
    role: z.string().nullable().default(null),
    type: z.string().nullable().default(null),
    user_id: wireInt().nullable().default(null),
    available_actions: z
      .array(mlClaimAvailableActionSchema)
      .nullish()
      .transform((v) => v ?? []),
  })
  .passthrough();
export type MlClaimPlayer = z.infer<typeof mlClaimPlayerSchema>;

/**
 * `claim.resolution` (legacy `_Resolution`, models.dart:4105-4135) — how the
 * claim was closed. Every field tolerates null AND absence (→ null): the legacy
 * DTO required `reason`/`closed_by`, but ML has drifted fields before and a
 * missing one must not fail the whole claim parse. `benefited` rides through
 * `.passthrough()` untyped (only `decision` feeds the legacy comment line).
 */
export const mlClaimResolutionSchema = z
  .object({
    reason: z.string().nullable().default(null),
    date_created: z.string().nullable().default(null),
    decision: z.array(z.string()).nullable().default(null),
    closed_by: z.string().nullable().default(null),
  })
  .passthrough();
export type MlClaimResolution = z.infer<typeof mlClaimResolutionSchema>;

/**
 * `GET /post-purchase/v1/claims/{claimId}` (legacy `Claims` DTO,
 * models.dart:3827-3951; a verbatim payload sample sits at models.dart:3762-3825).
 * Only the identifiers are required; every vocabulary field (`type`, `stage`,
 * `status`, `reason_id`) is a plain nullable string — the legacy Dart enums
 * (`_typeClaims`/`_StageClaims`/`_StatusClaims`) THREW on unknown values, which
 * is exactly the failure mode this schema avoids. `labels`, `coverages`,
 * `fulfilled`, `site_id`… ride through `.passthrough()` untyped.
 */
export const mlClaimSchema = z
  .object({
    id: wireInt(),
    type: z.string().nullable().default(null),
    stage: z.string().nullable().default(null),
    status: z.string().nullable().default(null),
    /** The complained-about resource id — an order/pack/shipment/payment id depending on `resource`. */
    resource_id: wireInt(),
    /** `order`/`pack`/`shipment`/`payment`/`purchase` (legacy `_ResourceClaims`, models.dart:3724-3755). */
    resource: z.string(),
    reason_id: z.string().nullable().default(null),
    players: z
      .array(mlClaimPlayerSchema)
      .nullish()
      .transform((v) => v ?? []),
    resolution: mlClaimResolutionSchema.nullable().default(null),
    date_created: z.string(),
    last_updated: z.string().nullable().default(null),
  })
  .passthrough();
export type MlClaim = z.infer<typeof mlClaimSchema>;

/**
 * One `attachments[]` entry of a claim message (legacy `_Attachment`,
 * models.dart:3611-3634). `filename` is the download key
 * (`…/attachments/{filename}/download`); everything else is display-only.
 */
export const mlClaimMessageAttachmentSchema = z
  .object({
    filename: z.string(),
    original_filename: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
    size: wireNumber().nullable().optional(),
    date_created: z.string().nullable().optional(),
  })
  .passthrough();
export type MlClaimMessageAttachment = z.infer<typeof mlClaimMessageAttachmentSchema>;

/**
 * One entry of `GET /post-purchase/v1/claims/{claimId}/messages` — **the
 * endpoint returns a bare JSON ARRAY** (legacy `getClaimMessages`,
 * api.dart:1505-1511, returns `List<Map<String,dynamic>>`; DTO `ClaimsMessage`,
 * models.dart:3540-3600). The role/stage vocabulary stays plain strings and the
 * legacy doc-id recipe hashes `sender_role`+`receiver_role`+`stage`+
 * `date_created`+`message` — so those five drive dedup, not display.
 */
export const mlClaimMessageSchema = z
  .object({
    sender_role: z.string().nullable().default(null),
    receiver_role: z.string().nullable().default(null),
    stage: z.string().nullable().default(null),
    message: z.string().default(''),
    date_created: z.string(),
    /**
     * ML's own per-message unique id — `"<claimId>_<n>_<uuid>"` — published
     * under "Identificador único de mensagens" with the advice to key dedup on
     * it.
     *
     * ⚠️ **This port deliberately does NOT key mensagem doc ids on it**, and the
     * reason is worth stating: every claim message the Flutter app already
     * imported lives under `claimIds.ts`'s five-field digest. Re-keying would
     * write every one of them a SECOND time under a new id — a thread-wide
     * duplication of history — while buying almost nothing, because that digest
     * is already deterministic over sender/receiver/stage/date/text. The one
     * case it would fix is two messages identical in all five fields, which ML
     * flags itself with `repeated` and which collapse harmlessly today. It is
     * modelled here so the value is visible, and so a future migration that
     * DOES re-key has the field to migrate from.
     *
     * Nullable: ML added it in late 2024 and the reference's own primary
     * example still omits it.
     */
    hash: z.string().nullable().default(null),
    /**
     * `available` | `moderated` | `rejected` | `pending_translation`.
     *
     * ⚠️ Not decorative. ML filters the COUNTERPARTY's moderated messages out of
     * this endpoint but returns OUR OWN, so a `rejected` message is one the
     * buyer never saw — importing it as an ordinary bubble tells the operator a
     * message was delivered when it was not.
     */
    status: z.string().nullable().default(null),
    attachments: z
      .array(mlClaimMessageAttachmentSchema)
      .nullish()
      .transform((v) => v ?? []),
  })
  .passthrough();
export type MlClaimMessage = z.infer<typeof mlClaimMessageSchema>;
/** The array wrapper for `getClaimMessages` — see `mlClaimMessageSchema`. */
export const mlClaimMessagesSchema = z.array(mlClaimMessageSchema);

/**
 * `GET /post-purchase/v1/claims/reasons/{reasonId}` (legacy `getClaimReason`,
 * api.dart:1496-1503) — the human-readable claim reason. The legacy handler
 * reads `detail ?? name` for the motivo text (tasks.dart:1778) and `id`/
 * `date_created`/`last_updated` for the motivo message doc — all tolerated
 * missing so an ML drift degrades to "unknown reason", never a parse failure.
 */
export const mlClaimReasonSchema = z
  .object({
    id: z.union([z.string(), z.number()]).nullable().optional(),
    detail: z.string().nullable().default(null),
    name: z.string().nullable().default(null),
    date_created: z.string().nullable().optional(),
    last_updated: z.string().nullable().optional(),
  })
  .passthrough();
export type MlClaimReason = z.infer<typeof mlClaimReasonSchema>;

/**
 * `GET /post-purchase/v1/claims/search` (legacy `searchClaims`,
 * api.dart:1478-1494) — paged claims, keyed by `data` (NOT the `results`
 * envelope other ML searches use) + `paging`. Both default when absent so a
 * degenerate response yields an empty page instead of a parse failure.
 */
export const mlClaimSearchSchema = z
  .object({
    paging: z
      .object({
        total: wireNumber().nullable().optional(),
        offset: wireNumber().nullable().optional(),
        limit: wireNumber().nullable().optional(),
      })
      .passthrough()
      .default({}),
    data: z.array(mlClaimSchema).default([]),
  })
  .passthrough();
export type MlClaimSearch = z.infer<typeof mlClaimSearchSchema>;

/* ----------------------------- missed feeds (#812) ------------------------ */

/**
 * One entry of `GET /missed_feeds` — a notification Mercado Livre gave up
 * delivering (filed only after its 8th retry, ~1h; retained 2 days).
 *
 * ⚠️ **The wire shape here differs from the webhook body in two ways that have
 * already cost this repo an incident class each**, so both fields stay RAW and
 * are coerced exactly once, downstream:
 *
 *  - `sent`/`received` are **ISO-8601 strings** here, where a webhook delivery
 *    sends epoch millis. `asMillis` in `@delfrance/data/admin/notifications`
 *    accepts both; coercing here as well would put a second, divergent coercer
 *    in the repo, which is precisely how #810 happened.
 *  - `user_id` (and `application_id`) can arrive as a **string**. Narrowing it
 *    to `z.number()` here would fail the parse for the whole page; the single
 *    coercion site is `normalizeMlWire`'s `asInt`.
 *
 * ⚠️ **Every field carries a PER-FIELD `.catch(null)` on purpose**, which makes
 * the entry parse total: any JSON object survives, with an unusable field nulled
 * rather than rejecting its neighbours. One odd entry must never reject the page
 * it rides in — this feed IS the recovery path, so a strict field would block
 * every OTHER notification's recovery because of one bad neighbour, permanently,
 * since the entries expire in 2 days regardless. The nulled field then routes
 * through the sweep's normal "unusable entry" counters, visibly.
 *
 * Note the catches are per FIELD, never one outer `.catch({})` on the object —
 * an outer catch would swallow a whole-entry failure and hand the sweep an empty
 * object it could not tell from a genuinely empty feed.
 *
 * `request`/`response` are declared to document that they exist and that the
 * sweep DELIBERATELY drops them: `request` may carry the callback URL and its
 * headers (a leak surface — #811's named follow-up is a secret path segment on
 * that URL), and `response` is per-entry forensics that belongs in the tick log,
 * not on every enqueued payload and every persisted failure doc.
 */
export const mlMissedFeedSchema = z
  .object({
    /** ML's own notification id. `normalizeMlWire` aliases it onto `id`. */
    _id: z.string().nullable().optional().catch(null),
    resource: z.string().nullable().optional().catch(null),
    topic: z.string().nullable().optional().catch(null),
    user_id: z.union([z.string(), z.number()]).nullable().optional().catch(null),
    application_id: z.union([z.string(), z.number()]).nullable().optional().catch(null),
    /** ML's OWN delivery-attempt counter (not our retry budget). */
    attempts: z.union([z.string(), z.number()]).nullable().optional().catch(null),
    sent: z.string().nullable().optional().catch(null),
    received: z.string().nullable().optional().catch(null),
    /**
     * The SUBTOPIC array, on the topics that use it (`messages`,
     * `post_purchase`).
     *
     * ⚠️ Modelled because the sweep must FORWARD it (#1322). A replay is meant
     * to be the same event the webhook lost, and dropping `actions` makes it a
     * different one: the receiving branch cannot tell `["claims"]` from a
     * post-purchase subtopic it does not know, so an unrecognised one stops
     * parking and starts dropping — the silent loss #813 exists to prevent,
     * arriving through the one mechanism whose whole job is recovery.
     */
    actions: z.array(z.string()).nullable().optional().catch(null),
    /** Dropped by the sweep — see the docstring. */
    request: z.record(z.string(), z.unknown()).nullable().optional().catch(null),
    /** `http_code` is logged as a histogram; the rest is dropped. */
    response: z
      .object({
        http_code: wireNumber().nullable().optional().catch(null),
        req_time: wireNumber().nullable().optional().catch(null),
      })
      .passthrough()
      .nullable()
      .optional()
      .catch(null),
  })
  .passthrough();
export type MlMissedFeed = z.infer<typeof mlMissedFeedSchema>;

/**
 * `GET /missed_feeds?app_id=…` — one page, keyed by `messages` (NOT the
 * `results` envelope most ML searches use, nor the `data` one claims use).
 * There is **no documented `paging` envelope**, which is why the sweep pages
 * until an EMPTY page rather than treating a short page as drained.
 */
export const mlMissedFeedsSchema = z
  .object({ messages: z.array(mlMissedFeedSchema).default([]) })
  .passthrough();
export type MlMissedFeeds = z.infer<typeof mlMissedFeedsSchema>;

/* ------------------- Perguntas / questions (#532, Step M11) ---------------- */

/**
 * The seller's answer to a question (`question.answer`, ML `api_version=4`).
 *
 * ⚠️ `text` is `.default('')`, not required. A **BANNED** answer comes back with
 * an EMPTY text by ML's own documentation — the moderation stripped it — and an
 * empty string must round-trip rather than fail the parse of the whole question.
 *
 * ⚠️ The datetimes here are ISO-8601 STRINGS while the parent carries them the
 * same way; the importer converts once, at the mapping boundary. The legacy
 * `questionsML` schema modelled the parent's as epoch millis and the answer's as
 * ISO, which is the kind of split that produces 1970 timestamps.
 */
export const mlQuestionAnswerSchema = z
  .object({
    text: z.string().default(''),
    /** `ACTIVE` / `DISABLED` / `BANNED` — a plain string, never an enum. */
    status: z.string().nullable().default(null),
    date_created: z.string().nullable().default(null),
  })
  .passthrough();
export type MlQuestionAnswer = z.infer<typeof mlQuestionAnswerSchema>;

/** The asker, as `GET /questions/{id}?api_version=4` returns it. */
export const mlQuestionFromSchema = z
  .object({
    id: wireInt().nullable().default(null),
    nickname: z.string().nullable().default(null),
  })
  .passthrough();
export type MlQuestionFrom = z.infer<typeof mlQuestionFromSchema>;

/**
 * A Mercado Livre question (`GET /questions/{id}?api_version=4`).
 *
 * Only `id` is required. Every vocabulary field is a plain nullable string —
 * the same rule the claim schemas follow, and for the same reason: the legacy
 * Dart `StatusQuestionMl` enum THREW on any value outside its four members, so
 * ML shipping a fifth (it documents seven today: `UNANSWERED`, `ANSWERED`,
 * `CLOSED_UNANSWERED`, `UNDER_REVIEW`, `BANNED`, `DELETED`, `DISABLED`) would
 * poison the whole import.
 *
 * ⚠️ Do NOT model this on `packages/schemas/src/questionMercadoLivre.ts`. That
 * schema uses `z.enum` for `status` and describes the LEGACY `questionsML`
 * collection, which this port never writes and which goes away with the Flutter
 * decommission (#829).
 *
 * ⚠️ An earlier draft of this note called that collection "dual-run-only".
 * **There is no dual run and there never will be one** (root `CLAUDE.md` rule 8):
 * legacy DATA arrives in the migration window, legacy WRITES never do. The
 * distinction matters here because "dual-run" would imply Flutter keeps writing
 * `questionsML` alongside us — it does not, which is exactly why this schema can
 * be the only one and can afford to be strict about nothing.
 *
 * `buyer_id` and `from.id` are two spellings of the same asker: the by-id
 * endpoint returns `buyer_id`, the search endpoint returns `from`. The importer
 * reads whichever is present.
 */
export const mlQuestionSchema = z
  .object({
    id: wireInt(),
    seller_id: wireInt().nullable().default(null),
    buyer_id: wireInt().nullable().default(null),
    item_id: z.string().nullable().default(null),
    status: z.string().nullable().default(null),
    /** Empty when `status` is `BANNED` — ML strips moderated text. */
    text: z.string().default(''),
    date_created: z.string().nullable().default(null),
    last_updated: z.string().nullable().default(null),
    /** `true` while ML withholds the question from the seller. */
    hold: z.boolean().nullable().default(null),
    deleted_from_listing: z.boolean().nullable().default(null),
    suspected_spam: z.boolean().nullable().default(null),
    answer: mlQuestionAnswerSchema.nullable().default(null),
    from: mlQuestionFromSchema.nullable().default(null),
  })
  .passthrough();
export type MlQuestion = z.infer<typeof mlQuestionSchema>;

/* ---------------- Post-sale messages / mensageria (#532, Step M11) --------- */

/**
 * `conversation_status` on a pack's message thread — **the actionability signal
 * for post-sale messaging**.
 *
 * ML documents exactly two `status` values: `active` (open to send and receive)
 * and `blocked` (closed). `substatus` then carries the reason, from a long and
 * still-growing `blocked_by_*` vocabulary — hence a plain nullable string.
 *
 * ⚠️ The claim-id field is spelled **`claim_id` in one ML reference page and
 * `claim_ids` in another**. Both ride `.passthrough()` untyped rather than being
 * guessed at; nothing here reads them.
 */
export const mlConversationStatusSchema = z
  .object({
    path: z.string().nullable().default(null),
    /** `active` | `blocked` — a plain string, never an enum. */
    status: z.string().nullable().default(null),
    /** `blocked_by_time`, `blocked_by_mediation`, … — the operator-facing reason. */
    substatus: z.string().nullable().default(null),
    status_date: z.string().nullable().default(null),
    status_update_allowed: z.boolean().nullable().default(null),
    shipping_id: z.union([z.number(), z.string()]).nullable().default(null),
  })
  .passthrough();
export type MlConversationStatus = z.infer<typeof mlConversationStatusSchema>;

/**
 * `message_resources[]` — what a message belongs to. ML returns one entry per
 * related id, `name` being `packs`, `orders` or `sellers`.
 *
 * This is how a `messages` notification (whose `resource` is a bare message id)
 * is resolved to the pack whose thread we can actually read.
 */
export const mlMessageResourceSchema = z
  .object({
    id: z.union([z.number(), z.string()]).nullable().default(null),
    name: z.string().nullable().default(null),
  })
  .passthrough();
export type MlMessageResource = z.infer<typeof mlMessageResourceSchema>;

/** One attachment on a post-sale message. */
export const mlMessageAttachmentSchema = z
  .object({
    filename: z.string().nullable().default(null),
    original_filename: z.string().nullable().default(null),
    type: z.string().nullable().default(null),
    size: wireNumber().nullable().default(null),
  })
  .passthrough();
export type MlMessageAttachment = z.infer<typeof mlMessageAttachmentSchema>;

/**
 * One post-sale message.
 *
 * ⚠️ `from.user_id`/`to.user_id` are typed as `number | string`: ML's own
 * reference prints them BOTH ways across its samples (`123456789000` in one,
 * `"415458330"` in the next). Every consumer here compares them as strings.
 *
 * ⚠️ On a thread ML has MIGRATED to the 02/02/2026 agent architecture,
 * `from.user_id` on a READ is the **AI Agent's** id rather than the buyer's — the
 * agent intermediates the conversation. Do not use it to identify the contact;
 * the pedido does that.
 *
 * ⚠️ That is about IDENTITY and does NOT generalise to ROUTING. `from.user_id` is
 * the correct address to REPLY to under BOTH architectures, precisely because it
 * is the one ML just delivered from — see `ML_POST_SALE_AGENT_USER_ID` below.
 */
export const mlPostSaleMessageSchema = z
  .object({
    id: z.string(),
    site_id: z.string().nullable().default(null),
    from: z
      .object({ user_id: z.union([z.number(), z.string()]).nullable().default(null) })
      .passthrough()
      .nullable()
      .default(null),
    to: z
      .object({ user_id: z.union([z.number(), z.string()]).nullable().default(null) })
      .passthrough()
      .nullable()
      .default(null),
    /** `available` | `moderated` | `rejected` | `pending_translation` — plain string. */
    status: z.string().nullable().default(null),
    text: z.string().nullable().default(null),
    message_date: z
      .object({
        received: z.string().nullable().default(null),
        available: z.string().nullable().default(null),
        notified: z.string().nullable().default(null),
        created: z.string().nullable().default(null),
        read: z.string().nullable().default(null),
      })
      .passthrough()
      .nullable()
      .default(null),
    message_attachments: z
      .array(mlMessageAttachmentSchema)
      .nullish()
      .transform((v) => v ?? []),
    message_resources: z
      .array(mlMessageResourceSchema)
      .nullish()
      .transform((v) => v ?? []),
  })
  .passthrough();
export type MlPostSaleMessage = z.infer<typeof mlPostSaleMessageSchema>;

/**
 * The envelope both message endpoints return —
 * `GET /messages/packs/{packId}/sellers/{sellerId}` and `GET /messages/{id}`.
 *
 * The by-id form answers with `conversation_status: null` and a single-entry
 * `messages`, which is why resolving a notification takes two calls: one to find
 * the pack, one to read the thread WITH its status.
 *
 * ⚠️ `seller_max_message_length` is the live per-thread cap (350 at the time of
 * writing). Read it rather than trusting a constant — ML returns it on every
 * response precisely because it is not one.
 */
/**
 * The pack thread's paging block.
 *
 * ⚠️ **Load-bearing, and it used to ride `.passthrough()` untyped.** ML's
 * default page is **10** — the reference's own example shows
 * `paging: { limit: 10, offset: 0, total: 3 }` — so a thread with more than ten
 * messages silently returned its first ten and the importer wrote only those.
 * Most real post-sale threads clear ten easily.
 */
export const mlPagingSchema = z
  .object({
    limit: wireNumber().nullable().default(null),
    offset: wireNumber().nullable().default(null),
    total: wireNumber().nullable().default(null),
  })
  .passthrough();
export type MlPaging = z.infer<typeof mlPagingSchema>;

export const mlPackMessagesSchema = z
  .object({
    /** Null on the by-id read, which returns no envelope. */
    paging: mlPagingSchema.nullable().default(null),
    conversation_status: mlConversationStatusSchema.nullable().default(null),
    messages: z
      .array(mlPostSaleMessageSchema)
      .nullish()
      .transform((v) => v ?? []),
    seller_max_message_length: wireInt().nullable().default(null),
    buyer_max_message_length: wireInt().nullable().default(null),
  })
  .passthrough();
export type MlPackMessages = z.infer<typeof mlPackMessagesSchema>;

/**
 * ML's post-sale **messaging Agent** user id, per site.
 *
 * ⚠️ **The rollout is PROGRESSIVE, so this is NOT the recipient of every reply.**
 * Since 02/02/2026 ML intermediates buyer↔seller post-sale conversations with an
 * AI Agent — but its own reference says *"de forma progressiva… começando pela
 * logística Full"*, so at any moment some threads are on the new flow and some
 * are not, and nothing outside a thread says which.
 *
 * Both directions are hard failures, and they fail differently, which is what
 * makes this worth spelling out:
 *
 * - agent id on a thread ML has **not** migrated ⇒ `400 to_user_id {agente} does
 *   not belong to pack /packs/{pack}/sellers/{seller}` — loud, observed live;
 * - real buyer id on a thread it **has** ⇒ **200**, and the message reaches
 *   nobody, because the agent is the delivery path.
 *
 * ⇒ The recipient is derived PER THREAD by `postSaleRecipientUserId`
 * (`apps/mercado-livre/lib/marketplace/chat/orderMessageMapping.ts`), from the
 * pack read the send path already makes. This table is only that derivation's
 * last rung, reached when `conversation_status.path` names a `/conversations/`
 * segment and the thread itself named no counterparty.
 *
 * ⚠️ Do NOT use it to validate a derived id: an id absent from this table may be
 * an unlisted site's agent or one ML has newly minted, and rejecting it would
 * discard a correct answer.
 */
export const ML_POST_SALE_AGENT_USER_ID = {
  MLB: 3037675074,
  MLA: 3037674934,
  MLC: 3020819166,
  MCO: 3037204123,
  MLM: 3037204279,
  MLU: 3037204685,
} as const satisfies Record<string, number>;

export type MlPostSaleAgentSite = keyof typeof ML_POST_SALE_AGENT_USER_ID;

/**
 * The agent for a site, defaulting to **MLB** — this ERP sells in Brazil, and a
 * `null`/unknown `site_id` on a message is far more likely to be a field ML did
 * not send than a genuinely different marketplace.
 */
export function postSaleAgentUserId(siteId: string | null | undefined): number {
  const key = (siteId ?? '').trim().toUpperCase();
  return ML_POST_SALE_AGENT_USER_ID[key as MlPostSaleAgentSite] ?? ML_POST_SALE_AGENT_USER_ID.MLB;
}

/** `POST /answers` — the shape ML accepts for answering a question. */
export const mlAnswerResultSchema = z
  .object({
    id: z.union([z.number(), z.string()]).nullable().default(null),
    status: z.string().nullable().default(null),
    text: z.string().nullable().default(null),
    date_created: z.string().nullable().default(null),
  })
  .passthrough();
export type MlAnswerResult = z.infer<typeof mlAnswerResultSchema>;

/* ------------------- Claim resolution / respond (#768) -------------------- */

/**
 * One entry of `GET /post-purchase/v1/claims/{id}/partial-refund/available-offers`.
 *
 * ⚠️ **The percentage is an allow-list, not a slider.** ML rejects anything not
 * on this list with `400 "Percentage not found 35.0"`, and refuses 100% through
 * the partial endpoint entirely (that is the full-refund one). A caller that
 * wants to refund an AMOUNT has to find the offer matching it here first —
 * inventing a percentage silently refunds a different sum or fails.
 */
export const mlPartialRefundOfferSchema = z
  .object({
    amount: wireNumber().nullable().default(null),
    percentage: wireNumber().nullable().default(null),
  })
  .passthrough();
export type MlPartialRefundOffer = z.infer<typeof mlPartialRefundOfferSchema>;

/**
 * One `recommendations`/`restrictions` entry on the `available-offers` envelope.
 *
 * ⚠️ `type` is a plain nullable string, never an enum. ML publishes `"maximum"`
 * and `"minimum"` today and adds vocabulary without notice; a Zod enum here
 * would turn a new value into a parse failure on the whole offers read, which
 * would take the partial-refund picker down rather than degrade it.
 */
export const mlPartialRefundAdviceSchema = z
  .object({
    // ⚠️ Tolerant like every other numeric in this file — a quoted `"30"` must not
    // fail the read. `wireNumber()` rather than the hand-rolled union this started
    // as: that one coerced with a bare `Number(v)`, which reads `'1e3'` as 1000
    // and `'0x1F'` as 31. `@delfrance/core/wire` is the one place that rule is written.
    // `.catch(null)` keeps a percentage ML sends as garbage from taking the whole
    // offers read down — this is advice for a human, not a value anything decides
    // on, so degrading it beats failing the picker.
    percentage: wireNumber().nullable().default(null).catch(null),
    reason: z.string().nullable().default(null).catch(null),
    type: z.string().nullable().default(null).catch(null),
  })
  .passthrough();
export type MlPartialRefundAdvice = z.infer<typeof mlPartialRefundAdviceSchema>;

/**
 * The `available-offers` envelope.
 *
 * ⚠️ `recommendations`/`restrictions` used to ride `.passthrough()` untyped, on
 * the grounds that they are "advice for a human, and nothing here decides on
 * them". That was true while nothing rendered them. The resolution UI does: a
 * `type: "minimum"` restriction is the difference between ML answering
 * `400 invalid/below minimum` AFTER the operator commits, and the offer being
 * unclickable in the first place. Typed so the picker can read them.
 */
export const mlPartialRefundOffersSchema = z
  .object({
    currency_id: z.string().nullable().default(null),
    available_offers: z
      .array(mlPartialRefundOfferSchema)
      .nullish()
      .transform((v) => v ?? []),
    // ⚠️ `.catch([])`, the idiom this file already uses (see `.catch(null)` on
    // the order schema above). Typing these turned the CONTAINER strict where it
    // was `.passthrough()`-tolerant, which is the same failure mode by another
    // door: a shape drift stopped degrading the ADVICE and started failing the
    // whole offers read → `MercadoLivreValidationError` → the picker is down.
    // An object instead of an array, an array of strings, a quoted number — all
    // parsed before and must keep parsing. Advice is exactly the field that may
    // be lost without costing the operator the decision.
    recommendations: z
      .array(mlPartialRefundAdviceSchema)
      .nullish()
      .transform((v) => v ?? [])
      .catch([]),
    restrictions: z
      .array(mlPartialRefundAdviceSchema)
      .nullish()
      .transform((v) => v ?? [])
      .catch([]),
  })
  .passthrough();
export type MlPartialRefundOffers = z.infer<typeof mlPartialRefundOffersSchema>;

/**
 * One `expected_resolutions` entry — what each party wants out of the claim.
 * Every resolution POST answers with the refreshed list, so this doubles as the
 * write result.
 */
export const mlExpectedResolutionSchema = z
  .object({
    player_role: z.string().nullable().default(null),
    user_id: wireInt().nullable().default(null),
    expected_resolution: z.string().nullable().default(null),
    status: z.string().nullable().default(null),
  })
  .passthrough();
export type MlExpectedResolution = z.infer<typeof mlExpectedResolutionSchema>;

/** The array every `/expected-resolutions/*` POST returns. */
export const mlExpectedResolutionsSchema = z.array(mlExpectedResolutionSchema);

/** `POST /post-purchase/v1/claims/{id}/attachments` — the stored file key. */
export const mlClaimAttachmentUploadSchema = z
  .object({
    filename: z.string(),
    user_id: wireInt().nullable().default(null),
  })
  .passthrough();
export type MlClaimAttachmentUpload = z.infer<typeof mlClaimAttachmentUploadSchema>;

/**
 * Post-sale MESSAGE attachment limits — deliberately separate from
 * {@link ML_CLAIM_ANEXO}, which they do not match.
 *
 * ML: 25 MB, JPG/PNG/PDF/TXT, at most 25 per message, `original_filename` up to
 * 200 chars. (Claims: 5 MB, no TXT, filename up to 125.)
 *
 * ⚠️ **Documentation-only today — nothing reads it.** The download path
 * (`orderMessageAttachments.ts`) validates neither size, format nor count: ML is
 * the one enforcing them, and a file it already accepted on the way IN is one we
 * can always fetch back. Same status as {@link ML_CLAIM_ANEXO}'s size/format
 * fields on the download half. What the separation buys is that the numbers are
 * recorded per endpoint, so whoever adds an OUTBOUND post-sale attachment (the
 * upload direction, where the limits are enforced BEFORE spending a write
 * against the shared 500 rpm) reaches for the right ones instead of the claim
 * values sitting next door.
 */
export const ML_POST_SALE_ANEXO = {
  maxBytes: 25_000_000,
  formatos: ['jpg', 'jpeg', 'png', 'pdf', 'txt'] as readonly string[],
  maxPorMensagem: 25,
  maxNomeOriginal: 200,
} as const;

/**
 * ML's claim-attachment rules, from the post-purchase reference. Enforced
 * BEFORE the upload: a rejected file wastes a write against the shared 500 rpm
 * budget and returns an error the operator cannot act on.
 *
 * ⚠️ Attachments also EXPIRE: one not attached to a message within 48h is
 * deleted and its key stops working.
 */
export const ML_CLAIM_ANEXO = {
  maxBytes: 5_000_000,
  formatos: ['jpg', 'jpeg', 'png', 'pdf'] as readonly string[],
  maxNomeArquivo: 125,
  /** ML: "letras, números, pontos, hífens e sublinhados". */
  nomeArquivoPermitido: /^[a-zA-Z0-9_\-.]+$/,
} as const;

/* --------------------- Moderações / moderations (#1087) -------------------- */

/**
 * One `evidences[]` entry — WHERE ML found the infraction.
 *
 * `section_name` is the useful half (`pictures`, `title`, `category`, `item`);
 * `text_matched` is the offending value itself (a picture id, a matched phrase,
 * an internal process name).
 */
export const mlModerationEvidenceSchema = z
  .object({
    text_matched: z.string().nullable().default(null),
    section_name: z.string().nullable().default(null),
  })
  .passthrough();
export type MlModerationEvidence = z.infer<typeof mlModerationEvidenceSchema>;

/**
 * One `wordings[]` entry — the human-facing text.
 *
 * `type` is `REASON` (why) or `REMEDY` (how to fix). ⚠️ A moderation that cannot
 * be recovered from carries a REASON and **no** REMEDY at all; ML's docs say so
 * outright for a removed listing. Absence is meaningful, so `type` stays a plain
 * nullable string rather than an enum that could reject an unseen third value
 * and take the whole moderation down with it.
 */
export const mlModerationWordingSchema = z
  .object({
    type: z.string().nullable().default(null),
    value: z.string().nullable().default(null),
  })
  .passthrough();
export type MlModerationWording = z.infer<typeof mlModerationWordingSchema>;

/**
 * `GET /moderations/last_moderation/{element_id}-ITM` — ONE active moderation.
 *
 * ⚠️ Deliberately tolerant, and the tolerance is not defensive padding — every
 * deviation admitted here appears in ML's OWN published responses:
 *
 *  - the evidence key is spelled **`evidences`** on *Gerenciar moderações* and
 *    **`evidence`** on *Moderações com pausa* and *Moderações de imagens*. Both
 *    are accepted; the mapper unions them.
 *  - `wordings` is **optional**. Unlike the two above this is not something ML's
 *    pages demonstrate — every published sample carries it. It is defensive on
 *    purpose: those same pages already disagree with each other about
 *    `evidence`/`evidences`, so they are plainly not an exhaustive spec, and a
 *    missing `wordings` must degrade to "moderated, no text" rather than take the
 *    whole read down. `mapModeracoes` keeps such an entry on its `name`.
 *  - `date_created` arrives in TWO formats — `2021-04-14T10:47:05.270-0400` and
 *    `2022-10-25 15:57:46.0` — so it stays a raw string here and everywhere
 *    downstream (`delfrance/no-lossy-date-parse`).
 *  - `id` is a stringified number in every sample, but is not persisted: the docs
 *    warn it "deixa de existir" once the moderation resolves and must never be
 *    used as a persistent reference.
 *
 * A strict schema would throw `MercadoLivreValidationError` on any of these and
 * lose the whole explanation — which is the exact outcome this feature exists to
 * end.
 */
export const mlModerationSchema = z
  .object({
    name: z.string().nullable().default(null),
    id: z.union([z.string(), z.number()]).nullable().default(null),
    date_created: z.string().nullable().default(null),
    evidences: z.array(mlModerationEvidenceSchema).nullable().default(null),
    /** ML's alternate spelling of {@link mlModerationSchema.shape.evidences}. */
    evidence: z.array(mlModerationEvidenceSchema).nullable().default(null),
    wordings: z.array(mlModerationWordingSchema).nullable().default(null),
  })
  .passthrough();
export type MlModeration = z.infer<typeof mlModerationSchema>;

/**
 * The endpoint answers with an ARRAY, even though it is named
 * `last_moderation` — every documented sample is a one-element list.
 */
export const mlModerationsSchema = z.array(mlModerationSchema);

/**
 * ML `element_type` suffixes for a `moderation_reference_id`
 * (`{element_id}-{suffix}`). Only `ITM` is used here; the other two are
 * documented so a future questions/reviews reader does not re-derive them.
 */
export const ML_MODERATION_ELEMENT = {
  item: 'ITM',
  pergunta: 'QUE',
  avaliacao: 'REV',
} as const;
