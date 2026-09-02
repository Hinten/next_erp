import { describe, expect, it } from 'vitest';
import {
  ML_ATTR_SKU_PAI_NOME,
  ML_PRODUTO_DERIVED_ATTRIBUTE_IDS,
  ML_PRODUTO_HERDADO_ATTRIBUTE_IDS,
  attrBrand,
  attrColor,
  attrNA,
  attrPackageDimensions,
  attrSize,
  attrSizeGridId,
  attrSizeGridRowId,
  attrSku,
  attrSkuPai,
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
import { attributesFromItem, skuPaiFromAttributes } from '../src/mapping/importItem';

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
      attrPackageDimensions({ alturaCm: 10, larguraCm: 20, profundidadeCm: 30, pesoG: 500 }),
    ).toEqual([
      { id: 'SELLER_PACKAGE_HEIGHT', value_name: '10 cm' },
      { id: 'SELLER_PACKAGE_LENGTH', value_name: '20 cm' },
      { id: 'SELLER_PACKAGE_WIDTH', value_name: '30 cm' },
      { id: 'SELLER_PACKAGE_WEIGHT', value_name: '500 g' },
    ]);
  });

  // The axis crossing is legacy parity (`models.dart:2135`) and stays: ML
  // re-sorts the three for display and bills the volume, which a permutation
  // leaves alone. Pinned so nobody "fixes" it into a silent wire change.
  it('keeps the legacy axis crossing — LENGTH←largura, WIDTH←profundidade', () => {
    const [, length, width] = attrPackageDimensions({
      alturaCm: 1,
      larguraCm: 2,
      profundidadeCm: 3,
      pesoG: 1,
    });
    expect(length).toEqual({ id: 'SELLER_PACKAGE_LENGTH', value_name: '2 cm' });
    expect(width).toEqual({ id: 'SELLER_PACKAGE_WIDTH', value_name: '3 cm' });
  });
});

describe('ML_ATTR_SKU_PAI_NOME (#1400)', () => {
  it('is PINNED to the exact published string', () => {
    // ⚠️ This is the only assertion in the suite that would notice a rename.
    // Every other test — and all production code — goes through the constant, so
    // changing its value is invisible everywhere else.
    //
    // It must not change, because a custom attribute contributes its NAME to
    // ML's family-id hash: renaming it moves every member of every família that
    // carries it into a DIFFERENT família, which ML reports as
    // `family_id.collision` and which no later publish repairs. Since #1414 the
    // characteristic is sent for every new família with no flag, so this value
    // is live on real listings.
    //
    // It is also PUBLIC — it renders in the anúncio's ficha técnica — which is
    // why it reads as ordinary Brazilian retail phrasing rather than naming the
    // internal field it carries.
    expect(ML_ATTR_SKU_PAI_NOME).toBe('Código de referência');
  });

  it('does not collide with an ML attribute display name', () => {
    // ⚠️ The match is id-AGNOSTIC: `skuPaiFromAttributes` folds `name` and never
    // reads `id`, so these ML-DEFINED attributes — which all HAVE ids — can
    // collide. (An id-less-only reading would make this test vacuous; it is
    // not.) `skuPaiHijack` below pins the consequence.
    //
    // ⚠️ Eight literals cannot establish ABSENCE across ML's whole taxonomy, and
    // the constant moved from a bespoke phrase to generic retail wording, so the
    // population of plausible collisions grew. Checked 2026-09-01 against ML's
    // `atributos` reference and a docs search — no documented attribute uses
    // this name — but the authoritative check is a live authenticated sweep of
    // `GET /categories/{id}/attributes` over the categories this seller lists
    // in, which no lane may run (no ML credentials). Do it before the first
    // deploy: the name freezes then.
    const folded = ML_ATTR_SKU_PAI_NOME.trim().toLowerCase();
    for (const mlName of [
      'Modelo',
      'Modelo Alfanumérico',
      'Código universal de produto',
      'SKU',
      'GTIN',
      'Marca',
      'Cor',
      'Tamanho',
    ]) {
      expect(folded).not.toBe(mlName.trim().toLowerCase());
    }
  });

  it('a name collision would hijack rung 1 AND silence the real attribute', () => {
    // Pins what a collision actually costs, so the guard above is sized against
    // observed behaviour rather than against the docblock's description of it.
    const foreign = {
      id: 'REFERENCE_CODE',
      name: ML_ATTR_SKU_PAI_NOME,
      value_name: 'XYZ-123',
    };
    // 1. Read as the parent sku, despite carrying an id that is not ours.
    expect(skuPaiFromAttributes([foreign])).toBe('XYZ-123');
    // 2. …and excluded from the link doc, so it stops being republished — which
    //    reaches SIMPLE items too, though they never send this characteristic.
    expect(attributesFromItem([foreign])).toEqual([]);
  });
});

