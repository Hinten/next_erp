/**
 * Build the `POST /items` / `PUT /items/{id}` payload — a faithful port of the
 * old Flutter `ProdutoMercadoLivre.toMercadoLivre()` (models.dart 1425–1547):
 *
 *  - User-Products sellers send `family_name` (ML titles the listing) and NO
 *    variations array; legacy sellers send `title` + `variations[]`.
 *    ⚠️ `family_name` is CREATE-ONLY — see the note on the assignment itself —
 *    so a User-Products UPDATE carries no name field at all, while a legacy one
 *    still carries `title` (a rename is legitimate there).
 *    ⚠️ A User-Products produto that HAS variations does not come through here
 *    at all: each variation is its own ML item, built one at a time by
 *    {@link buildUserProductItemPayload}. This function only serves a UP produto
 *    with no children (one item, one implicit user product).
 *  - Create-only fields: `family_name` (User Products only), `category_id`,
 *    `currency_id: 'BRL'`, `condition`, `site_id: 'MLB'`,
 *    `buying_mode: 'buy_it_now'`, `listing_type_id`, and `seller_custom_field`
 *    = the Firestore link-doc id (the back-reference the import/notification
 *    flows use).
 *  - Update: `status: 'active'` (reactivates a paused listing on edit).
 *  - Legacy variations move `available_quantity`/`price` down to each
 *    variation, carry `seller_custom_field` = the variation produto doc id,
 *    inherit the parent pictures when they have none, and any attribute id
 *    used in a combination — plus `SELLER_SKU` — is dropped from the parent
 *    `attributes`.
 *
 * Two legacy invariants that read as bugs until you follow them through the
 * Dart, both restored here (#799):
 *
 *  - **The item-root `price` reaches ML only on a CREATE with no variations.**
 *    `models.dart:1425` declares `final bool update = id == null` — a misnomer:
 *    that flag is true when the item has NEVER been published, i.e. on create.
 *    Guarded by it, `models.dart:1530` strips the parent `price` on a create
 *    WITH variations, and both publish call sites strip it again on every real
 *    update (`exportarProdutos.dart:586` legacy, `:466` User-Products). A price
 *    *change* is a dedicated `PUT /items/{id}` (precoSync), never a publish.
 *  - **`_order` never reaches ML.** It is an internal sort key: the legacy
 *    builds it, sorts the variation list by it, then deletes it
 *    (`models.dart:1392-1395`). So we sort and omit — previously we leaked the
 *    ERP's `produto.ordem` into an ML-internal field AND skipped the sort it
 *    existed for.
 *
 * ⚠️ **Variation order has NO equivalent under User Products, and is lost at
 * migration.** In the legacy model the `variations` array is the display order,
 * which is what `order` exists to control. Under UP that array ceases to exist:
 * each variation becomes its own item, items are grouped into an auto-computed
 * family (`family_id`), and the family renders as pickers on the UPP. ML exposes
 * no ordering field anywhere in that surface — not `POST /items`, not
 * `POST /user-products-families/{family_id}/user-products`, not
 * `POST /user-products/{up_id}/items`, not the family-editor task — so the seller
 * cannot control picker order at all and `produto.ordem` has nowhere to go.
 * Do not look for one; do not invent a proxy for it.
 */
import { type MlAttribute, attributeToMercadoLivre, attributesWithValue } from './attributes';

/** An already-uploaded ML picture reference (`pictures: [{ id }]`). */
export interface ItemPictureRef {
  id: string;
}

export interface ItemVariationInput {
  /** ML variation id — include only when updating an existing variation. */
  mlVariationId?: number | string | null;
  /** The variation child produto doc id → `seller_custom_field` (back-ref). */
  produtoId: string;
  /**
   * Display order, from the child produto's `ordem`. Sorts the emitted
   * `variations` array and is then DROPPED — ML never receives it. Absent
   * orders sort as 0 (first), matching `models.dart:1392`'s `?? 0`.
   */
  order?: number | null;
  availableQuantity: number;
  /**
   * This member's own price, User-Products only — there each variation is its
   * own ML item and may be priced independently
   * (`propagatePriceToChildren: false`). **Ignored by the legacy branch**, whose
   * variations must all carry the SAME price or ML rejects the PUT; that branch
   * copies the item-root price down instead.
   */
  price?: number | null;
  /** ML picture ids; when empty the parent's pictures are inherited. */
  pictureIds?: ReadonlyArray<string>;
  /** Combination attributes (SIZE/COLOR…) that define this variation. */
  attributeCombinations: ReadonlyArray<MlAttribute>;
  /** Non-combination variation attributes (SELLER_SKU, SIZE_GRID_ROW_ID…). */
  attributes?: ReadonlyArray<MlAttribute>;
}

