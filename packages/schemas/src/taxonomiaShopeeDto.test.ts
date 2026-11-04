import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';

import * as barrel from './index';
import {
  type AtributoDto,
  type AtributoValorDto,
  type RespostaLimitesTabelaMedidasShopee,
  atributoDtoSchema,
  atributoInfoDtoSchema,
  atributoValorDtoSchema,
  categoriaNoDtoSchema,
  categoriaResumoDtoSchema,
  faixaDtoSchema,
  gtinLimitDtoSchema,
  limitesDeItemDtoSchema,
  limitesDeKitDtoSchema,
  limitesDescricaoEstendidaDtoSchema,
  marcaDtoSchema,
  recomendacaoDtoSchema,
  respostaAtributosShopeeSchema,
  respostaCategoriasShopeeSchema,
  respostaLimitesDoItemShopeeSchema,
  respostaLimitesTabelaMedidasShopeeSchema,
  respostaMarcasShopeeSchema,
  respostaRecomendacaoCategoriaShopeeSchema,
  respostaVariacoesShopeeSchema,
  variacaoDtoSchema,
  variacaoGrupoDtoSchema,
  variacaoOpcaoDtoSchema,
} from './taxonomiaShopeeDto';

/**
 * The Shopee TAXONOMY route envelopes (#1911, P2), declared once for
 * `apps/shopee` (which builds them) and `apps/web` (which parses them). What is
 * pinned here is the CONTRACT both sides share: every key required, every
 * number strict (our own answers), every unknown key stripped (the two apps
 * deploy separately), and the `/medidas` limits slice DERIVED from the whole
 * answer.
 *
 * ⚠️ Every "accepts X" below is worthless alone — `z.any()` passes it. The
 * controls are the WALKERS: for each complete answer, every number/boolean leaf
 * quoted ONE AT A TIME must be refused, and every key dropped ONE AT A TIME
 * must be refused. They reach the deepest row (an attribute under a value under
 * an attribute), so a tolerant reader or an optional key ANYWHERE fails here.
 */

/* -------------------------------------------------------------------------- */
/*                                  Fixtures                                  */
/* -------------------------------------------------------------------------- */

// Shopee's doc-sample category ids — published samples, never a real shop's tree.
const RAIZ = {
  categoryId: 100017,
  name: 'Moda Feminina',
  originalName: 'Women Clothes',
  isLeaf: false,
};
const FOLHA = { categoryId: 100087, name: 'Camisetas', originalName: 'Tops', isLeaf: true };
const NO = { ...RAIZ, parentId: 0, pathFromRoot: [RAIZ], children: [FOLHA] };

const RESPOSTA_RAIZES = { raizes: [RAIZ], no: null };
const RESPOSTA_NO = { raizes: null, no: NO };

const INFO = {
  inputType: 2,
  inputValidationType: 1,
  formatType: 2,
  dateFormatType: 1,
  attributeUnitList: ['cm', 'g'],
  maxValueCount: 3,
  introduction: 'Material principal',
  isOem: false,
  supportSearchValue: true,
};

/** A child attribute UNDER a chosen value — the walkers must reach it. */
const ATRIBUTO_FILHO: AtributoDto = {
  attributeId: 100200,
  mandatory: false,
  name: 'Gramatura',
  attributeInfo: INFO,
  attributeValueList: [{ valueId: 0, name: null, valueUnit: 'g', childAttributeList: [] }],
};

const RESPOSTA_ATRIBUTOS = {
  leaf: true,
  categoryId: 100087,
  warning: null,
  truncated: false,
  atributos: [
    {
      attributeId: 100134,
      mandatory: true,
      name: 'Material',
      attributeInfo: INFO,
      attributeValueList: [
        { valueId: 1, name: 'Algodão', valueUnit: null, childAttributeList: [ATRIBUTO_FILHO] },
      ],
    },
    {
      attributeId: 100135,
      mandatory: false,
      name: null,
      attributeInfo: null,
      attributeValueList: [],
    },
  ],
};

