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
 *    defaults when ML had none; every value here comes from something ML actually
 *    said, and stays null when it said nothing;
 *  - the link doc's `attributes` EXCLUDE the ids the publish path re-derives from
 *    produto fields (`SELLER_SKU`, `WEIGHT`, `SELLER_PACKAGE_*`, `IS_KIT`) so a
 *    round-trip re-publish never sends a duplicated attribute id.
 *
 * ## Where a produto's package comes from
 *
 * | produto field | tier 1 — the seller's declaration | tier 2 — fallback |
 * | --- | --- | --- |
 * | `alturaCm` | `SELLER_PACKAGE_HEIGHT` | `HEIGHT` (Altura) |
 * | `larguraCm` | `SELLER_PACKAGE_LENGTH` | `WIDTH` (Largura) |
 * | `profundidadeCm` | `SELLER_PACKAGE_WIDTH` | `LENGTH` (Comprimento) |
 * | `pesoBrutoKg` | `SELLER_PACKAGE_WEIGHT` | `billableWeightG / 1000` |
 * | `pesoLiquidoKg` | `WEIGHT` | — **none, ever** |
 *
 * Tier 2 exists because an ME2 listing can legitimately carry NO package at all:
 * ML stipulates the package itself and publishes nothing (see
 * {@link MEDIDAS_DO_PRODUTO} for the live measurement that settled it). The three
 * axes are all-or-nothing and taken from ONE tier; the weight is a separate
 * donor, and that exception is written down at the use site.
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

/**
 * The three PRODUCT-SPEC measurement ids, and which produto field each fills.
 *
 * ⚠️ **These describe the PRODUCT, not its shipping box**, and using them as a
 * package is a deliberate choice of ours — not something ML instructs. Measured on
 * 27/08/2026 for `MLB5146021467`: ML declares NO
 * `SELLER_PACKAGE_*`/`WEIGHT` on the listing, `shipping.dimensions` is `null`,
 * and `GET /catalog_domains/MLB-SERVING_AND_HOME_TRAYS/shipping_attributes`
 * answers `attributes: []` — ML names no shipping attributes for the domain at
 * all. Under ME2 *"as dimensões dos pacotes são estipuladas pelo Mercado Livre e
 * não podem ser alteradas pelo usuário"*, so ML derives the package itself and
 * simply never publishes one. Without this tier such a listing imports with five
 * nulls, which is correct and useless.
 *
 * ⚠️ **The mapping is STRAIGHT here, while {@link attrPackageDimensions}' is
 * CROSSED, and BOTH are right.** The `SELLER_PACKAGE_*` crossing
 * (`alturaCm←HEIGHT, larguraCm←LENGTH, profundidadeCm←WIDTH`) is legacy parity
 * kept so import mirrors publish byte for byte. These ids have unambiguous
 * Portuguese names from ML (`Altura`, `Largura`, `Comprimento`) and no publish
 * counterpart to mirror, so they map by MEANING. Do not "align" the two.
 */
const MEDIDAS_DO_PRODUTO = [
  ['alturaCm', 'HEIGHT'],
  ['larguraCm', 'WIDTH'],
  ['profundidadeCm', 'LENGTH'],
] as const satisfies readonly (readonly [keyof MedidasDoPacoteMapeado, string])[];

/** The produto dimension fields this module resolves, in centimetres. */
type MedidasDoPacoteMapeado = Pick<MappedMlItem, 'alturaCm' | 'larguraCm' | 'profundidadeCm'>;

/**
 * A measurement in centimetres, from wherever ML put it on THIS response.
 *
 * Three sources, in order, because ML is not consistent about which it fills:
 * the documented root `value_struct`; `values[0].struct`, which is the only
 * place a live `GET /items?include_attributes=all` actually carried the split
 * (see {@link itemAttributeSchema}); and finally the baked `value_name`
 * (`'10 cm'`), which {@link parseNumberWithUnit} already handles.
 *
 * A struct is preferred over the text because it states the unit rather than
 * relying on the value's spelling — `'10 cm'` and `'10cm'` and `'10'` all reach
 * here, and only the first two carry a unit at all.
 */
function cmFromMeasurement(attr: MlItemAttribute | undefined): number | null {
  if (attr == null) return null;
  const struct = attr.value_struct ?? attr.values?.[0]?.struct ?? null;
  if (struct != null && typeof struct.number === 'number' && Number.isFinite(struct.number)) {
    const unit = typeof struct.unit === 'string' ? struct.unit.trim().toLowerCase() : '';
    // Same factors as `cmFromAttribute`, and the same rule: an unrecognised unit
    // is DROPPED rather than assumed. A silent wrong unit is a box off by 10×.
    const fator = unit === '' ? 1 : ({ cm: 1, mm: 0.1, m: 100 } as Record<string, number>)[unit];
    if (fator != null) return struct.number * fator;
    return null;
  }
  return cmFromAttribute(attr);
}