export interface BuildItemPayloadInput {
  /** PUT (existing ML item) vs POST (first publish). */
  isUpdate: boolean;
  /**
   * User-Products seller → `family_name` instead of `title`, and no variations
   * array. ⚠️ That name field is CREATE-ONLY — see {@link buildItemPayload}.
   */
  isUserProductSeller: boolean;
  title: string;
  condition: 'new' | 'used';
  /** Link-doc id — `seller_custom_field` on create. */
  sellerCustomField: string;
  categoryId?: string | null;
  listingTypeId?: string | null;
  price?: number | null;
  availableQuantity?: number | null;
  pictures?: ReadonlyArray<ItemPictureRef>;
  videoId?: string | null;
  /** Parent-level attributes (already built; combination ids are pruned here). */
  attributes?: ReadonlyArray<MlAttribute>;
  /** Legacy-model variations; ignored for User-Products sellers. */
  variations?: ReadonlyArray<ItemVariationInput>;
}

export function buildItemPayload(input: BuildItemPayloadInput): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  if (input.isUserProductSeller) {
    // ⚠️ CREATE-ONLY, for the two reasons spelled out on
    // {@link buildUserProductItemPayload} below: ML rejects editing
    // `family_name` once any condition of the family has sales, and the value
    // feeds the family-id hash. This branch is the SINGLE-ITEM half of the same
    // model (a User-Products produto with no children), and it used to send the
    // field on every republish — `ML 400 BODY_INVALID_FIELDS` / `The field
    // family name is invalid`, the exact rejection the sibling already avoids.
    // So an update sends no name field at all: never a `title` either, since ML
    // derives that from `family_name` + the attributes.
    if (!input.isUpdate) data.family_name = input.title;
  } else {
    data.title = input.title;
  }

  if (!input.isUpdate) {
    if (input.categoryId != null) data.category_id = input.categoryId;
    data.currency_id = 'BRL';
    data.condition = input.condition;
    data.site_id = 'MLB';
    data.buying_mode = 'buy_it_now';
    if (input.listingTypeId != null) data.listing_type_id = input.listingTypeId;
    data.seller_custom_field = input.sellerCustomField;
  } else {
    // Editing always reactivates (the old app's behavior).
    data.status = 'active';
  }

  const variations = input.isUserProductSeller ? [] : (input.variations ?? []);
  const hasVariations = variations.length > 0;

  // Any attribute id used as a variation combination must NOT repeat at the
  // parent level (ML rejects the overlap). `SELLER_SKU` needs the same
  // treatment but the combination prune can never catch it: each variation
  // carries its own SKU in `attributes`, never in `attributeCombinations`, so
  // the parent's would survive alongside them. The legacy removes it by id
  // (models.dart:1508-1515) and only re-adds it on the no-variations branch.
  // An id-less combination is a custom characteristic (identified by `name`),
  // which by definition has no counterpart in the parent's attribute list.
  const combinationIds = new Set(
    variations.flatMap((v) => v.attributeCombinations.flatMap((a) => (a.id != null ? [a.id] : []))),
  );
  const parentAttributes = attributesWithValue(input.attributes ?? []).filter(
    (a) => !(a.id != null && combinationIds.has(a.id)) && !(hasVariations && a.id === 'SELLER_SKU'),
  );
  data.attributes = parentAttributes.map(attributeToMercadoLivre);

  // Create-only, and never alongside variations — see the module docblock.
  if (input.price != null && !input.isUpdate && !hasVariations) data.price = input.price;
  data.pictures = (input.pictures ?? []).map((p) => ({ id: p.id }));
  // Quantities live at the variation level once there are variations.
  if (input.availableQuantity != null && !hasVariations) {
    data.available_quantity = input.availableQuantity;
  }
  if (input.videoId != null) data.video_id = input.videoId;

  if (hasVariations) {
    const parentPictureIds = (input.pictures ?? []).map((p) => p.id);
    // Sort by the internal `order` key, then emit without it. Array#sort is
    // stable, so equal orders keep the caller's sequence.
    const ordered = [...variations].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    data.variations = ordered.map((v) =>
      buildVariationPayload(v, {
        isUpdate: input.isUpdate,
        price: input.price ?? null,
        parentPictureIds,
      }),
    );
  }

  return data;
}