const DESCRICAO_ESTENDIDA = {
  descriptionTextLengthMin: 20,
  descriptionTextLengthMax: 5000,
  descriptionImageNumMin: 0,
  descriptionImageNumMax: 12,
  descriptionImageWidthMin: 300,
  descriptionImageHeightMin: 300,
  descriptionImageAspectRatioMin: 0.5,
  descriptionImageAspectRatioMax: 32,
};

const SIZE_CHART_LIMIT = {
  sizeChartMandatory: true,
  supportImageSizeChart: false,
  supportTemplateSizeChart: true,
};

/** Every band PRESENT, so the walkers reach every number. */
const LIMITES_DE_ITEM = {
  priceLimit: { min: 0.5, max: 100_000 },
  wholesalePriceThresholdPercentage: { min: 1, max: 90 },
  stockLimit: { min: 0, max: 999_999 },
  itemNameLengthLimit: { min: 1, max: 120 },
  itemImageCountLimit: { min: 1, max: 9 },
  itemDescriptionLengthLimit: { min: 20, max: 3000 },
  tierVariationNameLengthLimit: { min: 1, max: 14 },
  tierVariationOptionLengthLimit: { min: 1, max: 30 },
  itemCountLimit: { min: 0, max: 5000 },
  extendedDescriptionLimit: DESCRICAO_ESTENDIDA,
  dtsLimit: { daysToShipLimit: { min: 7, max: 30 }, nonPreOrderDaysToShip: 2 },
  weightLimit: { weightMandatory: true },
  dimensionLimit: { dimensionMandatory: false },
  sizeChartLimit: SIZE_CHART_LIMIT,
};

const RESPOSTA_LIMITES = {
  scope: 'category',
  categoryId: 100087,
  limites: LIMITES_DE_ITEM,
  gtinLimit: { gtinValidationRule: 'Optional' },
  supportsPreOrder: true,
};

const LIMITES_DE_KIT = {
  priceLimit: { min: 0.5, max: 100_000 },
  itemNameLengthLimit: { min: 1, max: 120 },
  itemImageCountLimit: { min: 1, max: 9 },
  descriptionLimit: {
    ...DESCRICAO_ESTENDIDA,
    descriptionLengthMin: 20,
    descriptionLengthMax: 3000,
  },
  tierVariationNameLengthLimit: { min: 1, max: 14 },
  tierVariationOptionLengthLimit: { min: 1, max: 30 },
  weightLimit: { weightMandatory: true },
  dimensionLimit: { dimensionMandatory: true },
  dtsLimit: {
    nonPreOrderDaysToShip: 2,
    supportPreOrder: false,
    daysToShipLimit: { min: -1, max: -1 },
  },
  componentCountLimitOfSingleModel: { min: 2, max: 10 },
};

const RESPOSTA_MARCAS = {
  leaf: true,
  categoryId: 100087,
  status: 1,
  offset: 0,
  pageSize: 100,
  marcas: [
    { brandId: 0, originalBrandName: 'No Brand', displayBrandName: null },
    { brandId: 3001, originalBrandName: 'Marca Exemplo', displayBrandName: 'Marca Exemplo' },
  ],
  hasNextPage: true,
  nextOffset: 100,
  isMandatory: false,
  inputType: 'DROP_DOWN',
};

const RESPOSTA_VARIACOES = {
  leaf: true,
  categoryId: 100087,
  standardiseVariationList: [
    {
      variationId: 1,
      variationName: 'Cor',
      variationGroupList: [
        {
          variationGroupId: 10,
          variationGroupName: 'Básicas',
          variationOptionList: [
            { variationOptionId: 101, variationOptionName: 'Preto' },
            { variationOptionId: 0, variationOptionName: null },
          ],
        },
      ],
    },
  ],
  pathUsed: '/api/v2/product/get_variations',
};

const RESPOSTA_RECOMENDACAO = {
  recomendacoes: [
    {
      position: 1,
      categoryId: 100087,
      name: 'Camisetas',
      isLeaf: true,
      pathFromRoot: [RAIZ, FOLHA],
    },
    { position: 2, categoryId: 999_999, name: null, isLeaf: null, pathFromRoot: [] },
  ],
  unresolved: 1,
  applied: false,
};

