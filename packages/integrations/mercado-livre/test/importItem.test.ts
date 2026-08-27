import { describe, expect, it } from 'vitest';

import { itemSchema } from '../src/types';
import {
  attributesFromItem,
  isKitFromAttributes,
  itemStockLivesOnChildren,
  mapMlItemToImport,
  pesoBrutoDeclaradoKg,
  skuFromAttributes,
  skuGuessFromVariations,
  weightKgFromAttribute,
} from '../src/mapping/importItem';

/** A realistic simple (non-variation) MLB item, parsed through the schema. */
function simpleItem(over: Record<string, unknown> = {}) {
  return itemSchema.parse({
    id: 'MLB123',
    title: 'Camiseta Preta',
    category_id: 'MLB1430',
    base_price: 79.9,
    price: 69.9,
    available_quantity: 12,
    condition: 'new',
    status: 'active',
    listing_type_id: 'gold_special',
    seller_id: 55,
    seller_custom_field: 'SKU-CAMISA-P',
    shipping: { free_shipping: true },
    video_id: 'YT123',
    attributes: [
      { id: 'SELLER_SKU', value_name: 'SKU-CAMISA-P' },
      { id: 'WEIGHT', value_name: '0.5 kg' },
      { id: 'SELLER_PACKAGE_HEIGHT', value_name: '5 cm' },
      { id: 'SELLER_PACKAGE_LENGTH', value_name: '30 cm' },
      { id: 'SELLER_PACKAGE_WIDTH', value_name: '20 cm' },
      { id: 'SELLER_PACKAGE_WEIGHT', value_name: '600 g' },
      { id: 'BRAND', name: 'Marca', value_name: 'Acme' },
      { id: 'IS_KIT', value_name: 'Não' },
    ],
    pictures: [{ id: 'PIC1', secure_url: 'https://x/PIC1-O.jpg' }],
    ...over,
  });
}

describe('attribute helpers', () => {
  it('reads SELLER_SKU', () => {
    expect(skuFromAttributes([{ id: 'SELLER_SKU', value_name: 'ABC' }])).toBe('ABC');
    expect(skuFromAttributes([{ id: 'OTHER', value_name: 'x' }])).toBeNull();
    expect(skuFromAttributes(null)).toBeNull();
  });

  it('parses WEIGHT with the CORRECTED g→0.001 factor (legacy used a 10x-wrong 0.01)', () => {
    expect(weightKgFromAttribute({ id: 'WEIGHT', value_name: '0.5 kg' })).toBe(0.5);
    expect(weightKgFromAttribute({ id: 'WEIGHT', value_name: '500 g' })).toBe(0.5);
    expect(weightKgFromAttribute({ id: 'WEIGHT', value_name: '250 g' })).toBe(0.25);
    expect(weightKgFromAttribute(undefined)).toBeNull();
    expect(weightKgFromAttribute({ id: 'WEIGHT', value_name: 'N/A' })).toBeNull();
  });

  it('IS_KIT == "Sim" → kit', () => {
    expect(isKitFromAttributes([{ id: 'IS_KIT', value_name: 'Sim' }])).toBe(true);
    expect(isKitFromAttributes([{ id: 'IS_KIT', value_name: 'Não' }])).toBe(false);
  });

  it('embeds link attributes but EXCLUDES the ids the publish path re-derives', () => {
    const attrs = attributesFromItem([
      { id: 'SELLER_SKU', value_name: 'x' },
      { id: 'WEIGHT', value_name: '1 kg' },
      { id: 'SELLER_PACKAGE_HEIGHT', value_name: '5 cm' },
      { id: 'IS_KIT', value_name: 'Não' },
      { id: 'BRAND', value_name: 'Acme' },
      { id: 'COLOR', value_name: 'Preto' },
    ]);
    expect(attrs.map((a) => a.id)).toEqual(['BRAND', 'COLOR']);
  });

  /**
   * ⚠️ `value_struct` is the ONLY place an item response states a unit. ML
   * answers `'355 mL'` in `value_name` with the unit baked in, and never sends
   * `unit_id` — that is a field we SEND. Before this was read, every imported
   * measurement stored the unit inside its own text, where the editor's
   * digits-only filter stripped it and stamped the category default over it.
   */
  it('splits a number_unit measurement out of value_struct', () => {
    expect(
      attributesFromItem([
        {
          id: 'UNIT_VOLUME',
          name: 'Volume da unidade',
          value_id: '3681798',
          value_name: '355 mL',
          value_struct: { number: 355, unit: 'mL' },
        },
      ]),
    ).toEqual([
      {
        id: 'UNIT_VOLUME',
        // The id names the PAIR, so it cannot survive the split.
        value_id: null,
        name: 'Volume da unidade',
        value_name: '355',
        attribute_group_id: null,
        attribute_group_name: null,
        unit_id: 'mL',
      },
    ]);
  });

  it('keeps a fractional measurement exact', () => {
    const [attr] = attributesFromItem([
      { id: 'LENGTH', value_name: '62.5 cm', value_struct: { number: 62.5, unit: 'cm' } },
    ]);
    expect(attr).toMatchObject({ value_name: '62.5', unit_id: 'cm' });
  });

  it('leaves the value WHOLE when ML sends no usable struct', () => {
    // No blind parse here: this layer has no category metadata, so it cannot
    // tell a unit from the tail of an ordinary string. The editor splits it
    // later, where `allowedUnits` is on hand to match against.
    for (const struct of [null, undefined, {}, { number: 355 }, { unit: 'mL' }]) {
      const [attr] = attributesFromItem([
        { id: 'UNIT_VOLUME', value_id: 'v1', value_name: '355 mL', value_struct: struct },
      ]);
      expect(attr).toMatchObject({ value_id: 'v1', value_name: '355 mL', unit_id: null });
    }
  });

  it('never lets a struct override a unit_id ML did send', () => {
    const [attr] = attributesFromItem([
      { id: 'LENGTH', value_name: '55', unit_id: 'mm', value_struct: { number: 55, unit: 'cm' } },
    ]);
    expect(attr).toMatchObject({ unit_id: 'mm' });
  });

  it('does not touch a plain string attribute that happens to end in letters', () => {
    const [attr] = attributesFromItem([{ id: 'BRAND', value_name: 'Nike Air' }]);
    expect(attr).toMatchObject({ value_name: 'Nike Air', unit_id: null });
  });
});

