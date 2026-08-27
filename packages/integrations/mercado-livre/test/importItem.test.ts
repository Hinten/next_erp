import { describe, expect, it } from 'vitest';

import { itemSchema } from '../src/types';
import {
  attributesFromItem,
  isKitFromAttributes,
  itemStockLivesOnChildren,
  mapMlItemToImport,
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