/* -------------------------------------------------------------------------- */
/*                                   Walkers                                  */
/* -------------------------------------------------------------------------- */

type Caminho = readonly (string | number)[];
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function clonar<T>(v: T): Json {
  return JSON.parse(JSON.stringify(v)) as Json;
}

/** Every number/boolean leaf, and every key of every object, with its path. */
function percorrer(v: unknown, caminho: Caminho = []): { folhas: Caminho[]; chaves: Caminho[] } {
  const folhas: Caminho[] = [];
  const chaves: Caminho[] = [];
  if (typeof v === 'number' || typeof v === 'boolean') folhas.push(caminho);
  else if (Array.isArray(v)) {
    v.forEach((item, i) => {
      const r = percorrer(item, [...caminho, i]);
      folhas.push(...r.folhas);
      chaves.push(...r.chaves);
    });
  } else if (v !== null && typeof v === 'object') {
    for (const [k, filho] of Object.entries(v)) {
      chaves.push([...caminho, k]);
      const r = percorrer(filho, [...caminho, k]);
      folhas.push(...r.folhas);
      chaves.push(...r.chaves);
    }
  }
  return { folhas, chaves };
}

function pai(raiz: Json, caminho: Caminho): Record<string | number, Json> {
  let atual: Json = raiz;
  for (const passo of caminho.slice(0, -1)) {
    atual = (atual as Record<string | number, Json>)[passo] as Json;
  }
  return atual as Record<string | number, Json>;
}

/** The value at `caminho` QUOTED — `1` → `'1'`, `true` → `'true'`. */
function comFolhaEntreAspas(raiz: unknown, caminho: Caminho): Json {
  const copia = clonar(raiz);
  const ultimo = caminho[caminho.length - 1] as string | number;
  const alvo = pai(copia, caminho);
  alvo[ultimo] = String(alvo[ultimo]);
  return copia;
}

function semChave(raiz: unknown, caminho: Caminho): Json {
  const copia = clonar(raiz);
  const ultimo = caminho[caminho.length - 1] as string;
  delete pai(copia, caminho)[ultimo];
  return copia;
}

/** The same answer with an unknown key added to EVERY object in it. */
function comChaveNovaEmTudo(v: unknown): Json {
  if (Array.isArray(v)) return v.map(comChaveNovaEmTudo);
  if (v !== null && typeof v === 'object') {
    const saida: Record<string, Json> = { chaveDeUmaRotaMaisNova: 'x' };
    for (const [k, filho] of Object.entries(v)) saida[k] = comChaveNovaEmTudo(filho);
    return saida;
  }
  return v as Json;
}

const nome = (c: Caminho): string => c.join('.');

/** Each complete answer and the schema that owns it — the walkers run over all of them. */
const COMPLETAS: readonly (readonly [string, z.ZodType, unknown])[] = [
  ['categorias (raízes)', respostaCategoriasShopeeSchema, RESPOSTA_RAIZES],
  ['categorias (nó)', respostaCategoriasShopeeSchema, RESPOSTA_NO],
  ['atributos', respostaAtributosShopeeSchema, RESPOSTA_ATRIBUTOS],
  ['limites (inteira)', respostaLimitesDoItemShopeeSchema, RESPOSTA_LIMITES],
  ['limites de kit (DTO)', limitesDeKitDtoSchema, LIMITES_DE_KIT],
  ['marcas', respostaMarcasShopeeSchema, RESPOSTA_MARCAS],
  ['variações', respostaVariacoesShopeeSchema, RESPOSTA_VARIACOES],
  ['recomendação de categoria', respostaRecomendacaoCategoriaShopeeSchema, RESPOSTA_RECOMENDACAO],
];

/* -------------------------------------------------------------------------- */
/*                                    Tests                                   */
/* -------------------------------------------------------------------------- */

