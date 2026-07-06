import { describe, expect, it } from 'vitest';
import {
  attrColor,
  attrNA,
  attrPackageDimensions,
  attrSku,
  attrWeightKg,
  attributeToMercadoLivre,
} from '../src/mapping/attributes';
import {
  ESTADO_PUBLICACAO,
  buildItemPayload,
  estadoFromMlStatus,
} from '../src/mapping/itemPayload';

describe('attributeToMercadoLivre', () => {
  it('emits value_name with the unit appended and keeps unit_id', () => {
    expect(attributeToMercadoLivre({ id: 'X', value_name: '55', unit_id: 'cm' })).toEqual({
      id: 'X',
      value_name: '55 cm',
      unit_id: 'cm',
    });
  });

  it('N/A (value_id -1) nulls value_name and drops the unit', () => {
    expect(attributeToMercadoLivre({ ...attrNA('GTIN'), unit_id: 'cm' })).toEqual({
      id: 'GTIN',
      value_id: '-1',
      value_name: null,
    });
  });

  it('weight and dimension factories embed the units (old wire parity)', () => {
    expect(attrWeightKg(0.5)).toEqual({ id: 'WEIGHT', name: 'Peso', value_name: '0.5 kg' });
    expect(
      attrPackageDimensions({ alturaCm: 10, larguraCm: 20, profundidadeCm: 30, pesoKg: 0.5 }),
    ).toEqual([
      { id: 'SELLER_PACKAGE_HEIGHT', value_name: '10 cm' },
      { id: 'SELLER_PACKAGE_LENGTH', value_name: '20 cm' },
      { id: 'SELLER_PACKAGE_WIDTH', value_name: '30 cm' },
      { id: 'SELLER_PACKAGE_WEIGHT', value_name: '500 g' },
    ]);
  });
});

describe('buildItemPayload — create (legacy seller, no variations)', () => {
  const base = {
    isUpdate: false,
    isUserProductSeller: false,
    title: 'Camiseta Básica',
    condition: 'new' as const,
    sellerCustomField: 'link-doc-1',
    categoryId: 'MLB31447',
    listingTypeId: 'gold_special',
    price: 79.9,
    availableQuantity: 12,
    pictures: [{ id: 'IMG1' }, { id: 'IMG2' }],
    attributes: [attrSku('SKU-1'), attrWeightKg(0.3)],
  };

  it('emits the full create body (buy_it_now/BRL/MLB + seller_custom_field)', () => {
    const data = buildItemPayload(base);
    expect(data).toMatchObject({
      title: 'Camiseta Básica',
      category_id: 'MLB31447',
      currency_id: 'BRL',
      condition: 'new',
      site_id: 'MLB',
      buying_mode: 'buy_it_now',
      listing_type_id: 'gold_special',
      seller_custom_field: 'link-doc-1',
      price: 79.9,
      available_quantity: 12,
      pictures: [{ id: 'IMG1' }, { id: 'IMG2' }],
    });
    expect(data.status).toBeUndefined();
    expect(data.family_name).toBeUndefined();
    expect(data.variations).toBeUndefined();
    // NOTE: `name` ('Peso') is stored on the link doc but never sent to the
    // API — the old toMercadoLivre() transform omits it.
    expect(data.attributes).toEqual([
      { id: 'SELLER_SKU', value_name: 'SKU-1' },
      { id: 'WEIGHT', value_name: '0.3 kg' },
    ]);
  });

  it('update mode drops the create-only fields and reactivates', () => {
    const data = buildItemPayload({ ...base, isUpdate: true });
    expect(data.status).toBe('active');
    expect(data.category_id).toBeUndefined();
    expect(data.currency_id).toBeUndefined();
    expect(data.site_id).toBeUndefined();
    expect(data.buying_mode).toBeUndefined();
    expect(data.seller_custom_field).toBeUndefined();
    // Without variations the price/quantity stay at the parent on update.
    expect(data.price).toBe(79.9);
    expect(data.available_quantity).toBe(12);
  });
});

