/**
 * Inverse of the publish mapper (`itemPayload.ts` + `attributes.ts`): turn a
 * fetched Mercado Livre item (`GET /items/{id}?include_attributes=all`) into a
 * normalized `MappedMlItem` the app's `importCore` assembles into an ERP produto
 * + `produtoMercadoLivre` link. Pure (no IO), so the round-trip parity is
 * unit-testable against real item fixtures.
 *
 * This module handles only the SIMPLE (non-variation, non-User-Products) shape —
 * variation/`family_name` import (which needs the deferred variation-taxonomy
 * design) is tracked in #438; the IO layer rejects those before calling here.
 *
 * Deliberate deviations from the legacy Dart (bug-fixes, per the port's licence):
 *  - WEIGHT `g → 0.001` (legacy used `0.01`, a 10× error);
 *  - no fabricated dimensions/weights — the legacy invented 0.25 kg / 5×10×10 cm
 *    defaults when ML had none; we leave them null (a re-publish then omits the
 *    package attributes instead of shipping invented sizes);
 *  - the link doc's `attributes` EXCLUDE the ids the publish path re-derives from
 *    produto fields (`SELLER_SKU`, `WEIGHT`, `SELLER_PACKAGE_*`, `IS_KIT`) so a
 *    round-trip re-publish never sends a duplicated attribute id.
 */
import {
  ML_PRODUTO_DERIVED_ATTRIBUTE_IDS,
  type MlAttribute,
  attributesWithValue,
} from './attributes';
import { type EstadoPublicacao, estadoFromMlStatus } from './itemPayload';
import type { MlItem, MlItemAttribute } from '../types';

/**
 * Attribute ids the publish path re-derives from produto fields (not stored on
 * the link) — {@link ML_PRODUTO_DERIVED_ATTRIBUTE_IDS} plus one import-only id.
 *
 * `IS_KIT` is local rather than shared because it has no publish counterpart:
 * nothing emits it, so putting it in the shared set would tell the listing editor
 * to withhold an attribute the ERP does not actually own. Here it is right —
 * `ehKit` is a produto field, and carrying ML's copy on the link would let the two
 * disagree.
 */
const DERIVED_ATTRIBUTE_IDS: ReadonlySet<string> = new Set([
  ...ML_PRODUTO_DERIVED_ATTRIBUTE_IDS,
  'IS_KIT',
]);

/** The normalized shape `importCore` consumes (produto + link fields). */
export interface MappedMlItem {
  /** ML item id (`MLB…`) — the link doc's `id` + the cross-app dedup key. */
  mlItemId: string;
  /** Seller SKU from the `SELLER_SKU` attribute (dedup + produto.sku). */
  sku: string | null;
  /** `seller_custom_field` — a candidate deterministic produto id (IO decides). */
  sellerCustomField: string | null;

  // ---- produto core ----
  nome: string;
  ehKit: boolean;
  ehUsado: boolean;
  pesoLiquidoKg: number | null;
  pesoBrutoKg: number | null;
  alturaCm: number | null;
  larguraCm: number | null;
  profundidadeCm: number | null;

  // ---- price ----
  /** Normal price = `base_price ?? price`. */
  precoNormal: number | null;
  /** Promo price = `price`, only when it differs from the normal price. */
  precoPromocional: number | null;

  // ---- extraData ----
  /** 1 = novo, 2 = usado (extraData.condicao). */
  condicao: number;

  // ---- stock ----
  availableQuantity: number;

  // ---- produtoMercadoLivre link ----
  categoryId: string | null;
  listingTypeId: string | null;
  condition: 'new' | 'used';
  estado: EstadoPublicacao;
  /** Raw ML status / sub_status (for the maintenance bot, #440). */
  status: string | null;
  subStatus: string[] | null;
  freteGratis: boolean;
  isUserProductModel: boolean;
  /**
   * ML's `user_product_id` — the STOCK identity on a multiorigin
   * (`warehouse_management`) conta (#706). Present on every item, UP model or
   * not: before a seller carries `user_product_seller` the relation is simply
   * 1:1 with the item id.
   */
  userProductId: string | null;
  videoId: string | null;
  /** Non-derived attributes, embedded inline on the link (parity). */
  attributes: MlAttribute[];
}

function attrById(
  attrs: readonly MlItemAttribute[] | null | undefined,
  id: string,
): MlItemAttribute | undefined {
  return (attrs ?? []).find((a) => a.id === id);
}

/** `SELLER_SKU.value_name` — the legacy `skuFromMercadoLivre`. */
export function skuFromAttributes(
  attrs: readonly MlItemAttribute[] | null | undefined,
): string | null {
  const v = attrById(attrs, 'SELLER_SKU')?.value_name;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Parse a `"<number> <unit>"` attribute value to a base unit. Unknown/missing
 * unit falls back to `defaultFactor` (the publish path always writes a unit).
 */
function parseNumberWithUnit(
  valueName: string | null | undefined,
  factors: Record<string, number>,
  defaultFactor: number,
): number | null {
  if (typeof valueName !== 'string') return null;
  const trimmed = valueName.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(-?\d+(?:[.,]\d+)?)\s*([a-zA-Z]*)$/);
  if (!match) return null;
  const num = Number(match[1]!.replace(',', '.'));
  if (!Number.isFinite(num)) return null;
  const unit = match[2]!.toLowerCase();
  const factor = unit ? (factors[unit] ?? null) : defaultFactor;
  if (factor == null) return null;
  return num * factor;
}