describe('the barrel exposes THESE instances — one declaration, no copy', () => {
  it('index.ts re-exports the same schema objects', () => {
    const pares: [unknown, unknown][] = [
      [barrel.categoriaResumoDtoSchema, categoriaResumoDtoSchema],
      [barrel.categoriaNoDtoSchema, categoriaNoDtoSchema],
      [barrel.respostaCategoriasShopeeSchema, respostaCategoriasShopeeSchema],
      [barrel.atributoInfoDtoSchema, atributoInfoDtoSchema],
      [barrel.atributoValorDtoSchema, atributoValorDtoSchema],
      [barrel.atributoDtoSchema, atributoDtoSchema],
      [barrel.respostaAtributosShopeeSchema, respostaAtributosShopeeSchema],
      [barrel.faixaDtoSchema, faixaDtoSchema],
      [barrel.gtinLimitDtoSchema, gtinLimitDtoSchema],
      [barrel.limitesDescricaoEstendidaDtoSchema, limitesDescricaoEstendidaDtoSchema],
      [barrel.limitesDeItemDtoSchema, limitesDeItemDtoSchema],
      [barrel.limitesDeKitDtoSchema, limitesDeKitDtoSchema],
      [barrel.respostaLimitesDoItemShopeeSchema, respostaLimitesDoItemShopeeSchema],
      [barrel.respostaLimitesTabelaMedidasShopeeSchema, respostaLimitesTabelaMedidasShopeeSchema],
      [barrel.marcaDtoSchema, marcaDtoSchema],
      [barrel.respostaMarcasShopeeSchema, respostaMarcasShopeeSchema],
      [barrel.variacaoOpcaoDtoSchema, variacaoOpcaoDtoSchema],
      [barrel.variacaoGrupoDtoSchema, variacaoGrupoDtoSchema],
      [barrel.variacaoDtoSchema, variacaoDtoSchema],
      [barrel.respostaVariacoesShopeeSchema, respostaVariacoesShopeeSchema],
      [barrel.recomendacaoDtoSchema, recomendacaoDtoSchema],
      [barrel.respostaRecomendacaoCategoriaShopeeSchema, respostaRecomendacaoCategoriaShopeeSchema],
    ];
    for (const [doBarril, doModulo] of pares) {
      expect(doModulo).toBeDefined();
      expect(doBarril).toBe(doModulo);
    }
  });
});

describe.each(COMPLETAS)(
  '%s — the walkers (every leaf strict, every key required)',
  (_, schema, corpo) => {
    const { folhas, chaves } = percorrer(corpo);

    it('the complete answer parses back EQUAL', () => {
      expect(schema.parse(clonar(corpo))).toStrictEqual(corpo);
    });

    it('an unknown key added to EVERY object is STRIPPED — never a failure (deploy skew)', () => {
      expect(schema.parse(comChaveNovaEmTudo(corpo))).toStrictEqual(corpo);
    });

    it.each(folhas.map((c) => [nome(c), c] as const))(
      'NEAR-MISS: `%s` quoted is OUR serialisation bug — refused, never folded',
      (_n, caminho) => {
        expect(schema.safeParse(comFolhaEntreAspas(corpo, caminho)).success).toBe(false);
      },
    );

    it.each(chaves.map((c) => [nome(c), c] as const))(
      'NEAR-MISS: without `%s` the answer is refused (every key required)',
      (_n, caminho) => {
        expect(schema.safeParse(semChave(corpo, caminho)).success).toBe(false);
      },
    );
  },
);

describe('the walkers are not vacuous', () => {
  it('they reach the deepest attribute and every band', () => {
    const atributos = percorrer(RESPOSTA_ATRIBUTOS);
    expect(atributos.folhas.map(nome)).toContain(
      'atributos.0.attributeValueList.0.childAttributeList.0.attributeValueList.0.valueId',
    );
    expect(atributos.chaves.map(nome)).toContain(
      'atributos.0.attributeValueList.0.childAttributeList.0.attributeInfo.supportSearchValue',
    );
    const limites = percorrer(RESPOSTA_LIMITES);
    for (const banda of Object.keys(LIMITES_DE_ITEM)) {
      expect(limites.chaves.map(nome)).toContain(`limites.${banda}`);
    }
    expect(limites.folhas.map(nome)).toContain(
      'limites.extendedDescriptionLimit.descriptionImageAspectRatioMax',
    );
  });
});

