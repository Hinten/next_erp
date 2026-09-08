import { describe, expect, it } from 'vitest';
import type {
  ShopeeAttribute,
  ShopeeAttributeValue,
  ShopeeCategoria,
} from '@delfrance/integrations-shopee';

import { construirIndice } from './categorias';
import {
  SHOPEE_ATTRIBUTE_MAX_DEPTH,
  type AtributoDto,
  atributoDtoSchema,
  categoriaNoDtoSchema,
  marcaDtoSchema,
  projetarAtributos,
  projetarCategoria,
  projetarMarcas,
  projetarNoDeCategoria,
  projetarVariacoes,
  variacaoDtoSchema,
} from './dto';

function no(
  category_id: number,
  parent_category_id: number,
  has_children: boolean,
  nome = `cat-${String(category_id)}`,
): ShopeeCategoria {
  return {
    category_id,
    parent_category_id,
    has_children,
    original_category_name: `${nome} (orig)`,
    display_category_name: nome,
  };
}

const INDICE = construirIndice([
  no(100000, 0, true, 'Moda'),
  no(100100, 100000, true, 'Roupas'),
  no(100182, 100100, false, 'Camisetas'),
]);

function atributo(
  attribute_id: number,
  attribute_value_list: ShopeeAttributeValue[] = [],
): ShopeeAttribute {
  return {
    attribute_id,
    mandatory: true,
    name: `atributo-${String(attribute_id)}`,
    attribute_value_list,
    attribute_info: null,
    multi_lang: [],
  };
}

function valor(
  value_id: number,
  child_attribute_list: ShopeeAttribute[] = [],
): ShopeeAttributeValue {
  return {
    value_id,
    name: `valor-${String(value_id)}`,
    value_unit: null,
    child_attribute_list,
    multi_lang: [],
  };
}

/** A chain `profundidade` attribute levels deep, each level under a value. */
function corrente(profundidade: number): ShopeeAttribute {
  let atual = atributo(profundidade, [valor(profundidade)]);
  for (let nivel = profundidade - 1; nivel >= 1; nivel -= 1) {
    atual = atributo(nivel, [valor(nivel, [atual])]);
  }
  return atual;
}

function medirProfundidade(a: AtributoDto): number {
  const filhos = a.attributeValueList.flatMap((v) => v.childAttributeList);
  return filhos.length === 0 ? 1 : 1 + Math.max(...filhos.map(medirProfundidade));
}

describe('projetarCategoria', () => {
  it('espelha os nomes de Shopee em camelCase e resolve isLeaf pela árvore', () => {
    expect(projetarCategoria(INDICE, no(100182, 100100, false, 'Camisetas'))).toEqual({
      categoryId: 100182,
      name: 'Camisetas',
      originalName: 'Camisetas (orig)',
      isLeaf: true,
    });
  });

  it('um nó do meio da árvore NÃO é folha — o par do caso acima', () => {
    expect(projetarCategoria(INDICE, no(100100, 100000, true)).isLeaf).toBe(false);
  });
});

describe('projetarNoDeCategoria', () => {
  it('devolve o caminho da RAIZ para o nó e só os filhos diretos', () => {
    const projetado = projetarNoDeCategoria(INDICE, no(100100, 100000, true, 'Roupas'));

    expect(projetado.parentId).toBe(100000);
    expect(projetado.pathFromRoot.map((c) => c.categoryId)).toEqual([100000, 100100]);
    expect(projetado.children.map((c) => c.categoryId)).toEqual([100182]);
    expect(() => categoriaNoDtoSchema.parse(projetado)).not.toThrow();
  });

  it('mantém parentId 0 na raiz — é um zero com significado, não uma ausência', () => {
    const projetado = projetarNoDeCategoria(INDICE, no(100000, 0, true, 'Moda'));
    expect(projetado.parentId).toBe(0);
    expect(projetado.pathFromRoot.map((c) => c.categoryId)).toEqual([100000]);
  });
});