/**
 * The three axes from the product-spec attributes — ALL of them or NONE.
 *
 * ⚠️ All-or-nothing, one donor, for the reason `rollupDimensoesDosFilhos` and
 * `dimensoesDoPacote` are: a box assembled from two sources is a box neither
 * source describes. A listing carrying only `HEIGHT` yields nothing.
 *
 * `> 0` because ML validates package dimensions for realism and a zero axis is
 * not a package — the same floor `dimensoesDoPacote` applies.
 */
function medidasDoProduto(
  attrs: readonly MlItemAttribute[] | null | undefined,
): MedidasDoPacoteMapeado | null {
  const out = {} as MedidasDoPacoteMapeado;
  for (const [campo, attrId] of MEDIDAS_DO_PRODUTO) {
    const valor = cmFromMeasurement(attrById(attrs, attrId));
    if (valor == null || !(valor > 0)) return null;
    out[campo] = valor;
  }
  return out;
}

/**
 * The gross weight the listing DECLARES, in kg — tier 1 only, never a fallback.
 *
 * Exported so the IO layer can decide whether an ML weight lookup is worth
 * spending, WITHOUT re-stating the attribute id: a listing that already declares
 * its package weight must not cost a network call. `mapMlItemToImport` asks the
 * same question through this function, so the two can never disagree.
 */
export function pesoBrutoDeclaradoKg(item: MlItem): number | null {
  return weightKgFromAttribute(attrById(item.attributes, 'SELLER_PACKAGE_WEIGHT'));
}

/** `IS_KIT == 'Sim'` → true (legacy). */
export function isKitFromAttributes(attrs: readonly MlItemAttribute[] | null | undefined): boolean {
  return attrById(attrs, 'IS_KIT')?.value_name === 'Sim';
}

/**
 * A measurement ML stated in `value_struct`, as the number and unit we store.
 *
 * `value_name` bakes the unit into the text (`'355 mL'`), so without reading the
 * struct an imported measurement lands unitless with its unit stranded in the value.
 *
 * ⚠️ This is no longer the ONLY unit an item response carries — ML does sometimes
 * return `unit_id` beside a baked `value_name`, which is what
 * {@link measurementFromBakedValueName} recovers the split from (#1087). That
 * fallback is narrow ON PURPOSE, and the reason this docblock used to forbid one
 * outright still stands: this layer sees no category metadata, so a BLIND split
 * would turn a BRAND of `'Nike Air'` into `'Nike'`. What makes the fallback safe is
 * that it never guesses — it splits only a trailing token ML ITSELF named in
 * `unit_id`, and only when what remains is a number. With no `unit_id` and no
 * struct the value is still left whole for the editor, where `allowedUnits` is on
 * hand to match against.
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

  // The same shape `parseNumberWithUnit` matches, and deliberately so: a decimal
  // that may use EITHER separator, then the unit as a bare word.
  const match = valueName.match(/^(-?\d+(?:[.,]\d+)?)\s*([a-zA-Z]+)$/);
  if (!match) return null;

  // ⚠️ Case-INSENSITIVE. ML's display text and its unit id differ in case for
  // several units — it returns `'355 mL'` next to `unit_id: 'ml'` — and a
  // case-sensitive compare silently declined to split exactly those, so they went
  // on compounding (`'355 mL ml'`, `'355 mL ml ml'`, …).
  if (match[2]!.toLowerCase() !== unit.toLowerCase()) return null;

  // The head is returned VERBATIM, comma and all: ML sent it, so it round-trips
  // back to ML unchanged. `Number(...)` only has to confirm it IS a number, and it
  // needs the separator normalised to do that — `Number('1,5')` is NaN, which is
  // what used to make every comma decimal fall through and compound.
  const head = match[1]!;
  if (!Number.isFinite(Number(head.replace(',', '.')))) return null;

  // The stored unit is ML's own ID, not its display form, so the value we send
  // next time is the one ML canonically names.
  return { value: head, unit };
}

/**
 * The unit to store beside a value — or null when the value already carries it.
 *
 * ⛔ The invariant that makes a republish idempotent: the stored `value_name` must
 * never already end with the stored `unit_id`, because `attributeToMercadoLivre`
 * re-joins the two on the way out. Splitting the pair satisfies it wherever the
 * value is a number; this covers the rest — a value ML reported a `unit_id` for but
 * which cannot be split (the head is not numeric), where the only way to keep the
 * pair whole AND idempotent is to drop the duplicate unit.
 *
 * Keeping both is what produced `'12 cm cm'`, then `'12 cm cm cm'`, silently, on
 * every republish (#1087).
 */
