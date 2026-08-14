import { describe, expect, it } from 'vitest';
import { buildItemPayload } from '@delfrance/integrations-mercado-livre';
import {
  MercadoLivrePublishError,
  type PublishGrupoVariacao,
  type PublishProduto,
  assemblePublishInput,
  buildParentAttributes,
  combinationsFromVariacoes,
  mergeStoredCombinations,
  resolveCondition,
  resolvePrice,
} from './publishCore';

const produto: PublishProduto = {
  id: 'prod-1',
  nome: 'Camiseta Básica',
  sku: 'SKU-1',
  ehUsado: false,
  pesoLiquidoKg: 0.3,
  pesoBrutoKg: 0.4,
  alturaCm: 5,
  larguraCm: 30,
  profundidadeCm: 40,
  precos: { 'lista-1': { valor: 79.9 } },
};

const grupos: PublishGrupoVariacao[] = [
  {
    grupoId: 'g-tam',
    nome: 'Tamanho',
    tipo: 1,
    variacoes: [
      { id: 'v-m', nome: 'M' },
      { id: 'v-g', nome: 'G' },
    ],
  },
  { grupoId: 'g-cor', nome: 'Cor', tipo: 2, variacoes: [{ id: 'v-preto', nome: 'Preto' }] },
  { grupoId: 'g-out', nome: 'Estampa Especial', tipo: null, variacoes: [{ id: 'v-x', nome: 'X' }] },
];

describe('resolvePrice', () => {
  it('reads the tabela-normal price', () => {
    const issues: string[] = [];
    expect(resolvePrice(produto, 'lista-1', issues)).toBe(79.9);
    expect(issues).toEqual([]);
  });

  it('flags a missing price list and a missing price (no fallbacks)', () => {
    const issues: string[] = [];
    expect(resolvePrice(produto, null, issues)).toBeNull();
    expect(resolvePrice(produto, 'lista-x', issues)).toBeNull();
    expect(issues).toHaveLength(2);
  });
});

describe('resolveCondition', () => {
  it('persisted link condition wins over everything', () => {
    expect(resolveCondition({ docId: 'l', id: 'MLB1', condition: 'used' }, produto, 1)).toBe(
      'used',
    );
  });

  it('ehUsado / condicao 2|3 → used; default new', () => {
    expect(resolveCondition(null, { ...produto, ehUsado: true }, 1)).toBe('used');
    expect(resolveCondition(null, produto, 2)).toBe('used');
    expect(resolveCondition(null, produto, 3)).toBe('used');
    expect(resolveCondition(null, produto, 1)).toBe('new');
    expect(resolveCondition(null, produto, null)).toBe('new');
  });
});

describe('buildParentAttributes', () => {
  it('emits link customs + SELLER_SKU + WEIGHT + package dimensions', () => {
    const attrs = buildParentAttributes(produto, {
      docId: 'l',
      id: null,
      attributes: [{ id: 'BRAND', value_name: 'Acme' }],
    });
    expect(attrs.map((a) => a.id)).toEqual([
      'BRAND',
      'SELLER_SKU',
      'WEIGHT',
      'SELLER_PACKAGE_HEIGHT',
      'SELLER_PACKAGE_LENGTH',
      'SELLER_PACKAGE_WIDTH',
      'SELLER_PACKAGE_WEIGHT',
    ]);
    // gross weight (pesoBrutoKg) feeds the package weight, in grams
    expect(attrs.at(-1)).toEqual({ id: 'SELLER_PACKAGE_WEIGHT', value_name: '400 g' });
  });

  it('omits dimensions when any side is missing', () => {
    const attrs = buildParentAttributes({ ...produto, alturaCm: null }, null);
    expect(attrs.map((a) => a.id)).toEqual(['SELLER_SKU', 'WEIGHT']);
  });

  it('omits SELLER_SKU when the item has variations (#799 bug 3)', () => {
    // Each variation carries its own SELLER_SKU in `attributes`, so it is never
    // a combination id and the mapper's combination prune cannot reach the
    // parent's. The legacy removes it by id (models.dart:1508-1515).
    const attrs = buildParentAttributes({ ...produto, alturaCm: null }, null, null, {
      includeSku: false,
    });
    expect(attrs.map((a) => a.id)).toEqual(['WEIGHT']);
  });
});

