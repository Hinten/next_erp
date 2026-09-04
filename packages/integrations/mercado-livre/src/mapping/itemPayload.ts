/**
 * Build the `POST /items` / `PUT /items/{id}` payload — a faithful port of the
 * old Flutter `ProdutoMercadoLivre.toMercadoLivre()` (models.dart 1425–1547):
 *
 *  - User-Products sellers send `family_name` (ML titles the listing) and NO
 *    variations array; legacy sellers send `title` + `variations[]`.
 *    ⚠️ `family_name` is CREATE-ONLY — see the note on the assignment itself —
 *    so a User-Products UPDATE carries no name field at all, while a legacy one
 *    still carries `title` (a rename is legitimate there).
 *    ⚠️ A User-Products produto does not come through here at all any more:
 *    every variation is its own ML item, built one at a time by
 *    {@link buildUserProductItemPayload}. Since #1087 that includes the SINGLE —
 *    ML auto-generates a family for every user product, so publish materialises
 *    the sole member and takes the family path for it too, which is what makes a
 *    produto survive delete → re-import. The `isUserProductSeller` branch below
 *    is therefore unreachable from `publish.ts`; it is kept because the flag is
 *    still what `userProductMemberInputs` reads to project each member, and
 *    removing it would make this builder silently wrong for any future caller.
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
import {
  ESTADO_PUBLICACAO_ML,
  type EstadoPublicacaoMl,
  moderacaoRemoveuAnuncio,
} from '@delfrance/schemas';

import { type MlAttribute, attributeToMercadoLivre, attributesWithValue } from './attributes';

/** An already-uploaded ML picture reference (`pictures: [{ id }]`). */
export interface ItemPictureRef {
  id: string;
}

/**
 * `shipping.mode` on `POST`/`PUT /items`.
 *
 * ⚠️ Structural, not imported from `@delfrance/schemas` — this package stays
 * platform-neutral (same reason as `MedidaReferenceChart` and the incident
 * adapters). The stored ERP enum is `modoEnvioMercadoLivreSchema`; the bridge
 * that reads the conta and hands the value down lives in `apps/mercado-livre`.
 *
 * `'custom'` is absent on purpose: it carries a `costs[]` table this repo does
 * not model, and sending the mode without one publishes an empty cost table.
 */
export type MlShippingMode = 'me2' | 'me1' | 'not_specified';

/**
 * The `shipping` node, or nothing.
 *
 * ⚠️ Sent on **create AND update**, deliberately unlike `category_id`,
 * `condition`, `listing_type_id` and `price` around it. ML accepts `shipping`
 * on a `PUT /items/{id}`, and that is what lets a republish self-heal a listing
 * already sitting at "a combinar" — the alternative was a one-off backfill
 * script over every existing item. The accepted cost is that an operator who
 * changes the mode in ML's own UI loses it to the next ERP republish; the conta
 * setting is the ERP's declared intent and wins.
 *
 * Null/absent emits NO key at all, which is the pre-existing behaviour — so a
 * conta nobody configured publishes byte-identically to before this field.
 *
 * Only `mode` rides. `free_shipping` is deliberately never sent: ML applies
 * `mandatory_free_shipping` itself above a price threshold and documents that
 * free shipping cannot be forced through the API, so writing a stored value
 * would fight an authoritative remote one. `local_pick_up` is an account-level
 * preference and `free_methods` only means anything when `free_shipping` is
 * true, so both would be second copies of something we do not own.
 *
 * ## ⚠️ The update path is all-or-nothing, and one quadrant is UNVERIFIED
 *
 * Because this rides on every `PUT`, a republish whose real intent is a
 * price/stock/picture edit now also depends on ML accepting a shipping-mode
 * write. The unverified quadrant is an item **with sales** at `not_specified`
 * on a conta configured `me2`. If ML refused that, the whole republish 400s
 * where it used to succeed: one `updateItem` call owns the request
 * (`publish.ts`), its catch stamps `estado: 'E'`, and `shipping` is absent from
 * `REFERENCE_FIELDS` (`publishFalhas.ts`) so the cause renders above the form
 * pinned to no control. The class is real — it is why `family_name` is stripped
 * on update just below, and why `titleEditability` exists in apps/web.
 *
 * It was left unguarded on PURPOSE, on this evidence: ML's documented failure
 * mode for a shipping-mode write it will not honour is **200 with the change
 * silently not applied**, not a 4xx. Its own FAQ says so twice for the mirror
 * case — a `PUT` setting `mode: 'me1'` on an ME2-enabled conta "pode retornar
 * uma resposta 200 de sucesso sem que a alteração seja efetivamente aplicada",
 * leaving the item `not_specified`. A silent no-op costs nothing here; a 400
 * would. Guarding a failure ML appears not to produce would be dead code in the
 * one file whose header already warns about inventing mechanisms.
 *
 * ⚠️ **`POST /items/validate` cannot settle it** — it validates a CREATE body
 * and knows nothing of an existing item's sales. The check that does: republish
 * a SOLD `not_specified` listing from a `me2` conta during the #1087 live run.
 * If it 400s with a `shipping.*` cause, the containment is a bounded one-shot
 * retry with the key removed, in the `pruneDeadPictures` mould (`publish.ts`) —
 * degrade to the pre-#1273 body rather than fail the publish.
 */
