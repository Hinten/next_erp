/**
 * Build the `POST /items` / `PUT /items/{id}` payload — a faithful port of the
 * old Flutter `ProdutoMercadoLivre.toMercadoLivre()` (models.dart 1425–1547):
 *
 *  - User-Products sellers send `family_name` (ML titles the listing) and NO
 *    variations array; legacy sellers send `title` + `variations[]`.
 *  - Create-only fields: `category_id`, `currency_id: 'BRL'`, `condition`,
 *    `site_id: 'MLB'`, `buying_mode: 'buy_it_now'`, `listing_type_id`, and
 *    `seller_custom_field` = the Firestore link-doc id (the back-reference the
 *    import/notification flows use).
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
  /** New User-Products seller → `family_name`, no variations array. */
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
    data.family_name = input.title;
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
  const combinationIds = new Set(
    variations.flatMap((v) => v.attributeCombinations.map((a) => a.id)),
  );
  const parentAttributes = attributesWithValue(input.attributes ?? []).filter(
    (a) => !combinationIds.has(a.id) && !(hasVariations && a.id === 'SELLER_SKU'),
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
    default:
      return ESTADO_PUBLICACAO.error;
  }
}
