/**
 * Mercado Livre listing attributes — the `attributes` / `attribute_combinations`
 * entries of an item payload. Ports the old Flutter `AttributesMLNew` factories
 * and its `toMercadoLivre()` transform verbatim (models.dart 1989–2333): the
 * link docs embed these as plain arrays (the legacy nested `attributesML`
 * subcollection was dead code), and the API payload applies the `-1`/unit
 * normalization rules below.
 */

/** One attribute as stored on the link doc (old `AttributesMLNew` wire shape). */
export interface MlAttribute {
  /**
   * The ML attribute id. Optional for exactly ONE case: a **custom
   * characteristic** in `attribute_combinations`, which ML identifies by `name`
   * because the id does not exist in its taxonomy ("Característica
   * personalizada" — the docs' example sends `name` + `value_name` and no id).
   * Every attribute the link doc stores has one (`mlAttributeWireSchema`
   * requires it), so treat an absent id as "combination-only".
   */
  id?: string;
  value_id?: string | null;
  name?: string | null;
  value_name?: string | null;
  attribute_group_id?: string | null;
  attribute_group_name?: string | null;
  unit_id?: string | null;
}

/** `N/A` marker — ML's convention for "does not apply" (`value_id: '-1'`). */
export function attrNA(id: string): MlAttribute {
  return { id, value_id: '-1', value_name: 'N/A' };
}

export function attrSku(sku: string): MlAttribute {
  return { id: 'SELLER_SKU', value_name: sku };
}

/**
 * Brand — the produto's `extraData.marca`, once `resolveMarcaAnuncio` has said
 * the produto is the one deciding.
 *
 * ⚠️ Emits `value_name` alone, which is why the caller must reach for this ONLY
 * on that branch and never to rebuild a stored entry. An ML category that
 * enumerates its brands answers with a `value_id` naming ML's own brand record,
 * and the legacy form stored one whenever the typed text matched an enumerated
 * value exactly (`cadastroProdutoMLNew.dart:1175-1230`) — so round-tripping a
 * stored `BRAND` through this factory would quietly discard that id.
 */
export function attrBrand(valueName: string): MlAttribute {
  return { id: 'BRAND', value_name: valueName };
}

export function attrSize(valueName: string): MlAttribute {
  return { id: 'SIZE', value_name: valueName };
}

export function attrColor(valueName: string): MlAttribute {
  return { id: 'COLOR', value_name: valueName };
}

export function attrSizeGridId(valueName: string): MlAttribute {
  return { id: 'SIZE_GRID_ID', value_name: valueName };
}

export function attrSizeGridRowId(valueName: string): MlAttribute {
  return { id: 'SIZE_GRID_ROW_ID', value_name: valueName };
}

/** Net weight — old factory embeds the unit in the value (`"0.5 kg"`). */
export function attrWeightKg(pesoKg: number): MlAttribute {
  return { id: 'WEIGHT', name: 'Peso', value_name: `${pesoKg} kg` };
}

/**
 * Package dimensions for shipping quotes — old `AttributesMLNew.dimensionsNew`.
 * Note the old mapping: HEIGHT←alturaCm, LENGTH←larguraCm, WIDTH←profundidadeCm
 * (kept as-is for parity) and WEIGHT in grams.
 *
 * ⚠️ The axis crossing is deliberate and stays. ML's own docs say the seller
 * declares `largura × altura × comprimento` but the front-end re-sorts the three
 * largest-to-smallest for display, and the freight cost is driven by the volume —
 * which a permutation leaves unchanged.
 *
 * ⚠️ **It formats; it does not derive.** The input is a `DimensoesPacote` from
 * `dimensoesDoPacote` (`@delfrance/schemas`) — already whole centimetres and
 * whole grams, already all-or-nothing — and this function only attaches ids and
 * units. That split is deliberate: ML rejects a non-integer outright with
 * `item.attribute.invalid.format.seller.package.dimensions` (*"only integers are
 * accepted for dimensions and weight, with 'cm' as the unit for dimensions and
 * 'g' as the unit for weight"*), so a produto measured `5.5 cm` used to ship
 * `"5.5 cm"` and 400 the whole publish — with no way for the operator to correct
 * it, since these four ids are never offered as editor inputs
 * ({@link ML_PRODUTO_DERIVED_ATTRIBUTE_IDS}). Rounding it here would put the rule
 * one layer BELOW the produto screen that has to display the same numbers, and
 * the two would drift with nothing able to catch it. The parameter is structural
 * rather than the imported type because this package must not depend on
 * `@delfrance/schemas`.
 */
export function attrPackageDimensions(pacote: {
  alturaCm: number;
  larguraCm: number;
  profundidadeCm: number;
  pesoG: number;
}): MlAttribute[] {
  return [
    { id: 'SELLER_PACKAGE_HEIGHT', value_name: `${pacote.alturaCm} cm` },
    { id: 'SELLER_PACKAGE_LENGTH', value_name: `${pacote.larguraCm} cm` },
    { id: 'SELLER_PACKAGE_WIDTH', value_name: `${pacote.profundidadeCm} cm` },
    { id: 'SELLER_PACKAGE_WEIGHT', value_name: `${pacote.pesoG} g` },
  ];
}

