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
 *    variation (parent `available_quantity` removed; parent `price` removed
 *    on update), carry `seller_custom_field` = the variation produto doc id,
 *    inherit the parent pictures when they have none, and any attribute id
 *    used in a combination is dropped from the parent `attributes`.
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
  /** Display order (`_order`), from the child produto's `ordem`. */
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

  // Any attribute id used as a variation combination must NOT repeat at the
  // parent level (ML rejects the overlap).
  const combinationIds = new Set(
    variations.flatMap((v) => v.attributeCombinations.map((a) => a.id)),
  );
  const parentAttributes = attributesWithValue(input.attributes ?? []).filter(
    (a) => !combinationIds.has(a.id),
  );
  data.attributes = parentAttributes.map(attributeToMercadoLivre);

  if (input.price != null) data.price = input.price;
  data.pictures = (input.pictures ?? []).map((p) => ({ id: p.id }));
  if (input.availableQuantity != null) data.available_quantity = input.availableQuantity;
  if (input.videoId != null) data.video_id = input.videoId;

  if (variations.length > 0) {
    // Quantities (and, on update, the price) live at the variation level.
    delete data.available_quantity;
    const parentPictureIds = (input.pictures ?? []).map((p) => p.id);
    data.variations = variations.map((v) =>
      buildVariationPayload(v, {
        isUpdate: input.isUpdate,
        price: input.price ?? null,
        parentPictureIds,
      }),
    );
    if (input.isUpdate) delete data.price;
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
  if (v.order != null) out._order = v.order;
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