describe('combinationsFromVariacoes', () => {
  it('maps tamanho→SIZE, cor→COLOR, and an ERP-only grupo to a CUSTOM characteristic', () => {
    const issues: string[] = [];
    const combos = combinationsFromVariacoes(
      [
        'documents/grupoDeVariacoes/g-tam/variacoes/v-m',
        'documents/grupoDeVariacoes/g-cor/variacoes/v-preto',
        'documents/grupoDeVariacoes/g-out/variacoes/v-x',
      ],
      grupos,
      'Filho',
      issues,
    );
    // #797 E8: `g-out` is a Firestore auto-id, so its group is NOT in ML's
    // taxonomy. ML's shape for that is `name` + `value_name` and NO id — the
    // old port sent `{ id: 'ESTAMPA_ESPECIAL' }`, an id that exists nowhere.
    expect(combos).toEqual([
      { id: 'SIZE', value_name: 'M' },
      { id: 'COLOR', value_name: 'Preto' },
      { name: 'Estampa Especial', value_name: 'X' },
    ]);
    expect(issues).toEqual([]);
  });

  it('uses an ML-derived grupo id verbatim, with the variante value_id (#797 E8)', () => {
    // The taxonomy importer names the grupo doc after the ML attribute
    // (`taxonomiaCore.ts:251`) and the variante after its value_id (`:284`).
    const mlGrupos: PublishGrupoVariacao[] = [
      {
        grupoId: 'FLAVOR',
        nome: 'Sabor',
        tipo: 0,
        variacoes: [{ id: '2450279', nome: 'Baunilha', mlValueId: '2450279' }],
      },
    ];
    const issues: string[] = [];
    expect(
      combinationsFromVariacoes(
        ['documents/grupoDeVariacoes/FLAVOR/variacoes/2450279'],
        mlGrupos,
        'Filho',
        issues,
      ),
    ).toEqual([{ id: 'FLAVOR', value_id: '2450279', value_name: 'Baunilha' }]);
    expect(issues).toEqual([]);
  });

  it('omits value_id when ML never minted one (the link holds a NAME, not an id)', () => {
    // `externalVariacaoLinks[].externalId` is `value_id ?? value_name`, so the
    // IO layer passes null unless it equals the variante id. Sending a name as
    // `value_id` would fabricate a taxonomy reference.
    const mlGrupos: PublishGrupoVariacao[] = [
      {
        grupoId: 'FLAVOR',
        nome: 'Sabor',
        tipo: 0,
        variacoes: [{ id: 'n-baunilha', nome: 'Baunilha', mlValueId: null }],
      },
    ];
    expect(
      combinationsFromVariacoes(
        ['documents/grupoDeVariacoes/FLAVOR/variacoes/n-baunilha'],
        mlGrupos,
        'Filho',
        [],
      ),
    ).toEqual([{ id: 'FLAVOR', value_name: 'Baunilha' }]);
  });

  it('reports unknown paths/variants as issues instead of dropping them', () => {
    const issues: string[] = [];
    combinationsFromVariacoes(
      ['nonsense', 'documents/grupoDeVariacoes/g-tam/variacoes/v-missing'],
      grupos,
      'Filho',
      issues,
    );
    expect(issues).toHaveLength(2);
  });
});