describe('mapMlItemToImport', () => {
  it('maps a simple item end-to-end', () => {
    const m = mapMlItemToImport(simpleItem());
    expect(m).toMatchObject({
      mlItemId: 'MLB123',
      nome: 'Camiseta Preta',
      sku: 'SKU-CAMISA-P',
      sellerCustomField: 'SKU-CAMISA-P',
      ehKit: false,
      ehUsado: false,
      condicao: 1,
      condition: 'new',
      pesoLiquidoKg: 0.5,
      pesoBrutoKg: 0.6, // SELLER_PACKAGE_WEIGHT 600 g
      alturaCm: 5,
      larguraCm: 30,
      profundidadeCm: 20,
      precoNormal: 79.9,
      precoPromocional: 69.9, // price != base_price
      availableQuantity: 12,
      categoryId: 'MLB1430',
      listingTypeId: 'gold_special',
      estado: 'p', // active
      status: 'active',
      freteGratis: true,
      isUserProductModel: false,
      videoId: 'YT123',
    });
    // only non-derived attributes ride on the link
    expect(m.attributes.map((a) => a.id)).toEqual(['BRAND']);
  });

  it('no promo when price == base_price', () => {
    const m = mapMlItemToImport(simpleItem({ base_price: 50, price: 50 }));
    expect(m.precoNormal).toBe(50);
    expect(m.precoPromocional).toBeNull();
  });

  it('normal price falls back to price when base_price is absent', () => {
    const m = mapMlItemToImport(simpleItem({ base_price: null, price: 42 }));
    expect(m.precoNormal).toBe(42);
    expect(m.precoPromocional).toBeNull();
  });

  it('does NOT fabricate weight/dimensions when ML has none (legacy invented defaults)', () => {
    const m = mapMlItemToImport(simpleItem({ attributes: [{ id: 'BRAND', value_name: 'Acme' }] }));
    expect(m.pesoLiquidoKg).toBeNull();
    expect(m.pesoBrutoKg).toBeNull();
    expect(m.alturaCm).toBeNull();
    expect(m.larguraCm).toBeNull();
    expect(m.profundidadeCm).toBeNull();
  });

  it('used condition → condicao 2 + ehUsado + link condition', () => {
    const m = mapMlItemToImport(simpleItem({ condition: 'used' }));
    expect(m.condicao).toBe(2);
    expect(m.ehUsado).toBe(true);
    expect(m.condition).toBe('used');
  });

  it('paused/closed status map to the estado codes', () => {
    expect(mapMlItemToImport(simpleItem({ status: 'paused' })).estado).toBe('pa');
    expect(mapMlItemToImport(simpleItem({ status: 'closed' })).estado).toBe('c');
    expect(mapMlItemToImport(simpleItem({ status: 'under_review' })).estado).toBe('v');
  });

  it('family_name → User-Products flag + name from the family', () => {
    const m = mapMlItemToImport(simpleItem({ family_name: 'Camiseta', title: 'Camiseta Preta M' }));
    expect(m.isUserProductModel).toBe(true);
    expect(m.nome).toBe('Camiseta');
  });
});