/**
 * The attribute ids this module DERIVES from the produto on every publish — the
 * one list, so the three surfaces that need it cannot drift apart.
 *
 * Each id here is produced unconditionally by a factory above
 * ({@link attrSku}, {@link attrWeightKg}, {@link attrPackageDimensions}), which
 * makes three obligations follow from membership alone:
 *
 *  - the listing editor must never offer it as an input — a value typed there is
 *    appended a second time by the publisher and then deleted by the write-back,
 *    so the operator's edit both breaks the payload and vanishes;
 *  - publish must not persist it back onto the link doc, or the next run stores a
 *    duplicate;
 *  - import must strip it out of `link.attributes`, because it belongs on the
 *    produto (where {@link attrPackageDimensions} will read it from next time).
 *
 * ⚠️ These are the **`SELLER_PACKAGE_*`** ids, not `PACKAGE_*`. The two spellings
 * are different attributes: `PACKAGE_*` is ML's own factory-packaging data,
 * tagged `read_only` — a seller cannot write it at all — while `SELLER_PACKAGE_*`
 * is the seller-declared shipping package, which is what a produto's
 * altura/largura/profundidade actually describe. The legacy blocklist named only
 * the first spelling (`cadastroSlim.dart:244`), and this port inherited that, so
 * for a while nothing filtered the ids publish really overwrites — it only looked
 * filtered because ML *also* happens to tag `SELLER_PACKAGE_*` `hidden` in many
 * categories, which a different rule catches. Do not merge the two lists.
 *
 * ⚠️ Membership is "the PRODUTO owns it", not "a factory above emits it".
 * {@link attrSize}/{@link attrColor} come from the grupo de variações and
 * {@link attrSizeGridId}/{@link attrSizeGridRowId} from the tabela de medidas —
 * all four are withheld from the editor by their own rules and are deliberately
 * absent here, `SIZE_GRID_ID` most of all: the link doc is where the chart
 * binding LIVES between publishes, so stripping it on write-back would break
 * every size-chart binding. What belongs here is exactly what
 * {@link attrSku}, {@link attrWeightKg} and {@link attrPackageDimensions} emit,
 * and `mapping.test.ts` pins those three against this set.
 */
export const ML_PRODUTO_DERIVED_ATTRIBUTE_IDS: readonly string[] = [
  'SELLER_SKU',
  'WEIGHT',
  'SELLER_PACKAGE_HEIGHT',
  'SELLER_PACKAGE_LENGTH',
  'SELLER_PACKAGE_WIDTH',
  'SELLER_PACKAGE_WEIGHT',
];

/**
 * Attribute ids the produto FILLS but does not own outright — the listing's own
 * stored value stays the fallback.
 *
 * ⚠️ Deliberately NOT part of {@link ML_PRODUTO_DERIVED_ATTRIBUTE_IDS}, and the
 * two lists must not be merged. They agree on the first two of that list's three
 * obligations — the editor withholds both, and publish persists neither back —
 * and split on what those mean plus the third:
 *
 *  - a DERIVED id is stripped from the write-back because storing it would
 *    duplicate it next run; a HERDADO id is stripped because storing the derived
 *    value would LATCH it, making the produto's Marca its own fallback so that
 *    clearing Marca could never clear the listing's brand. The stored entry is
 *    then carried back verbatim (`linkAttributesAfterPublish`) — publish neither
 *    adds one nor removes one;
 *  - import STRIPS a derived id and must NOT strip a herdado one, because that
 *    stored copy is what the produto falls back TO.
 *
 * `BRAND` is the case, and the difference is where the values live. A stale
 * stored `WEIGHT` is a duplicate of something the produto already holds, so
 * dropping it loses nothing; `BRAND` is `required` in most ML categories and has
 * been operator-typed for this app's whole history, so for a produto with an
 * empty Marca the stored value is the ONLY copy in existence. Treating it as
 * derived would strip the brand off every listing on the next save and publish
 * nothing in its place.
 *
 * The precedence itself is `resolveMarcaAnuncio` (`@delfrance/schemas`), shared
 * with the produto screen that displays the same answer.
 */
export const ML_PRODUTO_HERDADO_ATTRIBUTE_IDS: readonly string[] = ['BRAND'];

/**
 * Wire transform for the ML API — port of `AttributesMLNew.toMercadoLivre()`:
 *  - `value_id === '-1'` (N/A) → `value_name: null`, no unit;
 *  - otherwise `value_name` gets the unit appended (`"55 cm"`) and `unit_id`
 *    rides along when set;
 *  - null/undefined optional keys are omitted entirely.
 *
 * An attribute is identified by `id`, or — when it has none — by `name`, which
 * is ML's custom-characteristic shape. `name` is emitted ONLY in that case: an
 * id-bearing attribute carries `name` purely as a local label (`attrWeightKg`'s
 * `'Peso'`), and the legacy transform never sent it.
 */
export function attributeToMercadoLivre(attr: MlAttribute): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (attr.id != null) out.id = attr.id;
  else if (attr.name != null) out.name = attr.name;
  const isNA = attr.value_id === '-1';
  if (attr.value_id != null) out.value_id = attr.value_id;
  if (isNA) {
    out.value_name = null;
  } else if (attr.value_name != null) {
    out.value_name = [attr.value_name, attr.unit_id].filter(Boolean).join(' ').trim();
  }
  if (attr.attribute_group_id != null) out.attribute_group_id = attr.attribute_group_id;
  if (attr.attribute_group_name != null) out.attribute_group_name = attr.attribute_group_name;
  if (attr.unit_id != null && !isNA) out.unit_id = attr.unit_id;
  return out;
}

/** Keep only attributes that carry a value (old `getAttributes` filter). */
export function attributesWithValue(attrs: ReadonlyArray<MlAttribute>): MlAttribute[] {
  return attrs.filter((a) => a.value_id != null || a.value_name != null);
}