function buildVariationPayload(
  v: ItemVariationInput,
  ctx: { isUpdate: boolean; price: number | null; parentPictureIds: ReadonlyArray<string> },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ctx.isUpdate && v.mlVariationId != null) out.id = v.mlVariationId;
  out.seller_custom_field = v.produtoId;
  // `order` deliberately not emitted — it only sorted the caller's array.
  out.attributes = attributesWithValue(v.attributes ?? []).map(attributeToMercadoLivre);
  const pictureIds = v.pictureIds && v.pictureIds.length > 0 ? v.pictureIds : ctx.parentPictureIds;
  out.picture_ids = [...pictureIds];
  out.attribute_combinations = v.attributeCombinations.map(attributeToMercadoLivre);
  out.available_quantity = v.availableQuantity;
  if (ctx.price != null) out.price = ctx.price;
  return out;
}

/* ----------------------------- User Products ------------------------------ */

/**
 * One family member's `POST /items` / `PUT /items/{id}` body. Port of the old
 * Flutter `VariacoesML.toMercadoLivreUserProduct()` (models.dart 1750–1917).
 *
 * Under User Products a produto with variations is **not** one item with a
 * variations array — it is N items sharing a `family_name`, from which ML
 * derives the family and one `user_product_id` per member. So this is called
 * once per member, and {@link buildItemPayload} is never called at all for such
 * a produto.
 */
export interface BuildUserProductItemPayloadInput {
  /**
   * PUT an existing member item vs POST a new one. ⚠️ Decided **per member**
   * (its `variacaoMercadoLivre.itemId`), never by the parent link's `id` — for
   * a User-Products family that field holds the FAMILY id, which is not an item
   * id and would `PUT /items/{familyId}` into a 4xx.
   */
  isUpdate: boolean;
  /** Shared across the family; ML derives each item's own title from it. */
  familyName: string;
  condition: 'new' | 'used';
  categoryId?: string | null;
  listingTypeId?: string | null;
  /** This member's price. Create-only — see the note below. */
  price?: number | null;
  videoId?: string | null;
  /** Family-level attributes; the member's own override these by id. */
  attributes?: ReadonlyArray<MlAttribute>;
  /** Family gallery, inherited when the member has no pictures of its own. */
  pictures?: ReadonlyArray<ItemPictureRef>;
  /** The single variation this item IS. */
  member: ItemVariationInput;
}