/** `WEIGHT` "0.5 kg" / "500 g" → kg. Legacy g→0.01 was a 10× bug; use 0.001. */
export function weightKgFromAttribute(attr: MlItemAttribute | undefined): number | null {
  return parseNumberWithUnit(attr?.value_name, { kg: 1, g: 0.001, mg: 1e-6 }, 1);
}

/** `SELLER_PACKAGE_*` "55 cm" → cm. */
function cmFromAttribute(attr: MlItemAttribute | undefined): number | null {
  return parseNumberWithUnit(attr?.value_name, { cm: 1, mm: 0.1, m: 100 }, 1);
}

/** `IS_KIT == 'Sim'` → true (legacy). */
export function isKitFromAttributes(attrs: readonly MlItemAttribute[] | null | undefined): boolean {
  return attrById(attrs, 'IS_KIT')?.value_name === 'Sim';
}

/**
 * A measurement ML stated in `value_struct`, as the number and unit we store.
 *
 * ⚠️ This is the only unit an item response carries. `value_name` bakes it into
 * the text (`'355 mL'`) and `unit_id` is a field we SEND, never one ML returns —
 * so without reading the struct, every imported measurement lands unitless and
 * with its unit stranded inside the value.
 *
 * ⚠️ There is deliberately NO fallback that parses the unit out of `value_name`.
 * This layer sees no category metadata, so it cannot tell a real unit from the
 * tail of an ordinary string, and a blind split would turn a BRAND of
 * `'Nike Air'` into `'Nike'` — exactly the silent corruption being fixed. When
 * ML sends no struct the value is left whole; the editor splits it there, where
 * `allowedUnits` is on hand to match against.
 */
function measurementFromStruct(attr: MlItemAttribute): { value: string; unit: string } | null {
  const struct = attr.value_struct;
  if (struct == null) return null;
  const { number, unit } = struct;
  if (typeof number !== 'number' || !Number.isFinite(number)) return null;
  if (typeof unit !== 'string' || unit.trim() === '') return null;
  return { value: String(number), unit: unit.trim() };
}

/**
 * The same (number, unit) split, recovered from a `value_name` ML BAKED the unit
 * into while still reporting `unit_id` beside it — `'12 cm'` + `unit_id: 'cm'`.
 *
 * ⛔ Not a tidy-up. `attributeToMercadoLivre` re-joins `value_name` and `unit_id`
 * on the way out (`[value_name, unit_id].join(' ')`), so storing BOTH halves means
 * the next publish sends `'12 cm cm'`, the one after that `'12 cm cm cm'`, and so
 * on. It compounds silently until ML rejects the value, by which time every
 * republished listing carries it. Observed live in #1087, where ML returned
 * `'12 cm'` for a HEIGHT we sent as `'12'` and sent no `value_struct` to split it.
 *
 * Returns null unless the `value_name` really does end with the reported unit, so
 * a legitimate value that merely CONTAINS the unit's letters is untouched.
 */
function measurementFromBakedValueName(
  attr: MlItemAttribute,
): { value: string; unit: string } | null {
  const unit = typeof attr.unit_id === 'string' ? attr.unit_id.trim() : '';
  const valueName = typeof attr.value_name === 'string' ? attr.value_name.trim() : '';
  if (unit === '' || valueName === '') return null;
  const sufixo = ` ${unit}`;
  if (!valueName.endsWith(sufixo)) return null;
  const value = valueName.slice(0, -sufixo.length).trim();
  // Only a NUMBER may be split off. Anything else and the trailing word is part
  // of the value, not a unit ML appended.
  if (value === '' || !Number.isFinite(Number(value))) return null;
  return { value, unit };
}

/**
 * Map an item's `attributes[]` to the inline link-doc `attributes`, dropping the
 * ids the publish path re-derives from produto fields (so a re-publish never
 * sends a duplicate id). Empty-value attributes are filtered (publish parity).
 *
 * A `number_unit` is stored as the number and the unit APART — the shape the
 * editor renders and `attributeToMercadoLivre` folds back into `'355 mL'`.
 */
