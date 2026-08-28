/**
 * Pure projection of `GET /categories/{id}/attributes` into the shape the
 * listing editor renders — a port of the legacy `shouldShowAttribute` +
 * `getAttributeWidget` pair (`cadastroSlim.dart:244-270`,
 * `cadastroProdutoMLNew.dart:1179-1384`).
 *
 * This lives on the SERVER, not in a shared package, because the browser must
 * never import `@delfrance/integrations-mercado-livre` (its root carries the
 * OAuth core and the app client secret — see `apps/web/lib/mercado-livre/client.ts`).
 * The route hands `apps/web` an already-filtered, already-normalised DTO, so
 * there is exactly one implementation of "which attributes exist" rather than a
 * server copy and a browser copy that can disagree.
 *
 * No IO here: `MlCategoryAttribute[]` in, DTO out.
 */
import {
  ML_PRODUTO_DERIVED_ATTRIBUTE_IDS,
  ML_PRODUTO_HERDADO_ATTRIBUTE_IDS,
  type MlCategoryAttribute,
  attrTag,
} from '@delfrance/integrations-mercado-livre';

/**
 * Attribute ids the editor must never offer as free-form inputs
 * (`cadastroSlim.dart:244`). Two distinct reasons, both deliberate:
 *
 *  - **Catalogue-owned** — `GTIN` identifies the product itself, and the
 *    `PACKAGE_*` group is ML's own factory-packaging data, which it tags
 *    `read_only`: a seller cannot write those at all, so an input for one is a
 *    field whose value can never leave this screen.
 *  - **Variation-owned** — `COLOR`, `MAIN_COLOR` and `SIZE` come from the
 *    produto's grupo de variações and ride as `attribute_combinations`; typing
 *    a second value here is how you get an ML combination conflict.
 *
 * ⚠️ The produto-derived ids (`SELLER_SKU`, `WEIGHT`, `SELLER_PACKAGE_*`) are
 * NOT here — they have their own reason, {@link attributeOmission}'s `derivado`,
 * because the operator needs a different explanation for them: the value exists,
 * it just lives on the produto. This list carried `SELLER_SKU` and the
 * *`PACKAGE_*`* spelling and claimed to cover the dimensions; it never did, since
 * publish derives `SELLER_PACKAGE_*`.
 *
 * ⚠️ `BRAND` is not here either, and must not be moved here: it is `herdado`, and
 * its stored value is one publish deliberately keeps.
 */
export const ML_BLOCKED_ATTRIBUTE_IDS: readonly string[] = [
  'MAIN_COLOR',
  'COLOR',
  'SIZE',
  'GTIN',
  'PACKAGE_HEIGHT',
  'PACKAGE_WIDTH',
  'PACKAGE_LENGTH',
  'PACKAGE_WEIGHT',
];

/**
 * Size-chart attributes, identified by `value_type` rather than by a tag — the
 * legacy `ehTabelaDeMedidas` getter is exactly this test
 * (`api_response.dart:292`). Getting it wrong renders `SIZE_GRID_ID` as an
 * editable text field, which then fights the chart binding publish resolves.
 */
const SIZE_CHART_VALUE_TYPES: readonly string[] = ['grid_id', 'grid_row_id'];

/**
 * The ITEM-scope half of the pair above — `SIZE_GRID_ID`. `grid_row_id` is the
 * VARIATION half (`SIZE_GRID_ROW_ID`), which rides a variation's attributes and
 * says nothing about whether the item needs a chart.
 */
export const SIZE_GRID_VALUE_TYPE = 'grid_id';

/**
 * Does this category carry a size-chart attribute at all?
 *
 * The gate for publish's local refusal (#1087): a produto that names a tabela
 * whose guias cannot bind here is an operator error worth refusing — but only
 * where a chart is meaningful. A category with no `grid_id` attribute publishes
 * exactly as it always did.
 *
 * ⚠️ Deliberately NOT gated on {@link isAttributeRequired}. ML spells "you must
 * fill this" four different ways depending on the category's vintage and does
 * not set any of them reliably on `SIZE_GRID_ID`, so requiring a tag would let
 * the very category this was reported against (MLB1398) slip through and reach
 * ML anyway. Presence of the attribute is the robust test.
 */