describe('ML_PRODUTO_DERIVED_ATTRIBUTE_IDS', () => {
  // The anti-drift anchor. The editor withholds exactly these ids, publish
  // strips exactly these from the write-back and import strips them off the
  // link — three surfaces that used to hold independent literals and DID
  // disagree (`PACKAGE_*` against `SELLER_PACKAGE_*`).
  it('names every id the produto-derived factories emit', () => {
    const emitted = [
      attrSku('SKU-1'),
      attrWeightKg(0.5),
      ...attrPackageDimensions({ alturaCm: 1, larguraCm: 1, profundidadeCm: 1, pesoG: 1 }),
    ].map((a) => a.id!);

    expect([...emitted].sort()).toEqual([...ML_PRODUTO_DERIVED_ATTRIBUTE_IDS].sort());
  });

  // Membership is "the produto owns it", not "a factory emits it". These four
  // come from the grupo de variações and the tabela de medidas, are withheld by
  // their own rules, and `SIZE_GRID_ID` in particular must survive on the link
  // doc — it is where the chart binding lives between publishes.
  it('excludes the variation- and size-chart-owned factories', () => {
    for (const attr of [
      attrSize('M'),
      attrColor('Preto'),
      attrSizeGridId('grid-1'),
      attrSizeGridRowId('row-1'),
    ]) {
      expect(ML_PRODUTO_DERIVED_ATTRIBUTE_IDS).not.toContain(attr.id);
    }
  });

  // The read-only spelling is a DIFFERENT ML attribute (factory packaging data
  // a seller cannot write). Folding the two lists together is the mistake this
  // set exists to prevent.
  it('carries the seller-writable spelling, never the read-only PACKAGE_* one', () => {
    for (const axis of ['HEIGHT', 'LENGTH', 'WIDTH', 'WEIGHT']) {
      expect(ML_PRODUTO_DERIVED_ATTRIBUTE_IDS).toContain(`SELLER_PACKAGE_${axis}`);
      expect(ML_PRODUTO_DERIVED_ATTRIBUTE_IDS).not.toContain(`PACKAGE_${axis}`);
    }
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

  it('carries the parent-sku characteristic to the member, id-less (#1400)', () => {
    // The family attribute list is what `assemblePublishInput` produces, so an
    // id-less entry there is exactly how the parent sku reaches a member.
    const attributes = [...(base.attributes ?? []), attrSkuPai('SKU-PAI')];
    for (const isUpdate of [false, true]) {
      const data = buildUserProductItemPayload({ ...base, attributes, isUpdate });
      const attrs = data.attributes as Array<Record<string, unknown>>;
      const skuPai = attrs.filter((a) => a.name === ML_ATTR_SKU_PAI_NOME);
      // Present on the UPDATE too: its VALUE is not in ML's family hash, so an
      // edited parent sku must be able to propagate.
      expect(skuPai).toHaveLength(1);
      expect(skuPai[0]).toEqual({ name: ML_ATTR_SKU_PAI_NOME, value_name: 'SKU-PAI' });
      // ⚠️ It must NOT carry an id — `SELLER_SKU` is the member's and ML allows
      // one per item. And it must not displace that one.
      expect(skuPai[0]!.id).toBeUndefined();
      expect(attrs.find((a) => a.id === 'SELLER_SKU')?.value_name).toBe('SKU-M');
    }
  });

  it('sends NO parent-sku characteristic when the caller passes none', () => {
    // The default, and the only state that can never split a live família.
    for (const isUpdate of [false, true]) {
      const data = buildUserProductItemPayload({ ...base, isUpdate });
      const attrs = data.attributes as Array<Record<string, unknown>>;
      expect(attrs.some((a) => a.name === ML_ATTR_SKU_PAI_NOME)).toBe(false);
    }
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

/**
 * The `shipping` node. Every ERP-published listing landed on ML as "a combinar"
 * because no builder emitted one at all.
 *
 * ⚠️ All FOUR quadrants are asserted on purpose. The fields around this one
 * (`category_id`, `condition`, `listing_type_id`, `price`) are all create-only,
 * so "create carries it, update drops it" is the shape a reader expects here —
 * and it is exactly wrong: `shipping` rides on the PUT too, which is what makes
 * a republish self-heal a listing already sitting at "a combinar". Testing only
 * the create half would pass against a builder that silently dropped it on
 * update, i.e. against the version that fixes nothing already published.
 */
describe('buildItemPayload / buildUserProductItemPayload — shipping mode', () => {
  const legacyBase = {
    isUpdate: false,
    isUserProductSeller: false,
    title: 'Camiseta Básica',
    condition: 'new' as const,
    sellerCustomField: 'link-doc-1',
    categoryId: 'MLB31447',
    listingTypeId: 'gold_special',
    price: 79.9,
    availableQuantity: 12,
    pictures: [{ id: 'IMG1' }],
    attributes: [attrSku('SKU-1')],
  };
  const upBase = {
    familyName: 'Camiseta Básica',
    condition: 'new' as const,
    categoryId: 'MLB31447',
    listingTypeId: 'gold_special',
    price: 79.9,
    attributes: [attrSku('SKU-PAI')],
    pictures: [{ id: 'PIC-PAI' }],
    member: {
      produtoId: 'child-1',
      availableQuantity: 4,
      attributeCombinations: [attrColor('Azul')],
    },
  };

  it.each([false, true])('legacy builder sends it — isUpdate=%s', (isUpdate) => {
    const data = buildItemPayload({ ...legacyBase, isUpdate, shippingMode: 'me2' });
    expect(data.shipping).toEqual({ mode: 'me2' });
  });

  it.each([false, true])('User-Products builder sends it — isUpdate=%s', (isUpdate) => {
    const data = buildUserProductItemPayload({ ...upBase, isUpdate, shippingMode: 'me2' });
    expect(data.shipping).toEqual({ mode: 'me2' });
  });

  // `not_specified` is a REAL choice, not the absence of one: it forces "a
  // combinar" over an account default that would otherwise have applied.
  it('passes the mode through verbatim, not just me2', () => {
    expect(buildItemPayload({ ...legacyBase, shippingMode: 'me1' }).shipping).toEqual({
      mode: 'me1',
    });
    expect(buildItemPayload({ ...legacyBase, shippingMode: 'not_specified' }).shipping).toEqual({
      mode: 'not_specified',
    });
  });

  // ⚠️ `not.toHaveProperty`, never `toBeUndefined()` — the latter also passes
  // for `{ shipping: undefined }`, and a key present-but-undefined is what
  // reaches ML as an explicit null and overwrites the account default.
  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('emits NO shipping key when the mode is %s', (_label, mode) => {
    expect(buildItemPayload({ ...legacyBase, shippingMode: mode })).not.toHaveProperty('shipping');
    expect(
      buildUserProductItemPayload({ ...upBase, isUpdate: false, shippingMode: mode }),
    ).not.toHaveProperty('shipping');
  });

  it('omitting the field entirely is byte-identical to before it existed', () => {
    expect(buildItemPayload(legacyBase)).not.toHaveProperty('shipping');
    expect(buildUserProductItemPayload({ ...upBase, isUpdate: false })).not.toHaveProperty(
      'shipping',
    );
  });

  // Pinned SEPARATELY from the builder above, because this projection is the
  // only thing that puts a shipping node on a User-Products FAMILY: every member
  // is built from it. Assert on the projection itself so a dropped forward fails
  // here even if the member builder is fine.
  it('userProductMemberInputs forwards the mode to every member', () => {
    const members = userProductMemberInputs({
      ...legacyBase,
      isUserProductSeller: true,
      shippingMode: 'me2',
      variations: [
        { produtoId: 'child-1', availableQuantity: 1, attributeCombinations: [attrColor('Azul')] },
        { produtoId: 'child-2', availableQuantity: 2, attributeCombinations: [attrColor('Verde')] },
      ],
    });
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.shippingMode)).toEqual(['me2', 'me2']);
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

describe('ML_PRODUTO_HERDADO_ATTRIBUTE_IDS', () => {
  it('names exactly what attrBrand emits', () => {
    expect(ML_PRODUTO_HERDADO_ATTRIBUTE_IDS).toEqual([attrBrand('Hering').id]);
  });

  it('emits a bare value_name, inventing no value_id', () => {
    // An enumerated ML brand carries a `value_id` naming ML's own record. This
    // factory cannot know one, which is why publish must never rebuild a STORED
    // BRAND through it — only append one the produto decided.
    expect(attrBrand('Hering')).toEqual({ id: 'BRAND', value_name: 'Hering' });
  });

  // ⚠️ THE point of the split, asserted on the literal so it cannot pass
  // vacuously against an emptied list. The two share only "withhold it from the
  // editor": a DERIVED id's stored copy is a stale duplicate and is pruned
  // everywhere, while a HERDADO id's stored copy is the fallback publish reads
  // when the produto has no Marca. Merging them deletes every brand ever typed.
  it('is disjoint from the derived ids', () => {
    expect(ML_PRODUTO_HERDADO_ATTRIBUTE_IDS).toContain('BRAND');
    expect(ML_PRODUTO_DERIVED_ATTRIBUTE_IDS).not.toContain('BRAND');
    for (const id of ML_PRODUTO_HERDADO_ATTRIBUTE_IDS) {
      expect(ML_PRODUTO_DERIVED_ATTRIBUTE_IDS).not.toContain(id);
    }
  });
});