describe('buildItemPayload — legacy variations', () => {
  const base = {
    isUpdate: false,
    isUserProductSeller: false,
    title: 'Camiseta',
    condition: 'new' as const,
    sellerCustomField: 'link-doc-1',
    categoryId: 'MLB31447',
    price: 50,
    availableQuantity: 99, // must be moved down to the variations
    pictures: [{ id: 'PARENT-IMG' }],
    attributes: [attrSku('SKU-PAI'), attrColor('Preto')], // COLOR collides with a combination
    variations: [
      {
        produtoId: 'prod-var-1',
        order: 1,
        availableQuantity: 5,
        attributeCombinations: [attrColor('Preto')],
        attributes: [attrSku('SKU-1')],
      },
      {
        mlVariationId: 987,
        produtoId: 'prod-var-2',
        availableQuantity: 7,
        pictureIds: ['VAR-IMG'],
        attributeCombinations: [attrColor('Branco')],
        attributes: [attrSku('SKU-2')],
      },
    ],
  };

  it('moves quantity+price down, inherits parent pictures, prunes combination ids from parent attrs', () => {
    const data = buildItemPayload(base);
    expect(data.available_quantity).toBeUndefined();
    expect(data.price).toBe(50); // kept at parent on CREATE
    // COLOR was pruned from the parent attributes (it's a combination id).
    expect(data.attributes).toEqual([{ id: 'SELLER_SKU', value_name: 'SKU-PAI' }]);

    const variations = data.variations as Array<Record<string, unknown>>;
    expect(variations).toHaveLength(2);
    expect(variations[0]).toMatchObject({
      seller_custom_field: 'prod-var-1',
      _order: 1,
      available_quantity: 5,
      price: 50,
      picture_ids: ['PARENT-IMG'], // inherited
      attribute_combinations: [{ id: 'COLOR', value_name: 'Preto' }],
      attributes: [{ id: 'SELLER_SKU', value_name: 'SKU-1' }],
    });
    expect(variations[0]!.id).toBeUndefined(); // create → no ML variation id
    expect(variations[1]).toMatchObject({
      seller_custom_field: 'prod-var-2',
      picture_ids: ['VAR-IMG'], // own pictures win
    });
    expect(variations[1]!.id).toBeUndefined(); // id only rides on update
  });

  it('update with variations removes the parent price and carries variation ids', () => {
    const data = buildItemPayload({ ...base, isUpdate: true });
    expect(data.price).toBeUndefined();
    const variations = data.variations as Array<Record<string, unknown>>;
    expect(variations[0]!.id).toBeUndefined(); // never published
    expect(variations[1]!.id).toBe(987);
    expect(variations[1]).toMatchObject({ price: 50 }); // price still per-variation
  });
});

describe('buildItemPayload — User Products seller', () => {
  it('sends family_name and NO variations array content', () => {
    const data = buildItemPayload({
      isUpdate: false,
      isUserProductSeller: true,
      title: 'Camiseta UP',
      condition: 'new',
      sellerCustomField: 'link-doc-9',
      categoryId: 'MLB31447',
      price: 30,
      availableQuantity: 3,
      variations: [
        {
          produtoId: 'ignored',
          availableQuantity: 1,
          attributeCombinations: [attrColor('Azul')],
        },
      ],
    });
    expect(data.family_name).toBe('Camiseta UP');
    expect(data.title).toBeUndefined();
    expect(data.variations).toBeUndefined();
    expect(data.available_quantity).toBe(3);
  });
});

describe('estadoFromMlStatus', () => {
  it('maps the ML statuses to the old single-char estado codes', () => {
    expect(estadoFromMlStatus('active')).toBe(ESTADO_PUBLICACAO.publicado);
    expect(estadoFromMlStatus('paused')).toBe(ESTADO_PUBLICACAO.pausado);
    expect(estadoFromMlStatus('closed')).toBe(ESTADO_PUBLICACAO.cancelado);
    expect(estadoFromMlStatus('under_review')).toBe(ESTADO_PUBLICACAO.underReview);
    expect(estadoFromMlStatus('weird_new_status')).toBe(ESTADO_PUBLICACAO.error);
    expect(estadoFromMlStatus(null)).toBe(ESTADO_PUBLICACAO.error);
  });
});