export function categoriaUsaGuiaDeTamanhos(attrs: readonly MlCategoryAttribute[]): boolean {
  return attrs.some((a) => a.value_type === SIZE_GRID_VALUE_TYPE);
}

export type MlAttributeScope = 'item' | 'variacao';

/**
 * Why an attribute was withheld — surfaced so the UI can explain a gap.
 *
 * ⚠️ `derivado` and `herdado` differ in what the SAVE may do with a value already
 * stored on the link doc, not in what the screen shows. Both are produto-filled
 * and neither is offered as an input, but a `derivado` id's stored copy is a
 * stale duplicate of something the produto still holds, so `attributesForSave`
 * prunes it — while a `herdado` id's stored copy IS the fallback and must
 * survive. Collapsing the two erases every brand the operators have typed.
 *
 * ⚠️ `herdado` is consequently an INTERNAL verdict: it decides that an attribute
 * is withheld, and then `projectCategoriaAtributos` reports it in neither array.
 * No client ever receives the string, and none should have to know it.
 */
export type MlAttributeOmission =
  | 'derivado'
  | 'herdado'
  | 'bloqueado'
  | 'oculto'
  | 'tabela-de-medidas'
  | 'somente-variacao'
  | 'somente-item';

export interface CategoriaAtributoDto {
  id: string;
  name: string | null;
  /** `string | number | number_unit | boolean | list`, or whatever ML adds next. */
  valueType: string | null;
  values: Array<{ id: string | null; name: string | null }>;
  /** `hint` with `tooltip` as the fallback — the legacy helper text order. */
  hint: string | null;
  valueMaxLength: number | null;
  defaultUnit: string | null;
  allowedUnits: Array<{ id: string | null; name: string | null }>;
  groupId: string | null;
  groupName: string | null;
  required: boolean;
  multivalued: boolean;
  readOnly: boolean;
  relevance: number | null;
}

export interface CategoriaAtributosResult {
  /** False ⇒ a mid-tree category; ML serves no usable attributes for one. */
  leaf: boolean;
  atributos: CategoriaAtributoDto[];
  omitidos: Array<{ id: string; motivo: MlAttributeOmission }>;
}

/**
 * ML marks "you must fill this" four different ways depending on the category's
 * vintage; the legacy form treated all four identically
 * (`cadastroProdutoMLNew.dart:1128-1131`).
 */
export function isAttributeRequired(attr: MlCategoryAttribute): boolean {
  return (
    attrTag(attr, 'required') ||
    attrTag(attr, 'new_required') ||
    attrTag(attr, 'conditional_required') ||
    attrTag(attr, 'catalog_required')
  );
}

/**
 * Should this attribute be offered for editing at `scope`?
 *
 * Direct port of `cadastroSlim.dart:246-270`. Returns the omission reason
 * rather than a bare boolean so the route can tell the UI *why* a category with
 * 40 attributes only rendered 12.
 *
 * ⚠️ `derivado` is tested FIRST, and it must not be folded into `oculto`. ML
 * tags `SELLER_PACKAGE_*` and `ITEM_CONDITION` `hidden` in many categories but
 * not in all of them, and that tag is ML's decision about ITS front-end, not a
 * statement about who owns the value here. Leaning on it left the ids publish
 * actually overwrites unfiltered wherever a category omitted the tag: the row
 * rendered, the operator filled it, publish appended its own copy beside it, and
 * the write-back then deleted what they typed — a duplicated attribute on the
 * wire and an edit that silently vanished. The reason is also the UI's cue to
 * show the produto's value instead of nothing, which `oculto` must not do.
 *
 * ⚠️ `herdado` sits directly beneath it, above `bloqueado`/`oculto`, for that same
 * reason — and is a separate verdict for a different one: publish leaves a stored
 * `BRAND` alone rather than overwriting it, so the save must not prune it. See
 * {@link MlAttributeOmission}.
 *
 * ⚠️ `herdado` is the one verdict that never reaches the DTO — `projectCategoriaAtributos`
 * keeps it out of `omitidos` as well as out of `atributos`, which is what makes
 * the rollout order irrelevant in both directions. Read that function's note
 * before changing this one.
 */