describe('mergeStoredCombinations', () => {
  it('recovers a stored combination no grupo can rebuild (#797 E8)', () => {
    // VOLTAGE was configured in Flutter; the ERP has no grupo for it, so the
    // grupo walk alone would DROP it on the first republish.
    expect(
      mergeStoredCombinations(
        [{ id: 'COLOR', value_name: 'Preto' }],
        [{ id: 'VOLTAGE', value_name: '220V' }],
      ),
    ).toEqual([
      { id: 'COLOR', value_name: 'Preto' },
      { id: 'VOLTAGE', value_name: '220V' },
    ]);
  });

  it('the grupo wins a collision — a duplicated combination id is an ML rejection', () => {
    expect(
      mergeStoredCombinations(
        [{ id: 'COLOR', value_name: 'Preto' }],
        [{ id: 'COLOR', value_name: 'Azul (stale)' }],
      ),
    ).toEqual([{ id: 'COLOR', value_name: 'Preto' }]);
  });

  it('keys an id-less entry by name, and drops a valueless one', () => {
    expect(
      mergeStoredCombinations(
        [{ name: 'Sabor', value_name: 'Baunilha' }],
        [{ name: 'Sabor', value_name: 'Menta' }, { id: 'VOLTAGE' }],
      ),
    ).toEqual([{ name: 'Sabor', value_name: 'Baunilha' }]);
  });

  it('is a no-op without stored entries', () => {
    const derived = [{ id: 'SIZE', value_name: 'M' }];
    expect(mergeStoredCombinations(derived, undefined)).toBe(derived);
    expect(mergeStoredCombinations(derived, [])).toBe(derived);
  });
});