describe('respostaCategoriasShopeeSchema — roots XOR one node', () => {
  it('the exact keys', () => {
    expect(Object.keys(categoriaResumoDtoSchema.shape).sort()).toEqual(
      ['categoryId', 'isLeaf', 'name', 'originalName'].sort(),
    );
    expect(Object.keys(categoriaNoDtoSchema.shape).sort()).toEqual(
      [
        'categoryId',
        'children',
        'isLeaf',
        'name',
        'originalName',
        'parentId',
        'pathFromRoot',
      ].sort(),
    );
  });

  it('NEAR-MISS: a body with NEITHER half is refused (the refine) — an empty root list is still an answer', () => {
    const r = respostaCategoriasShopeeSchema.safeParse({ raizes: null, no: null });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['no']);
    expect(respostaCategoriasShopeeSchema.safeParse({ raizes: [], no: null }).success).toBe(true);
  });

  it('`parentId: 0` (a root) is a value, never an absence', () => {
    expect(respostaCategoriasShopeeSchema.parse(RESPOSTA_NO).no?.parentId).toBe(0);
  });
});

describe('respostaAtributosShopeeSchema — the leaf-gated tree', () => {
  it('the exact envelope keys', () => {
    expect(Object.keys(respostaAtributosShopeeSchema.shape).sort()).toEqual(
      ['atributos', 'categoryId', 'leaf', 'truncated', 'warning'].sort(),
    );
  });

  it('the non-leaf answer (empty, warning null, not truncated) parses', () => {
    const naoFolha = {
      leaf: false,
      categoryId: 100017,
      warning: null,
      truncated: false,
      atributos: [],
    };
    expect(respostaAtributosShopeeSchema.parse(naoFolha)).toStrictEqual(naoFolha);
  });

  it('`valueId: 0` (a legal value id) survives', () => {
    const r = respostaAtributosShopeeSchema.parse(RESPOSTA_ATRIBUTOS);
    expect(
      r.atributos[0]?.attributeValueList[0]?.childAttributeList[0]?.attributeValueList[0]?.valueId,
    ).toBe(0);
  });

  it('the tree is typed on INPUT too — a route’s `satisfies z.input<…>` reaches the deepest row', () => {
    type Entrada = z.input<typeof respostaAtributosShopeeSchema>;
    expectTypeOf<Entrada['atributos'][number]>().toEqualTypeOf<AtributoDto>();
    expectTypeOf<z.input<typeof atributoValorDtoSchema>>().toEqualTypeOf<AtributoValorDto>();
    expect(RESPOSTA_ATRIBUTOS satisfies Entrada).toBeDefined();
  });
});

describe('respostaLimitesDoItemShopeeSchema — the WHOLE limits answer', () => {
  it('the exact envelope keys, and every band of `get_item_limit`', () => {
    expect(Object.keys(respostaLimitesDoItemShopeeSchema.shape).sort()).toEqual(
      ['categoryId', 'gtinLimit', 'limites', 'scope', 'supportsPreOrder'].sort(),
    );
    expect(Object.keys(limitesDeItemDtoSchema.shape).sort()).toEqual(
      Object.keys(LIMITES_DE_ITEM).sort(),
    );
  });

  it('a shop-wide answer (`categoryId: null`), every band null, no GTIN rule — parses', () => {
    const nulas = Object.fromEntries(Object.keys(LIMITES_DE_ITEM).map((k) => [k, null]));
    const corpo = {
      scope: 'shop',
      categoryId: null,
      limites: nulas,
      gtinLimit: null,
      supportsPreOrder: false,
    };
    expect(respostaLimitesDoItemShopeeSchema.parse(corpo)).toStrictEqual(corpo);
  });

  it('a band is NOT an integer, and `-1` ("no pre-sale") travels intact — never clamped', () => {
    const corpo = {
      ...RESPOSTA_LIMITES,
      limites: {
        ...LIMITES_DE_ITEM,
        priceLimit: { min: 0.5, max: null },
        dtsLimit: { daysToShipLimit: { min: -1, max: -1 }, nonPreOrderDaysToShip: 3 },
      },
    };
    const r = respostaLimitesDoItemShopeeSchema.parse(corpo);
    expect(r.limites.priceLimit).toStrictEqual({ min: 0.5, max: null });
    expect(r.limites.dtsLimit?.daysToShipLimit).toStrictEqual({ min: -1, max: -1 });
  });

  it('NEAR-MISS: a fractional categoryId is refused (an id is an integer; a band is not)', () => {
    expect(
      respostaLimitesDoItemShopeeSchema.safeParse({ ...RESPOSTA_LIMITES, categoryId: 1.5 }).success,
    ).toBe(false);
  });

  it('NEAR-MISS: the malformed `priceLimit: "quebrado"` is REFUSED by the whole answer (the slice’s twin)', () => {
    const corpo = { ...RESPOSTA_LIMITES, limites: { ...LIMITES_DE_ITEM, priceLimit: 'quebrado' } };
    expect(respostaLimitesDoItemShopeeSchema.safeParse(corpo).success).toBe(false);
  });
});