function unidadeParaValor(valueName: string | null, unit: string | null): string | null {
  const u = typeof unit === 'string' ? unit.trim() : '';
  if (u === '') return null;
  const v = typeof valueName === 'string' ? valueName.trim() : '';
  return v.toLowerCase().endsWith(` ${u.toLowerCase()}`) ? null : u;
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
      const valueName = measurement?.value ?? a.value_name ?? null;
      return {
        id: a.id as string,
        // The struct describes the (number, unit) PAIR, so ML's `value_id` names
        // that pair too. Splitting them means the id no longer matches the
        // `value_name` we store, and nothing downstream can rebuild it — drop it
        // and let ML resolve the value from its name, as it does for every
        // measurement an operator types.
        value_id: measurement != null ? null : (a.value_id ?? null),
        name: a.name ?? null,
        value_name: valueName,
        attribute_group_id: a.attribute_group_id ?? null,
        attribute_group_name: a.attribute_group_name ?? null,
        // ⚠️ Precedence unchanged: a `unit_id` ML actually SENT still outranks the
        // struct's own unit. `unidadeParaValor` only drops it when the value we are
        // about to store already ends with it — see that function.
        unit_id: unidadeParaValor(valueName, a.unit_id ?? measurement?.unit ?? null),
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

/**
 * Extra facts the pure mapper cannot fetch for itself — supplied by the IO layer
 * (`import.ts`), which is the only place allowed to talk to ML.
 */
export interface MapMlItemExtras {
  /**
   * `coverage.all_country.billable_weight` from
   * `GET /users/{sellerId}/shipping_options/free`, in GRAMS.
   *
   * The last-resort gross weight for a listing ML publishes no
   * `SELLER_PACKAGE_WEIGHT` on. See the ⚠️ at its use below before moving it.
   */
  billableWeightG?: number | null;
}

/** Map a fetched simple ML item to the normalized import shape. */
export function mapMlItemToImport(item: MlItem, extras: MapMlItemExtras = {}): MappedMlItem {
  const condition = item.condition === 'used' ? 'used' : 'new';
  const precoNormal = item.base_price ?? item.price ?? null;
  const price = item.price ?? null;
  const precoPromocional =
    price != null && precoNormal != null && price !== precoNormal ? price : null;

  // ---- package: the seller's declaration first, then the fallbacks ---------
  // Tier 1 is what the seller (or a previous publish of ours) put on the listing.
  const pacoteDeclarado = {
    alturaCm: cmFromAttribute(attrById(item.attributes, 'SELLER_PACKAGE_HEIGHT')),
    larguraCm: cmFromAttribute(attrById(item.attributes, 'SELLER_PACKAGE_LENGTH')),
    profundidadeCm: cmFromAttribute(attrById(item.attributes, 'SELLER_PACKAGE_WIDTH')),
  };
  // Tier 2 only when tier 1 produced NOTHING. A partial `SELLER_PACKAGE_*` set is
  // left partial on purpose: topping it up from a different source would build a
  // box neither source describes, and the operator can still see which axis ML
  // is missing.
  const semPacoteDeclarado =
    pacoteDeclarado.alturaCm == null &&
    pacoteDeclarado.larguraCm == null &&
    pacoteDeclarado.profundidadeCm == null;
  const pacote = semPacoteDeclarado
    ? (medidasDoProduto(item.attributes) ?? pacoteDeclarado)
    : pacoteDeclarado;

  // ⚠️ The billable weight lands on the GROSS weight and must never reach the net
  // one. `pesoLiquidoKg` is published as ML's `WEIGHT` attribute — the product's
  // mass — and `dimensoesDoPacote`'s own docblock states that `WEIGHT` has no
  // fallback because sending gross as net "would invent data". Here the value is
  // weaker still: a BILLABLE figure from a cost simulator, ML's assumed package,
  // possibly volumetric. As a gross weight it makes `dimensoesDoPacote` resolve
  // (so the produto is publishable and freight-quotable) while the produto screen
  // still names `Peso líquido` as the one field a human must fill. Both halves
  // are deliberate.
  const pesoBrutoDeclarado = pesoBrutoDeclaradoKg(item);
  const pesoBrutoFaturavel =
    typeof extras.billableWeightG === 'number' && extras.billableWeightG > 0
      ? extras.billableWeightG / 1000
      : null;

  return {
    mlItemId: item.id,
    sku: skuFromAttributes(item.attributes),
    sellerCustomField: item.seller_custom_field ?? null,

    nome: (item.family_name ?? item.title ?? '').trim(),
    ehKit: isKitFromAttributes(item.attributes),
    ehUsado: condition === 'used',
    // Still no fabricated defaults (the legacy bug): every value below comes from
    // something ML actually said, and stays null when it said nothing.
    pesoLiquidoKg: weightKgFromAttribute(attrById(item.attributes, 'WEIGHT')),
    pesoBrutoKg: pesoBrutoDeclarado ?? pesoBrutoFaturavel,
    alturaCm: pacote.alturaCm,
    larguraCm: pacote.larguraCm,
    profundidadeCm: pacote.profundidadeCm,

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