describe('a profundidade máxima da árvore de atributos', () => {
  it(`projeta uma corrente de ${String(SHOPEE_ATTRIBUTE_MAX_DEPTH)} níveis INTEIRA, sem marcar truncated`, () => {
    const { atributos, truncated } = projetarAtributos([corrente(SHOPEE_ATTRIBUTE_MAX_DEPTH)]);

    expect(truncated).toBe(false);
    expect(atributos[0]).toBeDefined();
    expect(medirProfundidade(atributos[0] as AtributoDto)).toBe(SHOPEE_ATTRIBUTE_MAX_DEPTH);
  });

  it('corta no nível seguinte e DIZ que cortou — o par do caso acima', () => {
    // Um `truncated` que disparasse no limite faria toda resposta profunda mas
    // inteira parecer perdida, e quem aprende a ignorar o aviso ignora o de
    // verdade também.
    const { atributos, truncated } = projetarAtributos([corrente(SHOPEE_ATTRIBUTE_MAX_DEPTH + 1)]);

    expect(truncated).toBe(true);
    expect(medirProfundidade(atributos[0] as AtributoDto)).toBe(SHOPEE_ATTRIBUTE_MAX_DEPTH);
  });

  it('uma árvore rasa não marca truncated', () => {
    expect(projetarAtributos([atributo(1, [valor(10)])]).truncated).toBe(false);
  });
});

describe('projetarAtributos', () => {
  it('mantém value_id 0 como VALOR e não como ausência', () => {
    const { atributos } = projetarAtributos([atributo(1, [valor(0)])]);
    expect(atributos[0]?.attributeValueList[0]?.valueId).toBe(0);
  });

  it('espelha attribute_info com os enums INTEIROS', () => {
    const comInfo: ShopeeAttribute = {
      ...atributo(7),
      attribute_info: {
        input_type: 1,
        input_validation_type: 0,
        format_type: 2,
        date_format_type: 0,
        attribute_unit_list: ['cm'],
        max_value_count: 3,
        introduction: null,
        is_oem: false,
        support_search_value: null,
      },
    };
    const { atributos } = projetarAtributos([comInfo]);

    expect(atributos[0]?.attributeInfo).toEqual({
      inputType: 1,
      inputValidationType: 0,
      formatType: 2,
      dateFormatType: 0,
      attributeUnitList: ['cm'],
      maxValueCount: 3,
      introduction: null,
      isOem: false,
      supportSearchValue: null,
    });
    expect(() => atributoDtoSchema.parse(atributos[0])).not.toThrow();
  });

  it('mantém mandatory: false como está', () => {
    const { atributos } = projetarAtributos([{ ...atributo(1), mandatory: false }]);
    expect(atributos[0]?.mandatory).toBe(false);
  });
});

describe('projetarMarcas', () => {
  it('mantém brand_id 0 — "Sem marca" é uma escolha, não um campo vazio', () => {
    const [semMarca] = projetarMarcas([
      { brand_id: 0, original_brand_name: 'No Brand', display_brand_name: null },
    ]);

    expect(semMarca?.brandId).toBe(0);
    expect(() => marcaDtoSchema.parse(semMarca)).not.toThrow();
  });

  it('lê um brand_id acima de int32', () => {
    const [grande] = projetarMarcas([
      { brand_id: 2500139861, original_brand_name: 'Marca', display_brand_name: 'Marca' },
    ]);
    expect(grande?.brandId).toBe(2500139861);
  });
});

describe('projetarVariacoes', () => {
  it('mantém variation_option_id 0 — a opção CUSTOM — nos três níveis', () => {
    const [variacao] = projetarVariacoes([
      {
        variation_id: 100012,
        variation_name: 'Cor',
        variation_group_list: [
          {
            variation_group_id: 200023,
            variation_group_name: 'Básicas',
            variation_option_list: [{ variation_option_id: 0, variation_option_name: 'Custom' }],
          },
        ],
      },
    ]);

    expect(variacao?.variationGroupList[0]?.variationOptionList[0]).toEqual({
      variationOptionId: 0,
      variationOptionName: 'Custom',
    });
    expect(() => variacaoDtoSchema.parse(variacao)).not.toThrow();
  });
});
