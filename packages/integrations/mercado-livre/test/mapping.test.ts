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
  buildUserProductItemPayload,
  estadoFromMlStatus,
  userProductMemberInputs,
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
    // #799 bug 2: the item-root price is CREATE-only. Both legacy publish call
    // sites strip it on update (exportarProdutos.dart:586 legacy, :466 UP); a
    // price CHANGE is a dedicated PUT /items/{id} in precoSync, never a publish.
    expect(data.price).toBeUndefined();
    // Quantity is different — it only moves down when there ARE variations.
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
        order: 2,
        availableQuantity: 7,
        pictureIds: ['VAR-IMG'],
        attributeCombinations: [attrColor('Branco')],
        attributes: [attrSku('SKU-2')],
      },
    ],
  };

  it('moves quantity down, inherits parent pictures, prunes combination ids AND the parent SKU', () => {
    const data = buildItemPayload(base);
    expect(data.available_quantity).toBeUndefined();
    // #799 bug 2: a CREATE with variations carries no item-root price either
    // (models.dart:1530, guarded by the `update = id == null` misnomer).
    expect(data.price).toBeUndefined();
    // COLOR pruned as a combination id; SELLER_SKU pruned because each variation
    // carries its own and the combination prune can never reach it (#799 bug 3,
    // models.dart:1508-1515). Nothing survives at the parent here.
    expect(data.attributes).toEqual([]);

    const variations = data.variations as Array<Record<string, unknown>>;
    expect(variations).toHaveLength(2);
    expect(variations[0]).toMatchObject({
      seller_custom_field: 'prod-var-1',
      available_quantity: 5,
      price: 50,
      picture_ids: ['PARENT-IMG'], // inherited
      attribute_combinations: [{ id: 'COLOR', value_name: 'Preto' }],
      attributes: [{ id: 'SELLER_SKU', value_name: 'SKU-1' }],
    });
    // #799 bug 1: `_order` is an internal sort key the legacy deletes before
    // sending (models.dart:1394). We leaked produto.ordem into it.
    expect(variations[0]!._order).toBeUndefined();
    expect(variations[0]!.id).toBeUndefined(); // create → no ML variation id
    expect(variations[1]).toMatchObject({
      seller_custom_field: 'prod-var-2',
      picture_ids: ['VAR-IMG'], // own pictures win
    });
    expect(variations[1]!._order).toBeUndefined();
    expect(variations[1]!.id).toBeUndefined(); // id only rides on update
  });

  it('sends an id-less custom characteristic by name (#797 E8)', () => {
    // ML identifies an attribute outside its taxonomy by `name`; the old port
    // invented `{ id: 'SABOR' }`. An id-less combination also has no parent
    // attribute it could collide with, so the prune must not choke on it.
    const data = buildItemPayload({
      ...base,
      variations: [
        {
          ...base.variations[0]!,
          attributeCombinations: [{ name: 'Sabor', value_name: 'Baunilha' }],
        },
      ],
    });
    const variations = data.variations as Array<Record<string, unknown>>;
    expect(variations[0]!.attribute_combinations).toEqual([
      { name: 'Sabor', value_name: 'Baunilha' },
    ]);
    // the parent keeps COLOR: no combination claims that id any more
    expect(data.attributes).toEqual([{ id: 'COLOR', value_name: 'Preto' }]);
  });

  it('keeps a non-SKU parent attribute that no variation claims', () => {
    const data = buildItemPayload({
      ...base,
      attributes: [attrSku('SKU-PAI'), attrColor('Preto'), attrWeightKg(0.3)],
    });
    expect(data.attributes).toEqual([{ id: 'WEIGHT', value_name: '0.3 kg' }]);
  });

  it('sorts the emitted variations by order', () => {
    const data = buildItemPayload({
      ...base,
      variations: [
        { ...base.variations[1]!, produtoId: 'segundo', order: 9 },
        { ...base.variations[0]!, produtoId: 'primeiro', order: 3 },
      ],
    });
    const variations = data.variations as Array<Record<string, unknown>>;
    expect(variations.map((v) => v.seller_custom_field)).toEqual(['primeiro', 'segundo']);
  });

  it('sorts an absent order first, matching the legacy `?? 0`', () => {
    const data = buildItemPayload({
      ...base,
      variations: [
        { ...base.variations[0]!, produtoId: 'com-ordem', order: 5 },
        { ...base.variations[1]!, produtoId: 'sem-ordem', order: null },
      ],
    });
    const variations = data.variations as Array<Record<string, unknown>>;
    expect(variations.map((v) => v.seller_custom_field)).toEqual(['sem-ordem', 'com-ordem']);
  });

  it('update with variations carries the variation ids and prices them per variation', () => {
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
    // ⚠️ This pins the MAPPER, not a supported outcome. Handing this builder a
    // User-Products seller together with children collapses a whole listing
    // family into one variation-less item — which is why `publishProduto`
    // refuses that combination outright before it ever gets here (#798; see
    // `publish.test.ts` → "User-Products model resolution"). Under UP each
    // variation is its own ML item, so a family is published by calling this
    // once PER MEMBER, never once with a variations array.
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

  it('an UPDATE sends NO name field — neither family_name nor title', () => {
    // The single-item half of User Products: a UP produto with no children
    // republishes through here, and `family_name` on that PUT is the
    // `ML 400 BODY_INVALID_FIELDS / The field family name is invalid` that made
    // every republish fail. `buildUserProductItemPayload` (the family half) has
    // always stripped it; this is the same rule on the same model.
    const data = buildItemPayload({
      isUpdate: true,
      isUserProductSeller: true,
      title: 'Camiseta UP',
      condition: 'new',
      sellerCustomField: 'link-doc-9',
      categoryId: 'MLB31447',
      price: 30,
      availableQuantity: 3,
      attributes: [attrSku('SKU-UP')],
      pictures: [{ id: 'IMG1' }],
    });

    expect(data.family_name).toBeUndefined();
    // Not a fallback either: ML derives the title from `family_name` + the
    // attributes, so writing one is its own bad request.
    expect(data.title).toBeUndefined();
    // ...while everything an edit exists to change still goes out.
    expect(data.status).toBe('active');
    expect(data.available_quantity).toBe(3);
    expect(data.attributes).toEqual([{ id: 'SELLER_SKU', value_name: 'SKU-UP' }]);
    expect(data.pictures).toEqual([{ id: 'IMG1' }]);
  });
});