function applyShipping(
  data: Record<string, unknown>,
  mode: MlShippingMode | null | undefined,
): void {
  if (mode != null) data.shipping = { mode };
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
  /**
   * The conta's `shipping.mode`. Null/absent sends no `shipping` node, leaving
   * ML to apply the account default — see {@link applyShipping}.
   */
  shippingMode?: MlShippingMode | null;
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
  applyShipping(data, input.shippingMode);

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
  /**
   * The conta's `shipping.mode`, shared by every member of the family — see
   * {@link applyShipping}. Under User Products each member is its OWN ML item,
   * so the node has to ride on each one; a family does not carry it centrally.
   */
  shippingMode?: MlShippingMode | null;
  /**
   * True when this family has exactly ONE member (#1087) — the User-Products
   * shape of what used to be a plain simple item.
   *
   * ⚠️ It exists for ONE reason: `buildItemPayload` reactivates a paused listing
   * on every edit ("the old app's behavior"), and routing the sole member through
   * this builder would silently drop that — an operator who pauses a listing,
   * edits it and republishes would find it still paused, with nothing to say why.
   * A REAL family deliberately keeps the old behaviour: reactivating every member
   * because one was edited is a decision no one asked for.
   */
  soleMember?: boolean;
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

  // Editing reactivates — but only for a family of ONE, where this builder stands
  // in for `buildItemPayload` and has to keep its behaviour (see `soleMember`).
  if (input.isUpdate && input.soleMember === true) {
    data.status = 'active';
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
  applyShipping(data, input.shippingMode);

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
    shippingMode: input.shippingMode,
    soleMember: (input.variations ?? []).length === 1,
    // ⚠️ Load-bearing: this is the ONLY thing that puts a `shipping` node on a
    // User-Products family. `publishUserProductMembers` builds every member from
    // this projection, so dropping it here would ship single items with a mode
    // and leave every VARIATION family at "a combinar" — worse than the uniform
    // bug it replaces, because it looks fixed.
    member,
  }));
}

/**
 * ML listing `status` + `sub_status` → the link doc's `estado` short code, 1–2
 * chars (the old `ESTADO_PUBLICACAO.fromMercadoLivre`, models.dart 676–694).
 *
 * ⚠️ This used to carry its OWN copy of the estado vocabulary — a second
 * `ESTADO_PUBLICACAO` const, with drifted member names (`underReview` for
 * `emRevisao`, `error` for `erro`) and a plain `as const` that the compiler
 * linked to nothing. It existed only because this package had no dependency on
 * `@delfrance/schemas`, which is exactly the "two copies drift toward plausible"
 * shape root `CLAUDE.md` names: adding a member to the schema enum produced zero
 * errors here, in the one function that decides what `estado` every writer
 * stores. The dependency is cheap (schemas pulls `@delfrance/core` + zod, and
 * nothing there imports this package back) and the copy is gone.
 *
 * ⚠️ **`subStatus` is REQUIRED, not optional**, and that is the whole reason the
 * terminal-moderation state is safe to add (#1226). A removed listing is
 * `under_review` + `forbidden` — the STATUS alone cannot tell it from a listing
 * ML is merely reviewing — so an optional parameter would let a call site that
 * forgot it keep mapping a dead listing to `emRevisao`, silently, which is the
 * exact bug. Required makes every one of them a compile error until it decides.
 * Pass `null` deliberately where there genuinely is no sub_status (a synthetic
 * `'closed'` from a 404 branch, say).
 */
export function estadoFromMlStatus(
  status: string | null | undefined,
  subStatus: readonly string[] | null | undefined,
): EstadoPublicacaoMl {
  // ⚠️ ABOVE the `under_review` arm, deliberately: a removed listing IS
  // `under_review`, so the coarse arm below would swallow it.
  if (moderacaoRemoveuAnuncio(status, subStatus)) {
    return ESTADO_PUBLICACAO_ML.removidoPorModeracao;
  }
  switch (status) {
    case 'active':
      return ESTADO_PUBLICACAO_ML.publicado;
    case 'paused':
      return ESTADO_PUBLICACAO_ML.pausado;
    case 'closed':
      return ESTADO_PUBLICACAO_ML.cancelado;
    case 'under_review':
      return ESTADO_PUBLICACAO_ML.emRevisao;
    case null:
    case undefined:
    default:
      return ESTADO_PUBLICACAO_ML.erro;
  }
}