describe('respostaLimitesTabelaMedidasShopeeSchema — the `/medidas` slice, DERIVED', () => {
  it('is built from the whole answer’s OWN members (`.pick` / `.extend`) — never a hand copy', () => {
    const fatia = respostaLimitesTabelaMedidasShopeeSchema.shape;
    expect(Object.keys(fatia).sort()).toEqual(['categoryId', 'limites', 'scope']);
    expect(fatia.scope).toBe(respostaLimitesDoItemShopeeSchema.shape.scope);
    expect(fatia.categoryId).toBe(respostaLimitesDoItemShopeeSchema.shape.categoryId);
    expect(Object.keys(fatia.limites.shape)).toEqual(['sizeChartLimit']);
    expect(fatia.limites.shape.sizeChartLimit).toBe(limitesDeItemDtoSchema.shape.sizeChartLimit);
  });

  it('its TYPE is exactly the slice `apps/web` declared before the move (P8 re-exports it under that name)', () => {
    expectTypeOf<RespostaLimitesTabelaMedidasShopee>().toEqualTypeOf<{
      scope: string;
      categoryId: number | null;
      limites: {
        sizeChartLimit: {
          sizeChartMandatory: boolean | null;
          supportImageSizeChart: boolean | null;
          supportTemplateSizeChart: boolean | null;
        } | null;
      };
    }>();
    expectTypeOf<z.input<typeof respostaLimitesTabelaMedidasShopeeSchema>>().toEqualTypeOf<
      z.output<typeof respostaLimitesTabelaMedidasShopeeSchema>
    >();
  });

  it('keeps the size-chart flags — three-valued — and STRIPS every other band, gtinLimit and supportsPreOrder', () => {
    expect(respostaLimitesTabelaMedidasShopeeSchema.parse(RESPOSTA_LIMITES)).toStrictEqual({
      scope: 'category',
      categoryId: 100087,
      limites: { sizeChartLimit: SIZE_CHART_LIMIT },
    });
  });

  it('a band this slice never reads cannot cost the screen — the malformed `priceLimit: "quebrado"` PARSES', () => {
    const corpo = { ...RESPOSTA_LIMITES, limites: { ...LIMITES_DE_ITEM, priceLimit: 'quebrado' } };
    expect(respostaLimitesTabelaMedidasShopeeSchema.safeParse(corpo).success).toBe(true);
  });

  it('`sizeChartLimit: null` (Shopee sent none) parses; a shop-wide answer has `categoryId: null`', () => {
    const r = respostaLimitesTabelaMedidasShopeeSchema.parse({
      scope: 'shop',
      categoryId: null,
      limites: { sizeChartLimit: null },
    });
    expect(r.limites.sizeChartLimit).toBeNull();
    expect(r.categoryId).toBeNull();
  });

  it.each<[string, unknown]>([
    ['a missing sizeChartLimit', { scope: 'category', categoryId: 1, limites: {} }],
    [
      'a quoted boolean',
      {
        scope: 'category',
        categoryId: 1,
        limites: {
          sizeChartLimit: {
            sizeChartMandatory: 'true',
            supportImageSizeChart: null,
            supportTemplateSizeChart: null,
          },
        },
      },
    ],
    [
      'a quoted categoryId',
      { scope: 'category', categoryId: '1', limites: { sizeChartLimit: null } },
    ],
    ['no scope', { categoryId: 1, limites: { sizeChartLimit: null } }],
  ])('NEAR-MISS: %s is refused', (_n, corpo) => {
    expect(respostaLimitesTabelaMedidasShopeeSchema.safeParse(corpo).success).toBe(false);
  });
});