export function attributesFromItem(
  attrs: readonly MlItemAttribute[] | null | undefined,
): MlAttribute[] {
  const mapped: MlAttribute[] = (attrs ?? [])
    .filter((a) => typeof a.id === 'string' && a.id.length > 0 && !DERIVED_ATTRIBUTE_IDS.has(a.id))
    .map((a) => {
      const measurement = measurementFromStruct(a) ?? measurementFromBakedValueName(a);
      return {
        id: a.id as string,
        // The struct describes the (number, unit) PAIR, so ML's `value_id` names
        // that pair too. Splitting them means the id no longer matches the
        // `value_name` we store, and nothing downstream can rebuild it — drop it
        // and let ML resolve the value from its name, as it does for every
        // measurement an operator types.
        value_id: measurement != null ? null : (a.value_id ?? null),
        name: a.name ?? null,
        value_name: measurement?.value ?? a.value_name ?? null,
        attribute_group_id: a.attribute_group_id ?? null,
        attribute_group_name: a.attribute_group_name ?? null,
        unit_id: a.unit_id ?? measurement?.unit ?? null,
      };
    });
  return attributesWithValue(mapped);
}

/**
 * The legacy `gessSkuFromMercadoLivre` — guess a parent SKU by stripping the last
 * 6 chars off each variation `SELLER_SKU` and returning the common prefix (only
 * when all variations collapse to one). Defined here for the deferred variation
 * import (#438); unused by the simple path.
 */
export function skuGuessFromVariations(item: MlItem): string | null {
  const variations = item.variations ?? [];
  if (variations.length === 0) return null;
  const prefixes = new Set<string>();
  for (const v of variations) {
    const sku = skuFromAttributes(v.attributes);
    // "only when ALL variations collapse to one": a variation without a usable
    // (>6-char) SKU means we can't guess — bail rather than infer from a subset.
    if (!sku || sku.length <= 6) return null;
    prefixes.add(sku.slice(0, sku.length - 6));
  }
  return prefixes.size === 1 ? [...prefixes][0]! : null;
}

/**
 * Does this ML item keep its stock on CHILD produtos rather than on the listing
 * itself? True for a legacy `variations[]` item (each variation carries its own
 * quantity) and for every User-Products item (each member becomes a child) —
 * which is exactly `ownsChildren` in `import.ts`.
 *
 * ⚠️ Exported because two components have to agree on it and there is no way to
 * notice if they stop: the importer (`assembleImportPlan`, through
 * `args.hasVariations`) and the `items` status-sync both decide from it whether
 * a parent link may carry a `userProductId` (#706). The answer must be NO
 * whenever the stock units are the children, because the item in hand is then
 * one member of a family, and its `user_product_id` on the family's link is the
 * "one member speaks for the family" mistake #1142 found in four places.
 *
 * ⚠️ Deliberately CONSERVATIVE, and the asymmetry is the point. It answers from
 * the ML ITEM, so it says "children" for a User-Products SINGLE item too — one
 * whose ERP produto has no variations and whose parent link really is the stock
 * unit. That costs one `GET /items` the stock send would otherwise skip, once,
 * and the send stamps the id itself afterwards. The opposite error writes a
 * MEMBER's id onto a FAMILY's link, which no later read can tell from a real
 * one. Callers that genuinely know the ERP shape ask a better question instead
 * — `children.length` in `publish.ts`, `hasVariations` in `importCore.ts`,
 * `row.children.length` in the sweep.
 */
export function itemStockLivesOnChildren(item: MlItem): boolean {
  return item.family_name != null || (item.variations?.length ?? 0) > 0;
}

/** Map a fetched simple ML item to the normalized import shape. */
export function mapMlItemToImport(item: MlItem): MappedMlItem {
  const condition = item.condition === 'used' ? 'used' : 'new';
  const precoNormal = item.base_price ?? item.price ?? null;
  const price = item.price ?? null;
  const precoPromocional =
    price != null && precoNormal != null && price !== precoNormal ? price : null;

  return {
    mlItemId: item.id,
    sku: skuFromAttributes(item.attributes),
    sellerCustomField: item.seller_custom_field ?? null,

    nome: (item.family_name ?? item.title ?? '').trim(),
    ehKit: isKitFromAttributes(item.attributes),
    ehUsado: condition === 'used',
    // No fabricated defaults (legacy bug): null when ML has no weight/dims.
    pesoLiquidoKg: weightKgFromAttribute(attrById(item.attributes, 'WEIGHT')),
    pesoBrutoKg: weightKgFromAttribute(attrById(item.attributes, 'SELLER_PACKAGE_WEIGHT')),
    alturaCm: cmFromAttribute(attrById(item.attributes, 'SELLER_PACKAGE_HEIGHT')),
    larguraCm: cmFromAttribute(attrById(item.attributes, 'SELLER_PACKAGE_LENGTH')),
    profundidadeCm: cmFromAttribute(attrById(item.attributes, 'SELLER_PACKAGE_WIDTH')),

    precoNormal,
    precoPromocional,

    condicao: condition === 'used' ? 2 : 1,

    availableQuantity: item.available_quantity ?? 0,

    categoryId: item.category_id ?? null,
    listingTypeId: item.listing_type_id ?? null,
    condition,
    estado: estadoFromMlStatus(item.status),
    status: item.status ?? null,
    subStatus: item.sub_status ?? null,
    freteGratis: item.shipping?.free_shipping === true,
    isUserProductModel: item.family_name != null,
    userProductId: item.user_product_id ?? null,
    videoId: item.video_id ?? null,
    attributes: attributesFromItem(item.attributes),
  };
}
