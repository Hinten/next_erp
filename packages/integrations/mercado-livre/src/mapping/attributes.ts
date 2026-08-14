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
 */
export function attrPackageDimensions(input: {
  alturaCm: number;
  larguraCm: number;
  profundidadeCm: number;
  pesoKg: number;
}): MlAttribute[] {
  return [
    { id: 'SELLER_PACKAGE_HEIGHT', value_name: `${input.alturaCm} cm` },
    { id: 'SELLER_PACKAGE_LENGTH', value_name: `${input.larguraCm} cm` },
    { id: 'SELLER_PACKAGE_WIDTH', value_name: `${input.profundidadeCm} cm` },
    { id: 'SELLER_PACKAGE_WEIGHT', value_name: `${Math.round(input.pesoKg * 1000)} g` },
  ];
}

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