describe('limitesDeKitDtoSchema — its own page, never the item bands', () => {
  it('declares `descriptionLimit` (with its two extra fields) and Shopee’s own `supportPreOrder`', () => {
    expect(Object.keys(limitesDeKitDtoSchema.shape)).toContain('descriptionLimit');
    expect(Object.keys(limitesDeKitDtoSchema.shape)).not.toContain('extendedDescriptionLimit');
    expect(limitesDeKitDtoSchema.parse(LIMITES_DE_KIT).dtsLimit?.supportPreOrder).toBe(false);
  });
});

describe('respostaMarcasShopeeSchema — one page of brands, plus `leaf`', () => {
  it('the exact ten keys', () => {
    expect(Object.keys(respostaMarcasShopeeSchema.shape).sort()).toEqual(
      [
        'categoryId',
        'hasNextPage',
        'inputType',
        'isMandatory',
        'leaf',
        'marcas',
        'nextOffset',
        'offset',
        'pageSize',
        'status',
      ].sort(),
    );
  });

  it('`brandId: 0` ("No Brand") survives; the empty non-leaf page parses', () => {
    expect(respostaMarcasShopeeSchema.parse(RESPOSTA_MARCAS).marcas[0]?.brandId).toBe(0);
    const vazia = {
      leaf: false,
      categoryId: 100017,
      status: 1,
      offset: 0,
      pageSize: 100,
      marcas: [],
      hasNextPage: false,
      nextOffset: null,
      isMandatory: null,
      inputType: null,
    };
    expect(respostaMarcasShopeeSchema.parse(vazia)).toStrictEqual(vazia);
  });
});

describe('respostaVariacoesShopeeSchema — the standardised tree', () => {
  it('the exact envelope keys; `variationOptionId: 0` (the custom option) survives', () => {
    expect(Object.keys(respostaVariacoesShopeeSchema.shape).sort()).toEqual(
      ['categoryId', 'leaf', 'pathUsed', 'standardiseVariationList'].sort(),
    );
    const r = respostaVariacoesShopeeSchema.parse(RESPOSTA_VARIACOES);
    expect(
      r.standardiseVariationList[0]?.variationGroupList[0]?.variationOptionList[1]
        ?.variationOptionId,
    ).toBe(0);
  });
});

describe('respostaRecomendacaoCategoriaShopeeSchema — offered, never applied', () => {
  it('the exact envelope keys; an unresolved row (`name`/`isLeaf` null, empty path) parses', () => {
    expect(Object.keys(respostaRecomendacaoCategoriaShopeeSchema.shape).sort()).toEqual(
      ['applied', 'recomendacoes', 'unresolved'].sort(),
    );
    expect(
      respostaRecomendacaoCategoriaShopeeSchema.parse(RESPOSTA_RECOMENDACAO).recomendacoes[1],
    ).toStrictEqual({
      position: 2,
      categoryId: 999_999,
      name: null,
      isLeaf: null,
      pathFromRoot: [],
    });
  });

  it('NEAR-MISS: a body claiming `applied: true` is refused — the literal is the contract (#799)', () => {
    expect(
      respostaRecomendacaoCategoriaShopeeSchema.safeParse({
        ...RESPOSTA_RECOMENDACAO,
        applied: true,
      }).success,
    ).toBe(false);
  });
});