describe('buildUserProductItemPayload', () => {
  const member = {
    produtoId: 'child-1',
    availableQuantity: 4,
    attributeCombinations: [attrColor('Azul')],
    attributes: [attrSku('SKU-M')],
  };
  const base = {
    familyName: 'Camiseta Básica',
    condition: 'new' as const,
    categoryId: 'MLB31447',
    listingTypeId: 'gold_special',
    price: 79.9,
    attributes: [attrSku('SKU-PAI'), attrWeightKg(0.3)],
    pictures: [{ id: 'PIC-PAI' }],
    member,
  };

  it('a CREATE carries family_name, the create-only fields and the price', () => {
    const data = buildUserProductItemPayload({ ...base, isUpdate: false });
    expect(data).toMatchObject({
      family_name: 'Camiseta Básica',
      category_id: 'MLB31447',
      condition: 'new',
      site_id: 'MLB',
      buying_mode: 'buy_it_now',
      listing_type_id: 'gold_special',
      currency_id: 'BRL',
      price: 79.9,
      available_quantity: 4,
      // The back-reference is the CHILD produto, not the link doc — each item
      // is one variation, and that is what an import matches on.
      seller_custom_field: 'child-1',
    });
  });

  it('never emits a title or a variations array', () => {
    // Both are hard ML rejections under User Products: it computes the title
    // itself, and the model has no variations array at all.
    for (const isUpdate of [false, true]) {
      const data = buildUserProductItemPayload({ ...base, isUpdate });
      expect(data.title).toBeUndefined();
      expect(data.variations).toBeUndefined();
    }
  });

  it('an UPDATE drops family_name, the create-only fields AND the price', () => {
    const data = buildUserProductItemPayload({ ...base, isUpdate: true });
    // family_name is rejected once the family has sales, and it feeds the
    // family-id hash — carrying it could move the member to another family.
    expect(data.family_name).toBeUndefined();
    expect(data.category_id).toBeUndefined();
    expect(data.condition).toBeUndefined();
    expect(data.listing_type_id).toBeUndefined();
    // Prices belong to the manual price flow and its "baixar preços" guard.
    expect(data.price).toBeUndefined();
    // ...while the fields an edit exists to change still go.
    expect(data.available_quantity).toBe(4);
    expect(data.seller_custom_field).toBe('child-1');
  });

  it("the member's combination rides `attributes`, and its SKU beats the family's", () => {
    const data = buildUserProductItemPayload({ ...base, isUpdate: false });
    // `attribute_combinations` is a legacy-model field on the way in.
    expect(data.attribute_combinations).toBeUndefined();
    const attrs = data.attributes as Array<{ id: string; value_name: string }>;
    expect(attrs.find((a) => a.id === 'COLOR')?.value_name).toBe('Azul');
    // One SELLER_SKU, the member's — legacy `sku ?? pai.sku`.
    expect(attrs.filter((a) => a.id === 'SELLER_SKU')).toHaveLength(1);
    expect(attrs.find((a) => a.id === 'SELLER_SKU')?.value_name).toBe('SKU-M');
    // Family attributes the member does not override still ship.
    expect(attrs.find((a) => a.id === 'WEIGHT')).toBeDefined();
  });

  it('falls back to the family SKU when the member has none of its own', () => {
    const data = buildUserProductItemPayload({
      ...base,
      isUpdate: false,
      member: { ...member, attributes: [] },
    });
    const attrs = data.attributes as Array<{ id: string; value_name: string }>;
    expect(attrs.find((a) => a.id === 'SELLER_SKU')?.value_name).toBe('SKU-PAI');
  });

  it('inherits the family gallery only when the member has no pictures', () => {
    expect(buildUserProductItemPayload({ ...base, isUpdate: false }).pictures).toEqual([
      { id: 'PIC-PAI' },
    ]);
    expect(
      buildUserProductItemPayload({
        ...base,
        isUpdate: false,
        member: { ...member, pictureIds: ['PIC-AZUL'] },
      }).pictures,
    ).toEqual([{ id: 'PIC-AZUL' }]);
  });
});