export function buildUserProductItemPayload(
  input: BuildUserProductItemPayloadInput,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  if (!input.isUpdate) {
    // ⚠️ `family_name` is CREATE-ONLY, for two independent reasons: ML rejects
    // editing it once any condition of the family has sales, and it is an input
    // to the family-id hash — so a PUT carrying it can silently move the member
    // into a DIFFERENT family. Legacy strips it from the PUT at the call site
    // (`exportarProdutos.dart:246-247`); we strip it here instead, so no caller
    // can forget.
    data.family_name = input.familyName;
    if (input.categoryId != null) data.category_id = input.categoryId;
    data.condition = input.condition;
    data.site_id = 'MLB';
    data.buying_mode = 'buy_it_now';
    if (input.listingTypeId != null) data.listing_type_id = input.listingTypeId;
    // Create-only, exactly as the legacy model's item-root price is. Prices are
    // owned by the manual price flow (`precoSync`) — a republish that carried
    // one would bypass its "Permitir baixar preços" guard, and would 400 the
    // whole member on an item with an active ML price automation
    // (`item.price.not_modifiable`).
    if (input.price != null) data.price = input.price;
  }

  // ⚠️ NEVER a `title`: ML computes it from `family_name` + the attributes, and
  // a write to it is a bad request. Nor a `variations` array — the model has no
  // such thing (a POST/PUT carrying one is rejected).

  // Both sent on create AND update, legacy parity (`models.dart:1770-1772`).
  // `seller_custom_field` on the update too is what lets a republish self-heal a
  // member whose back-reference was never set — an imported one, say.
  data.currency_id = 'BRL';
  data.seller_custom_field = input.member.produtoId;

  // The member's identity attributes (SIZE/COLOR, or an id-less custom
  // characteristic) ride the ordinary `attributes` array: `attribute_combinations`
  // is a legacy-model field on the way IN, and appears only at the item ROOT on
  // the way out. Family-level attributes lose to the member's own by id — the
  // legacy `removeWhere`-then-add, which is what makes the member SELLER_SKU
  // beat the parent's (`models.dart:1886-1898`).
  const memberAttributes = attributesWithValue([
    ...(input.member.attributes ?? []),
    ...input.member.attributeCombinations,
  ]);
  const memberIds = new Set(memberAttributes.flatMap((a) => (a.id != null ? [a.id] : [])));
  const familyAttributes = attributesWithValue(input.attributes ?? []).filter(
    (a) => !(a.id != null && memberIds.has(a.id)),
  );
  data.attributes = [...familyAttributes, ...memberAttributes].map(attributeToMercadoLivre);

  const pictureIds =
    input.member.pictureIds && input.member.pictureIds.length > 0
      ? input.member.pictureIds
      : (input.pictures ?? []).map((p) => p.id);
  data.pictures = pictureIds.map((id) => ({ id }));

  // ⚠️ Always sent, virtual kits included. `POST /items` requires a quantity and
  // this port never creates an ML Virtual Kit (`POST /items/kits`), so there is
  // nothing for ML to derive one from — see `apps/mercado-livre/CLAUDE.md`.
  data.available_quantity = input.member.availableQuantity;
  if (input.videoId != null) data.video_id = input.videoId;

  return data;
}

/**
 * Project a legacy-shaped {@link BuildItemPayloadInput} onto one input per
 * family member, so the orchestrator can reuse the whole existing assembly
 * (combination mapping, cross-child validation, size-chart binding) unchanged.
 *
 * `isUpdate` is deliberately absent from the result: it is per member and only
 * the caller, holding each child's `variacaoMercadoLivre.itemId`, can decide it.
 *
 * ⚠️ Member ORDER carries no meaning — there is no ordering field anywhere in
 * the User-Products surface (see the module docblock). The array is returned in
 * the caller's own sequence purely so a run is reproducible.
 */
export function userProductMemberInputs(
  input: BuildItemPayloadInput,
): Array<Omit<BuildUserProductItemPayloadInput, 'isUpdate'>> {
  return (input.variations ?? []).map((member) => ({
    familyName: input.title,
    condition: input.condition,
    categoryId: input.categoryId,
    listingTypeId: input.listingTypeId,
    price: member.price ?? input.price,
    videoId: input.videoId,
    attributes: input.attributes,
    pictures: input.pictures,
    member,
  }));
}

/**
 * ML listing `status` → the link doc's `estado` short code, 1–2 chars (the old
 * `ESTADO_PUBLICACAO.fromMercadoLivre`, models.dart 676–694).
 */
export const ESTADO_PUBLICACAO = {
  rascunho: 'r',
  aguardando: 'a',
  emProcessamento: 'ep',
  underReview: 'v',
  publicado: 'p',
  pausado: 'pa',
  cancelado: 'c',
  error: 'E',
  aguardandoMigracao: 'am',
} as const;
export type EstadoPublicacao = (typeof ESTADO_PUBLICACAO)[keyof typeof ESTADO_PUBLICACAO];

export function estadoFromMlStatus(status: string | null | undefined): EstadoPublicacao {
  switch (status) {
    case 'active':
      return ESTADO_PUBLICACAO.publicado;
    case 'paused':
      return ESTADO_PUBLICACAO.pausado;
    case 'closed':
      return ESTADO_PUBLICACAO.cancelado;
    case 'under_review':
      return ESTADO_PUBLICACAO.underReview;
    case null:
    case undefined:
      return ESTADO_PUBLICACAO.error;
    default:
      return ESTADO_PUBLICACAO.error;
  }
}