describe('assemblePublishInput', () => {
  const baseArgs = {
    produto,
    condicao: 1,
    priceListId: 'lista-1',
    availableQuantity: 10,
    pictures: [{ id: 'IMG1' }],
    variations: [],
    grupos,
    link: null,
    linkDocId: 'link-doc-1',
    categoryId: 'MLB31447',
    listingTypeId: 'gold_special',
    isUserProductSeller: false,
  };

  it('assembles a create input with variations end-to-end', () => {
    const input = assemblePublishInput({
      ...baseArgs,
      variations: [
        {
          produto: { ...produto, id: 'child-1', nome: 'Camiseta M', sku: 'SKU-1-M', ordem: 1 },
          variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
          availableQuantity: 4,
          mlVariationId: null,
        },
      ],
    });
    expect(input.isUpdate).toBe(false);
    expect(input.title).toBe('Camiseta Básica');
    expect(input.sellerCustomField).toBe('link-doc-1');
    expect(input.price).toBe(79.9);
    // The price is passed through here — buildItemPayload decides whether it
    // reaches the wire (create-only, and never alongside variations).
    // #799 bug 3: with variations the parent must NOT carry SELLER_SKU; each
    // variation has its own below.
    expect(input.attributes!.map((a) => a.id)).toEqual([
      'WEIGHT',
      'SELLER_PACKAGE_HEIGHT',
      'SELLER_PACKAGE_LENGTH',
      'SELLER_PACKAGE_WIDTH',
      'SELLER_PACKAGE_WEIGHT',
    ]);
    expect(input.variations).toHaveLength(1);
    expect(input.variations![0]).toMatchObject({
      produtoId: 'child-1',
      order: 1,
      availableQuantity: 4,
      attributeCombinations: [{ id: 'SIZE', value_name: 'M' }],
      attributes: [{ id: 'SELLER_SKU', value_name: 'SKU-1-M' }],
    });
  });

  it('merges the stored combinations of the child link doc (#797 E8)', () => {
    const input = assemblePublishInput({
      ...baseArgs,
      variations: [
        {
          produto: { ...produto, id: 'child-1', nome: 'Camiseta M' },
          variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
          availableQuantity: 4,
          mlVariationId: 991,
          storedCombinations: [{ id: 'VOLTAGE', value_name: '220V' }],
        },
      ],
    });
    expect(input.variations![0]!.attributeCombinations).toEqual([
      { id: 'SIZE', value_name: 'M' },
      { id: 'VOLTAGE', value_name: '220V' },
    ]);
  });

  it('blocks a child varying by TWO custom characteristics — ML allows one', () => {
    const doisCustoms: PublishGrupoVariacao[] = [
      { grupoId: 'g-a', nome: 'Sabor', tipo: 0, variacoes: [{ id: 'v-a', nome: 'Menta' }] },
      { grupoId: 'g-b', nome: 'Estampa', tipo: 0, variacoes: [{ id: 'v-b', nome: 'Onça' }] },
    ];
    expect(() =>
      assemblePublishInput({
        ...baseArgs,
        grupos: doisCustoms,
        variations: [
          {
            produto: { ...produto, id: 'child-1', nome: 'Camiseta X' },
            variacoesUid: [
              'documents/grupoDeVariacoes/g-a/variacoes/v-a',
              'documents/grupoDeVariacoes/g-b/variacoes/v-b',
            ],
            availableQuantity: 4,
            mlVariationId: null,
          },
        ],
      }),
    ).toThrow(/apenas UMA característica personalizada/);
  });

  it('a null variation quantity survives assembly (virtual kit — #797 E5)', () => {
    const input = assemblePublishInput({
      ...baseArgs,
      availableQuantity: null,
      variations: [
        {
          produto: { ...produto, id: 'child-1', nome: 'Kit M' },
          variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
          availableQuantity: null,
          mlVariationId: null,
        },
      ],
    });
    expect(input.availableQuantity).toBeNull();
    expect(input.variations![0]!.availableQuantity).toBeNull();
  });

  it('keeps the parent SELLER_SKU for a User-Products seller even with children', () => {
    // buildItemPayload drops the variations array entirely for a UP seller, so
    // no per-variation SKU is ever emitted. Suppressing the parent's on child
    // count alone would ship a payload with NO SKU anywhere.
    const input = assemblePublishInput({
      ...baseArgs,
      isUserProductSeller: true,
      variations: [
        {
          produto: { ...produto, id: 'child-1', nome: 'Camiseta M', sku: 'SKU-1-M', ordem: 1 },
          variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
          availableQuantity: 4,
          mlVariationId: null,
        },
      ],
    });
    expect(input.attributes!.map((a) => a.id)).toContain('SELLER_SKU');

    const data = buildItemPayload(input);
    expect(data.variations).toBeUndefined();
    expect((data.attributes as Array<{ id: string }>).map((a) => a.id)).toContain('SELLER_SKU');
  });

  it('binds the size chart: SIZE_GRID_ID on the parent, SIZE_GRID_ROW_ID + SIZE replacement per variation', () => {
    const input = assemblePublishInput({
      ...baseArgs,
      // A stale binding on the link doc must be REPLACED by the fresh chart.
      link: {
        docId: 'link-doc-1',
        id: null,
        attributes: [
          { id: 'SIZE_GRID_ID', value_name: 'STALE' },
          { id: 'BRAND', value_name: 'Acme' },
        ],
      },
      variations: [
        {
          produto: { ...produto, id: 'child-1', nome: 'Camiseta M', sku: 'SKU-1-M' },
          variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
          availableQuantity: 4,
          mlVariationId: null,
        },
        {
          produto: { ...produto, id: 'child-2', nome: 'Camiseta G', sku: 'SKU-1-G' },
          variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-g'],
          availableQuantity: 2,
          mlVariationId: null,
        },
      ],
      sizeChart: {
        chartId: '1594439',
        rowByChildId: {
          'child-1': { rowId: '1594439:1', size: { id: 'SIZE', value_name: 'M (38-40)' } },
          // child-2 unmatched — keeps its own variante nome, no ROW_ID.
        },
      },
    });

    const parentIds = input.attributes!.map((a) => a.id);
    expect(parentIds.filter((id) => id === 'SIZE_GRID_ID')).toHaveLength(1);
    expect(input.attributes!.find((a) => a.id === 'SIZE_GRID_ID')).toEqual({
      id: 'SIZE_GRID_ID',
      value_name: '1594439',
    });
    expect(input.attributes!.find((a) => a.id === 'BRAND')).toBeDefined();

    // Matched child: ROW_ID in attributes, chart SIZE replaces the combo.
    expect(input.variations![0]!.attributes).toContainEqual({
      id: 'SIZE_GRID_ROW_ID',
      value_name: '1594439:1',
    });
    expect(input.variations![0]!.attributeCombinations).toEqual([
      { id: 'SIZE', value_name: 'M (38-40)' },
    ]);
    // Unmatched child: untouched.
    expect(input.variations![1]!.attributes).toEqual([{ id: 'SELLER_SKU', value_name: 'SKU-1-G' }]);
    expect(input.variations![1]!.attributeCombinations).toEqual([{ id: 'SIZE', value_name: 'G' }]);
  });

  it('chart SIZE replacement drops EVERY SIZE combo (two tamanho groups → one SIZE)', () => {
    const doisTamanhos: PublishGrupoVariacao[] = [
      ...grupos,
      { grupoId: 'g-tam2', nome: 'Tamanho BR', tipo: 1, variacoes: [{ id: 'v-40', nome: '40' }] },
    ];
    const input = assemblePublishInput({
      ...baseArgs,
      grupos: doisTamanhos,
      variations: [
        {
          produto: { ...produto, id: 'child-1', nome: 'Camiseta M', sku: 'SKU-1-M' },
          variacoesUid: [
            'documents/grupoDeVariacoes/g-tam/variacoes/v-m',
            'documents/grupoDeVariacoes/g-tam2/variacoes/v-40',
          ],
          availableQuantity: 4,
          mlVariationId: null,
        },
      ],
      sizeChart: {
        chartId: '1594439',
        rowByChildId: {
          'child-1': { rowId: '1594439:1', size: { id: 'SIZE', value_name: 'M (38-40)' } },
        },
      },
    });
    const sizes = input.variations![0]!.attributeCombinations.filter((c) => c.id === 'SIZE');
    expect(sizes).toEqual([{ id: 'SIZE', value_name: 'M (38-40)' }]);
  });

  it('no size chart → link attributes untouched (a persisted SIZE_GRID_ID survives)', () => {
    const input = assemblePublishInput({
      ...baseArgs,
      link: {
        docId: 'link-doc-1',
        id: null,
        attributes: [{ id: 'SIZE_GRID_ID', value_name: 'KEEP-ME' }],
      },
    });
    expect(input.attributes!.find((a) => a.id === 'SIZE_GRID_ID')).toEqual({
      id: 'SIZE_GRID_ID',
      value_name: 'KEEP-ME',
    });
  });

  it('update mode (link has an ML id) does not require category/listing type', () => {
    const input = assemblePublishInput({
      ...baseArgs,
      categoryId: null,
      listingTypeId: null,
      link: { docId: 'link-doc-1', id: 'MLB999', condition: 'new' },
    });
    expect(input.isUpdate).toBe(true);
  });

  it('aggregates EVERY blocking issue into one error', () => {
    const bad = () =>
      assemblePublishInput({
        ...baseArgs,
        produto: { ...produto, nome: '  ', precos: null },
        pictures: [],
        categoryId: null,
        listingTypeId: null,
      });
    expect(bad).toThrowError(MercadoLivrePublishError);
    try {
      bad();
    } catch (err) {
      if (!(err instanceof MercadoLivrePublishError)) throw err;
      // nome + preço + categoria + listing type + fotos
      expect(err.issues).toHaveLength(5);
    }
  });

  it('a variation with no resolvable combination blocks the publish', () => {
    expect(() =>
      assemblePublishInput({
        ...baseArgs,
        variations: [
          {
            produto: { ...produto, id: 'child-2', nome: 'Filho' },
            variacoesUid: [],
            availableQuantity: 1,
            mlVariationId: null,
          },
        ],
      }),
    ).toThrowError(/sem atributos de combinação/);
  });
});
