import { describe, expect, it } from 'vitest';

import { itemSchema } from '../src/types';
import {
  attributesFromItem,
  isKitFromAttributes,
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
});