describe('userProductMemberInputs', () => {
  const input = {
    isUpdate: false,
    isUserProductSeller: true,
    title: 'Camiseta Básica',
    condition: 'new' as const,
    sellerCustomField: 'link-doc-9',
    categoryId: 'MLB31447',
    listingTypeId: 'gold_special',
    price: 50,
    attributes: [attrWeightKg(0.3)],
    pictures: [{ id: 'PIC-PAI' }],
    variations: [
      { produtoId: 'child-1', availableQuantity: 1, attributeCombinations: [attrColor('Azul')] },
      {
        produtoId: 'child-2',
        availableQuantity: 2,
        price: 65,
        attributeCombinations: [attrColor('Verde')],
      },
    ],
  };

  it('projects one input per member, sharing the listing-level fields', () => {
    const members = userProductMemberInputs(input);
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.member.produtoId)).toEqual(['child-1', 'child-2']);
    for (const m of members) {
      expect(m.familyName).toBe('Camiseta Básica');
      expect(m.categoryId).toBe('MLB31447');
      expect(m.pictures).toEqual([{ id: 'PIC-PAI' }]);
    }
  });

  it("a member's own price wins over the anchor's", () => {
    // `propagatePriceToChildren: false` — the same rule the price sync applies.
    expect(userProductMemberInputs(input).map((m) => m.price)).toEqual([50, 65]);
  });

  it('yields nothing for a produto with no variations', () => {
    expect(userProductMemberInputs({ ...input, variations: [] })).toEqual([]);
  });
});

describe('estadoFromMlStatus', () => {
  it('maps the ML statuses to the old short-code estados', () => {
    expect(estadoFromMlStatus('active')).toBe(ESTADO_PUBLICACAO.publicado);
    expect(estadoFromMlStatus('paused')).toBe(ESTADO_PUBLICACAO.pausado);
    expect(estadoFromMlStatus('closed')).toBe(ESTADO_PUBLICACAO.cancelado);
    expect(estadoFromMlStatus('under_review')).toBe(ESTADO_PUBLICACAO.underReview);
    expect(estadoFromMlStatus('weird_new_status')).toBe(ESTADO_PUBLICACAO.error);
    expect(estadoFromMlStatus(null)).toBe(ESTADO_PUBLICACAO.error);
  });
});