export function attributeOmission(
  attr: MlCategoryAttribute,
  scope: MlAttributeScope,
): MlAttributeOmission | null {
  if (ML_PRODUTO_DERIVED_ATTRIBUTE_IDS.includes(attr.id)) return 'derivado';
  if (ML_PRODUTO_HERDADO_ATTRIBUTE_IDS.includes(attr.id)) return 'herdado';
  if (ML_BLOCKED_ATTRIBUTE_IDS.includes(attr.id)) return 'bloqueado';
  if (attrTag(attr, 'hidden')) return 'oculto';
  if (attr.value_type != null && SIZE_CHART_VALUE_TYPES.includes(attr.value_type)) {
    return 'tabela-de-medidas';
  }
  const isVariationAttr = attrTag(attr, 'variation_attribute');
  if (scope === 'item' && isVariationAttr) return 'somente-variacao';
  if (scope === 'variacao' && !isVariationAttr && !attrTag(attr, 'allow_variations')) {
    return 'somente-item';
  }
  return null;
}

function toDto(attr: MlCategoryAttribute): CategoriaAtributoDto {
  return {
    id: attr.id,
    name: attr.name ?? null,
    valueType: attr.value_type ?? null,
    values: (attr.values ?? []).map((v) => ({ id: v.id ?? null, name: v.name ?? null })),
    hint: attr.hint ?? attr.tooltip ?? null,
    valueMaxLength: attr.value_max_length ?? null,
    defaultUnit: attr.default_unit ?? attr.default_unit_id ?? null,
    allowedUnits: (attr.allowed_units ?? []).map((u) => ({
      id: u.id ?? null,
      name: u.name ?? null,
    })),
    groupId: attr.attribute_group_id ?? null,
    groupName: attr.attribute_group_name ?? null,
    required: isAttributeRequired(attr),
    multivalued: attrTag(attr, 'multivalued'),
    readOnly: attrTag(attr, 'read_only'),
    relevance: attr.relevance ?? null,
  };
}

/**
 * Filter + normalise + order a category's attributes for the editor.
 *
 * Required attributes are hoisted to the top, then ML's own `relevance`, then
 * name. The legacy screen wanted exactly this — it carries a commented-out
 * `getAtributosObrigatorio` (`cadastroProdutoMLNew.dart:862-872`) — and never
 * shipped it, so operators hunted for the field that blocked their publish.
 *
 * ⚠️ **A `herdado` id is omitted from BOTH arrays, deliberately.** Every other
 * withheld id is reported in `omitidos`, which exists so the save knows what it
 * may prune. `herdado` wants the opposite — withheld from the grid, stored copy
 * KEPT — and `attributesForSave` already gives exactly that to an id it has
 * never heard of: its "unknown to this category — preserve verbatim" branch
 * fires for anything in neither array.
 *
 * Saying nothing is therefore stronger than saying `herdado`, because it holds
 * for EVERY client, including a stale `apps/web` bundle that has never heard the
 * word. Listing the id and asking the client to special-case it would make this
 * a value the old client ACTS ON — pruning the very brand publish falls back to —
 * which turns an ordinary rollout into a destructive one and buys a permanent
 * cross-workspace invariant for something the prune semantics already give free.
 * The only cost is that the DTO stops REPORTING why `BRAND` left the grid, which
 * nothing reads; `ListingForm`'s `MarcaField` explains it on screen instead.
 */
export function projectCategoriaAtributos(
  attrs: MlCategoryAttribute[],
  scope: MlAttributeScope,
): Omit<CategoriaAtributosResult, 'leaf'> {
  const atributos: CategoriaAtributoDto[] = [];
  const omitidos: Array<{ id: string; motivo: MlAttributeOmission }> = [];

  for (const attr of attrs) {
    const motivo = attributeOmission(attr, scope);
    if (!motivo) {
      atributos.push(toDto(attr));
      continue;
    }
    // ⚠️ A `herdado` id is reported in NEITHER array, and that absence is the
    // whole mechanism — see this function's doc comment.
    if (motivo !== 'herdado') omitidos.push({ id: attr.id, motivo });
  }

  atributos.sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    const ra = a.relevance ?? Number.MAX_SAFE_INTEGER;
    const rb = b.relevance ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return (a.name ?? a.id).localeCompare(b.name ?? b.id, 'pt-BR');
  });

  return { atributos, omitidos };
}

/** A category with children is not a leaf; ML serves it no listing metadata. */
export function isLeafCategory(children: unknown): boolean {
  return !Array.isArray(children) || children.length === 0;
}