describe('skuGuessFromVariations (#438 dedup helper)', () => {
  it('returns the common prefix when all variation SKUs share it (last 6 chars stripped)', () => {
    const item = itemSchema.parse({
      id: 'MLB9',
      variations: [
        { id: 1, attributes: [{ id: 'SELLER_SKU', value_name: 'BASE01-AAAAAA' }] },
        { id: 2, attributes: [{ id: 'SELLER_SKU', value_name: 'BASE01-BBBBBB' }] },
      ],
    });
    expect(skuGuessFromVariations(item)).toBe('BASE01-');
  });

  it('returns null when prefixes diverge', () => {
    const item = itemSchema.parse({
      id: 'MLB9',
      variations: [
        { id: 1, attributes: [{ id: 'SELLER_SKU', value_name: 'AAA111-XXXXXX' }] },
        { id: 2, attributes: [{ id: 'SELLER_SKU', value_name: 'BBB222-YYYYYY' }] },
      ],
    });
    expect(skuGuessFromVariations(item)).toBeNull();
  });

  it('returns null when ANY variation lacks a usable SKU (never guess from a subset)', () => {
    const item = itemSchema.parse({
      id: 'MLB9',
      variations: [
        { id: 1, attributes: [{ id: 'SELLER_SKU', value_name: 'BASE01-AAAAAA' }] },
        { id: 2, attributes: [{ id: 'COLOR', value_name: 'Azul' }] }, // no SELLER_SKU
      ],
    });
    expect(skuGuessFromVariations(item)).toBeNull();
  });
});

describe('itemStockLivesOnChildren (#706)', () => {
  it('false for a plain listing — the item IS the stock unit', () => {
    expect(itemStockLivesOnChildren(itemSchema.parse({ id: 'MLB1' }))).toBe(false);
  });

  it('true for a legacy variations[] listing — each variation carries its own quantity', () => {
    const item = itemSchema.parse({ id: 'MLB1', variations: [{ id: 1 }] });
    expect(itemStockLivesOnChildren(item)).toBe(true);
  });

  it('true for a User-Products item — every member becomes a child produto', () => {
    const item = itemSchema.parse({ id: 'MLB1', family_name: 'Camiseta Lisa' });
    expect(itemStockLivesOnChildren(item)).toBe(true);
  });

  it('an EMPTY variations array is not children (matches import.ts hasVariations)', () => {
    expect(itemStockLivesOnChildren(itemSchema.parse({ id: 'MLB1', variations: [] }))).toBe(false);
  });
});

describe('mapMlItemToImport — userProductId (#706)', () => {
  it('carries the item user_product_id through', () => {
    const item = itemSchema.parse({ id: 'MLB1', user_product_id: 'MLBU777' });
    expect(mapMlItemToImport(item).userProductId).toBe('MLBU777');
  });

  it('is null when ML omits it', () => {
    expect(mapMlItemToImport(itemSchema.parse({ id: 'MLB1' })).userProductId).toBeNull();
  });
});

/**
 * The package fallbacks — a listing where ML declares no `SELLER_PACKAGE_*` and
 * no `WEIGHT` at all, which is the normal shape for an ME2 listing (ML stipulates
 * the package itself). Measured live on `MLB5146021467`, 27/08/2026.
 *
 * ⚠️ Every fixture below uses THREE DISTINCT axis values on purpose. The real
 * listing is 10×10×10 cm, so a test built from it alone cannot tell a straight
 * mapping from the crossed one — and the two genuinely differ here (tier 1 is
 * crossed for legacy publish parity, tier 2 is straight because ML names the spec
 * attributes in Portuguese). Equal fixtures also pass against a clobbering
 * writer, the shape that got two bugs past this suite in #1142.
 */
