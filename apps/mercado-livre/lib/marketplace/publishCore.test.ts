import { describe, expect, it } from 'vitest';
import {
  MercadoLivrePublishError,
  type PublishGrupoVariacao,
  type PublishProduto,
  assemblePublishInput,
  buildParentAttributes,
  combinationsFromVariacoes,
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
});

describe('combinationsFromVariacoes', () => {
  it('maps tamanho→SIZE, cor→COLOR, outros→NOME_DO_GRUPO', () => {
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
    expect(combos).toEqual([
      { id: 'SIZE', value_name: 'M' },
      { id: 'COLOR', value_name: 'Preto' },
      { id: 'ESTAMPA_ESPECIAL', value_name: 'X' },
    ]);
    expect(issues).toEqual([]);
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
    expect(input.variations).toHaveLength(1);
    expect(input.variations![0]).toMatchObject({
      produtoId: 'child-1',
      order: 1,
      availableQuantity: 4,
      attributeCombinations: [{ id: 'SIZE', value_name: 'M' }],
      attributes: [{ id: 'SELLER_SKU', value_name: 'SKU-1-M' }],
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