describe('mapMlItemToImport — package fallbacks', () => {
  /** ML's shape for a `number_unit` on a live item: the split ONLY in `values[]`. */
  const medida = (id: string, n: number) => ({
    id,
    value_id: null,
    value_name: `${n} cm`,
    values: [{ id: null, name: `${n} cm`, struct: { number: n, unit: 'cm' } }],
  });

  /** A listing with no package of its own — tier 1 empty by construction. */
  const semPacote = (attrs: unknown[]) =>
    simpleItem({ attributes: [{ id: 'BRAND', value_name: 'Genérica' }, ...attrs] });

  it('falls back to the product-spec trio, mapped STRAIGHT (Altura/Largura/Comprimento)', () => {
    const m = mapMlItemToImport(
      semPacote([medida('HEIGHT', 11), medida('WIDTH', 22), medida('LENGTH', 33)]),
    );
    expect(m.alturaCm).toBe(11); // HEIGHT = Altura
    expect(m.larguraCm).toBe(22); // WIDTH  = Largura
    expect(m.profundidadeCm).toBe(33); // LENGTH = Comprimento
  });

  it('reads the spec trio from a baked value_name when ML sends no struct at all', () => {
    const m = mapMlItemToImport(
      semPacote([
        { id: 'HEIGHT', value_name: '11 cm' },
        { id: 'WIDTH', value_name: '22 cm' },
        { id: 'LENGTH', value_name: '33 cm' },
      ]),
    );
    expect([m.alturaCm, m.larguraCm, m.profundidadeCm]).toEqual([11, 22, 33]);
  });

  it('converts the struct unit (mm/m), and DROPS an unrecognised one', () => {
    const mm = mapMlItemToImport(
      semPacote([
        { id: 'HEIGHT', values: [{ struct: { number: 110, unit: 'mm' } }] },
        { id: 'WIDTH', values: [{ struct: { number: 22, unit: 'cm' } }] },
        { id: 'LENGTH', values: [{ struct: { number: 0.33, unit: 'm' } }] },
      ]),
    );
    expect([mm.alturaCm, mm.larguraCm, mm.profundidadeCm]).toEqual([11, 22, 33]);

    // An inch is a real ML unit we have no factor for. Guessing would be a box
    // off by 2.54×, so the whole trio is refused rather than partly filled.
    const inch = mapMlItemToImport(
      semPacote([
        { id: 'HEIGHT', values: [{ struct: { number: 11, unit: 'in' } }] },
        { id: 'WIDTH', values: [{ struct: { number: 22, unit: 'cm' } }] },
        { id: 'LENGTH', values: [{ struct: { number: 33, unit: 'cm' } }] },
      ]),
    );
    expect([inch.alturaCm, inch.larguraCm, inch.profundidadeCm]).toEqual([null, null, null]);
  });

  it('⚠️ CONTROL — a declared SELLER_PACKAGE_* set wins, and takes NO axis from the spec trio', () => {
    const m = mapMlItemToImport(
      simpleItem({
        attributes: [
          { id: 'SELLER_PACKAGE_HEIGHT', value_name: '5 cm' },
          { id: 'SELLER_PACKAGE_LENGTH', value_name: '30 cm' },
          { id: 'SELLER_PACKAGE_WIDTH', value_name: '20 cm' },
          medida('HEIGHT', 11),
          medida('WIDTH', 22),
          medida('LENGTH', 33),
        ],
      }),
    );
    // Crossed, and none of 11/22/33 anywhere in sight.
    expect([m.alturaCm, m.larguraCm, m.profundidadeCm]).toEqual([5, 30, 20]);
  });

  it('⚠️ CONTROL — the spec trio is ALL-OR-NOTHING: one axis alone writes nothing', () => {
    const m = mapMlItemToImport(semPacote([medida('HEIGHT', 11)]));
    expect([m.alturaCm, m.larguraCm, m.profundidadeCm]).toEqual([null, null, null]);
  });

  it('⚠️ CONTROL — a partial SELLER_PACKAGE_* set stays partial, never topped up', () => {
    // Two sources describing two different boxes must not be merged into a third
    // that neither one states — the rule `rollupDimensoesDosFilhos` follows.
    const m = mapMlItemToImport(
      simpleItem({
        attributes: [
          { id: 'SELLER_PACKAGE_HEIGHT', value_name: '5 cm' },
          medida('WIDTH', 22),
          medida('LENGTH', 33),
        ],
      }),
    );
    expect([m.alturaCm, m.larguraCm, m.profundidadeCm]).toEqual([5, null, null]);
  });

  it('⚠️ CONTROL — a zero axis is not a package', () => {
    const m = mapMlItemToImport(
      semPacote([medida('HEIGHT', 0), medida('WIDTH', 22), medida('LENGTH', 33)]),
    );
    expect([m.alturaCm, m.larguraCm, m.profundidadeCm]).toEqual([null, null, null]);
  });

  it('billableWeightG lands on pesoBrutoKg and NEVER on pesoLiquidoKg', () => {
    const m = mapMlItemToImport(semPacote([]), { billableWeightG: 1539 });
    expect(m.pesoBrutoKg).toBe(1.539);
    // `pesoLiquidoKg` publishes as ML's WEIGHT attribute — the product's mass. A
    // billable figure there would invent data on every republish.
    expect(m.pesoLiquidoKg).toBeNull();
  });

  it('⚠️ CONTROL — a declared SELLER_PACKAGE_WEIGHT outranks the billable one', () => {
    const m = mapMlItemToImport(simpleItem(), { billableWeightG: 1539 });
    expect(m.pesoBrutoKg).toBe(0.6); // SELLER_PACKAGE_WEIGHT 600 g
  });

  it('⚠️ CONTROL — no attributes and no billable weight still yields five nulls', () => {
    const m = mapMlItemToImport(semPacote([]), { billableWeightG: null });
    expect([m.pesoLiquidoKg, m.pesoBrutoKg, m.alturaCm, m.larguraCm, m.profundidadeCm]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('the real MLB5146021467 body: 10x10x10 cm from the spec trio, 1.539 kg from ML', () => {
    // Verbatim from `GET /items/MLB5146021467?include_attributes=all`, 27/08/2026 —
    // the listing that made this fallback necessary. No SELLER_PACKAGE_*, no
    // WEIGHT, `shipping.dimensions` null.
    const item = itemSchema.parse({
      id: 'MLB5146021467',
      title: 'Bandeja De Madeira Enfeitada Gatinho Marrom',
      family_name: 'Bandeja De Madeira Enfeitada Gatinho',
      family_id: 3132311435776912,
      user_product_id: 'MLBU4961776613',
      category_id: 'MLB457167',
      price: 97.97,
      base_price: 97.97,
      available_quantity: 5,
      condition: 'new',
      status: 'active',
      listing_type_id: 'gold_pro',
      seller_id: 3616169770,
      shipping: {
        mode: 'me2',
        tags: ['mandatory_free_shipping'],
        dimensions: null,
        free_shipping: true,
        logistic_type: 'xd_drop_off',
      },
      attributes: [
        { id: 'BRAND', value_id: '276243', name: 'Marca', value_name: 'Genérica' },
        { id: 'COLOR', value_id: '52005', name: 'Cor', value_name: 'Marrom' },
        {
          id: 'HEIGHT',
          name: 'Altura',
          value_id: null,
          value_name: '10 cm',
          values: [{ id: null, name: '10 cm', struct: { number: 10, unit: 'cm' } }],
        },
        {
          id: 'LENGTH',
          name: 'Comprimento',
          value_id: null,
          value_name: '10 cm',
          values: [{ id: null, name: '10 cm', struct: { number: 10, unit: 'cm' } }],
        },
        {
          id: 'WIDTH',
          name: 'Largura',
          value_id: null,
          value_name: '10 cm',
          values: [{ id: null, name: '10 cm', struct: { number: 10, unit: 'cm' } }],
        },
        { id: 'SELLER_SKU', value_id: null, name: 'SKU', value_name: 'bandGato123' },
      ],
    });

    // Before this change every one of these was null, on two consecutive imports.
    const m = mapMlItemToImport(item, { billableWeightG: 1539 });
    expect(m.alturaCm).toBe(10);
    expect(m.larguraCm).toBe(10);
    expect(m.profundidadeCm).toBe(10);
    expect(m.pesoBrutoKg).toBe(1.539);
    // ML publishes no net weight for this listing and nothing may invent one —
    // the produto screen still asks the operator for it.
    expect(m.pesoLiquidoKg).toBeNull();
    expect(m.sku).toBe('bandGato123');
    expect(m.isUserProductModel).toBe(true);
  });
});

describe('pesoBrutoDeclaradoKg — the spend-or-not gate the IO layer reads', () => {
  it('answers the declared weight, so a listing that has one costs no ML call', () => {
    expect(pesoBrutoDeclaradoKg(simpleItem())).toBe(0.6);
  });

  it('null when ML declares none — the case that earns the lookup', () => {
    expect(pesoBrutoDeclaradoKg(simpleItem({ attributes: [] }))).toBeNull();
  });
});
