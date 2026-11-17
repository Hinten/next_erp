import { describe, expect, it } from 'vitest';
import type {
  ShopeeAttribute,
  ShopeeAttributeValue,
  ShopeeCategoria,
  ShopeeMultiLang,
} from '@delfrance/integrations-shopee';

import { atributosParaPublicar } from '../anuncios/montagemAnuncio';
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
  multi_lang: ShopeeMultiLang[] = [],
): ShopeeAttribute {
  return {
    attribute_id,
    mandatory: true,
    name: `atributo-${String(attribute_id)}`,
    attribute_value_list,
    attribute_info: null,
    multi_lang,
  };
}

function valor(
  value_id: number,
  child_attribute_list: ShopeeAttribute[] = [],
  multi_lang: ShopeeMultiLang[] = [],
): ShopeeAttributeValue {
  return {
    value_id,
    name: `valor-${String(value_id)}`,
    value_unit: null,
    child_attribute_list,
    multi_lang,
  };
}

/** One `multi_lang` row — `pt-BR` unless the case says otherwise. */
function traducao(value: string | null, language: string | null = 'pt-BR'): ShopeeMultiLang {
  return { language, value };
}

/** A value with a pt-BR label and Shopee's own (English) name. */
function valorRotulado(value_id: number, ptBr: string | null, nomeShopee: string | null) {
  return {
    ...valor(value_id, [], ptBr === null ? [] : [traducao(ptBr)]),
    name: nomeShopee,
  };
}

/** The value names of the FIRST root attribute, in order. */
function nomesDosValores(tree: readonly ShopeeAttribute[]): (string | null)[] {
  return (projetarAtributos(tree).atributos[0]?.attributeValueList ?? []).map((v) => v.name);
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
  it('espelha categoryId em camelCase, encurta os dois nomes e resolve isLeaf pela árvore', () => {
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

describe('os nomes em português — a entrada `pt-BR` do multi_lang (#1911 P13a)', () => {
  // A SELEÇÃO, não uma dobra: escolhe um texto e não decide igualdade nenhuma.
  // Mesmo assim o ESCOPO fica preso pelos dois lados — o par que é tomado e os
  // quase-pares que não são.

  it('PAR: o atributo toma o texto `pt-BR`', () => {
    const { atributos } = projetarAtributos([atributo(100408, [], [traducao('Tipo de Conexão')])]);
    expect(atributos[0]?.name).toBe('Tipo de Conexão');
    expect(() => atributoDtoSchema.parse(atributos[0])).not.toThrow();
  });

  it('PAR: o valor toma o texto `pt-BR`, e o atributo SEM tradução fica com o nome da Shopee', () => {
    const { atributos } = projetarAtributos([
      atributo(100408, [valor(2530, [], [traducao('Com fio')])]),
    ]);
    expect(atributos[0]?.name).toBe('atributo-100408');
    expect(atributos[0]?.attributeValueList[0]?.name).toBe('Com fio');
  });

  it.each([['pt-br'], ['PT-BR'], ['pt'], ['en'], [' pt-BR'], ['pt-BR '], [null]])(
    '⛔ QUASE-PAR: a língua %j NÃO é tomada — nem no atributo, nem no valor',
    (lingua) => {
      const { atributos } = projetarAtributos([
        atributo(1, [valor(10, [], [traducao('Com fio', lingua)])], [traducao('Tipo', lingua)]),
      ]);
      expect(atributos[0]?.name).toBe('atributo-1');
      expect(atributos[0]?.attributeValueList[0]?.name).toBe('valor-10');
    },
  );

  it('toma a entrada `pt-BR`, não a PRIMEIRA entrada da lista', () => {
    const { atributos } = projetarAtributos([
      atributo(1, [], [traducao('Wired', 'en'), traducao('Com fio')]),
    ]);
    expect(atributos[0]?.name).toBe('Com fio');
  });

  it.each([[null], [''], ['   '], ['\n\t ']])(
    '⛔ QUASE-PAR: um texto `pt-BR` %j não é utilizável — fica o nome da Shopee',
    (texto) => {
      const { atributos } = projetarAtributos([
        atributo(1, [valor(10, [], [traducao(texto)])], [traducao(texto)]),
      ]);
      expect(atributos[0]?.name).toBe('atributo-1');
      expect(atributos[0]?.attributeValueList[0]?.name).toBe('valor-10');
    },
  );

  it('o texto é tomado VERBATIM — uma projeção nunca apara (« Lã » fica « Lã »)', () => {
    const { atributos } = projetarAtributos([atributo(1, [valor(10, [], [traducao(' Lã ')])])]);
    expect(atributos[0]?.attributeValueList[0]?.name).toBe(' Lã ');
  });

  it('o texto `pt-BR` é VERBATIM por dentro também (espaço duplo, NBSP, quebra de linha)', () => {
    const texto = 'Tipo  de Conexão\n';
    const { atributos } = projetarAtributos([
      atributo(1, [valor(10, [], [traducao(texto)])], [traducao(texto)]),
    ]);
    expect(atributos[0]?.name).toBe(texto);
    expect(atributos[0]?.attributeValueList[0]?.name).toBe(texto);
  });

  it('duas entradas `pt-BR`: vale a PRIMEIRA utilizável', () => {
    const { atributos } = projetarAtributos([
      atributo(
        1,
        [valor(10, [], [traducao('  '), traducao('Segundo'), traducao('Terceiro')])],
        [traducao('Primeiro'), traducao('Segundo')],
      ),
    ]);
    expect(atributos[0]?.name).toBe('Primeiro');
    expect(atributos[0]?.attributeValueList[0]?.name).toBe('Segundo');
  });

  it('sem tradução e sem nome da Shopee, o nome é `null` (o validador então diz `#<id>`)', () => {
    const { atributos } = projetarAtributos([
      { ...atributo(1, [{ ...valor(10), name: null }]), name: null },
    ]);
    expect(atributos[0]?.name).toBeNull();
    expect(atributos[0]?.attributeValueList[0]?.name).toBeNull();
  });

  it('PROFUNDIDADE: raiz → valor → filho → valor → neto → valor, todos em português', () => {
    const neto = atributo(3, [valor(30, [], [traducao('Valor 3')])], [traducao('Nível 3')]);
    const filho = atributo(2, [valor(20, [neto], [traducao('Valor 2')])], [traducao('Nível 2')]);
    const raiz = atributo(1, [valor(10, [filho], [traducao('Valor 1')])], [traducao('Nível 1')]);

    const [a1] = projetarAtributos([raiz]).atributos;
    const v1 = a1?.attributeValueList[0];
    const a2 = v1?.childAttributeList[0];
    const v2 = a2?.attributeValueList[0];
    const a3 = v2?.childAttributeList[0];
    const v3 = a3?.attributeValueList[0];

    expect([a1, v1, a2, v2, a3, v3].map((no) => no?.name)).toEqual([
      'Nível 1',
      'Valor 1',
      'Nível 2',
      'Valor 2',
      'Nível 3',
      'Valor 3',
    ]);
  });
});

describe('rótulos que COLIDEM entre irmãos (#1911 P13a, Lucas Q2 = A)', () => {
  it('PAR: dois valores «Porcelana» levam o nome da Shopee; o irmão que não colide fica intacto', () => {
    expect(
      nomesDosValores([
        atributo(100134, [
          valorRotulado(1801, 'Porcelana', 'Porcelain'),
          valorRotulado(1802, 'Cerâmica', 'Ceramic'),
          valorRotulado(1955, 'Porcelana', 'Fine China'),
        ]),
      ]),
    ).toEqual(['Porcelana (Porcelain)', 'Cerâmica', 'Porcelana (Fine China)']);
  });

  // Só caixa e acento: «Lã» × «Lã » (que a tela mostra igual) fica SEM pino de
  // propósito — a decisão é do dono (ver o docblock de `rotulosDistintos`).
  it.each([
    ['Lã', 'La'],
    ['Lã', 'lã'],
  ])(
    '⛔ QUASE-PAR: «%s» e «%s» NÃO colidem — comparação exata, sem dobra de caixa ou acento',
    (a, b) => {
      expect(
        nomesDosValores([
          atributo(100134, [valorRotulado(1156, a, 'Fleece'), valorRotulado(1775, b, 'Wool')]),
        ]),
      ).toEqual([a, b]);
    },
  );

  it('colisão TRIPLA: os três levam o nome da Shopee', () => {
    expect(
      nomesDosValores([
        atributo(100134, [
          valorRotulado(1, 'Lã', 'Fleece'),
          valorRotulado(2, 'Lã', 'Wool'),
          valorRotulado(3, 'Lã', 'Merino'),
        ]),
      ]),
    ).toEqual(['Lã (Fleece)', 'Lã (Wool)', 'Lã (Merino)']);
  });

  it('nomes da Shopee IGUAIS entre os que colidem: esses levam `#<id>`, o único leva o nome', () => {
    expect(
      nomesDosValores([
        atributo(100134, [
          valorRotulado(1, 'Lã', 'Wool'),
          valorRotulado(2, 'Lã', 'Wool'),
          valorRotulado(3, 'Lã', 'Fleece'),
        ]),
      ]),
    ).toEqual(['Lã (#1)', 'Lã (#2)', 'Lã (Fleece)']);
  });

  it('a unicidade do nome da Shopee conta só ENTRE OS QUE COLIDEM', () => {
    expect(
      nomesDosValores([
        atributo(100134, [
          valorRotulado(1156, 'Lã', 'Fleece'),
          valorRotulado(1775, 'Lã', 'Wool'),
          valorRotulado(1800, 'Algodão', 'Wool'),
        ]),
      ]),
    ).toEqual(['Lã (Fleece)', 'Lã (Wool)', 'Algodão']);
  });

  it('⛔ QUASE-PAR: a unicidade do nome da Shopee é EXATA (Wool ≠ wool)', () => {
    expect(
      nomesDosValores([
        atributo(100134, [valorRotulado(1, 'Lã', 'Wool'), valorRotulado(2, 'Lã', 'wool')]),
      ]),
    ).toEqual(['Lã (Wool)', 'Lã (wool)']);
  });

  it('o sufixo é o nome da Shopee VERBATIM — e por isso os rótulos sufixados continuam distintos', () => {
    expect(
      nomesDosValores([
        atributo(100134, [
          valorRotulado(1156, 'Lã', ' Fleece '),
          valorRotulado(1775, 'Lã', 'Wool'),
        ]),
      ]),
    ).toEqual(['Lã ( Fleece )', 'Lã (Wool)']);
    // Aparar o sufixo com a unicidade exata faria DOIS «Lã (Wool)».
    expect(
      nomesDosValores([
        atributo(100134, [valorRotulado(1, 'Lã', 'Wool'), valorRotulado(2, 'Lã', 'Wool ')]),
      ]),
    ).toEqual(['Lã (Wool)', 'Lã (Wool )']);
  });

  it.each([[null], [''], ['  ']])(
    'nome da Shopee AUSENTE (%j) num dos que colidem: esse leva `#<id>`',
    (nomeShopee) => {
      expect(
        nomesDosValores([
          atributo(100134, [
            valorRotulado(1156, 'Lã', nomeShopee),
            valorRotulado(1775, 'Lã', 'Wool'),
          ]),
        ]),
      ).toEqual(['Lã (#1156)', 'Lã (Wool)']);
    },
  );

  it('colide o rótulo EXIBIDO: um «Lã» traduzido e um «Lã» que é o próprio nome da Shopee', () => {
    expect(
      nomesDosValores([
        atributo(100134, [valorRotulado(1775, 'Lã', 'Wool'), valorRotulado(9, null, 'Lã')]),
      ]),
    ).toEqual(['Lã (Wool)', 'Lã (Lã)']);
  });

  it('dois rótulos `null` não colidem — continuam `null` (o validador diz `#<id>`)', () => {
    expect(
      nomesDosValores([
        atributo(100134, [valorRotulado(1, null, null), valorRotulado(2, null, null)]),
      ]),
    ).toEqual([null, null]);
  });

  it('colisão entre ATRIBUTOS RAIZ (sintético)', () => {
    const { atributos } = projetarAtributos([
      { ...atributo(100134, [], [traducao('Material')]), name: 'Material' },
      { ...atributo(100230, [], [traducao('Material')]), name: 'Fabric' },
    ]);
    expect(atributos.map((a) => a.name)).toEqual(['Material (Material)', 'Material (Fabric)']);
  });

  it('colisão entre ATRIBUTOS RAIZ com o MESMO nome da Shopee: o sufixo é o `#<attribute_id>`', () => {
    const { atributos } = projetarAtributos([
      { ...atributo(100134, [], [traducao('Material')]), name: 'Material' },
      { ...atributo(100230, [], [traducao('Material')]), name: 'Material' },
    ]);
    expect(atributos.map((a) => a.name)).toEqual(['Material (#100134)', 'Material (#100230)']);
  });

  it('colisão entre os FILHOS de um valor, um sem nome da Shopee (null): esse leva `#<attribute_id>`', () => {
    const { atributos } = projetarAtributos([
      atributo(100408, [
        valor(2530, [
          { ...atributo(101237, [], [traducao('Fabricante')]), name: null },
          { ...atributo(101238, [], [traducao('Fabricante')]), name: 'Maker' },
        ]),
      ]),
    ]);
    expect(atributos[0]?.attributeValueList[0]?.childAttributeList.map((a) => a.name)).toEqual([
      'Fabricante (#101237)',
      'Fabricante (Maker)',
    ]);
  });

  it('colisão entre os FILHOS de um valor (sintético)', () => {
    const { atributos } = projetarAtributos([
      atributo(100408, [
        valor(2530, [
          { ...atributo(101237, [], [traducao('Fabricante')]), name: 'Manufacturer' },
          { ...atributo(101238, [], [traducao('Fabricante')]), name: 'Maker' },
          { ...atributo(101040, [], [traducao('Nome do Modelo')]), name: 'Model Name' },
        ]),
      ]),
    ]);
    expect(atributos[0]?.attributeValueList[0]?.childAttributeList.map((a) => a.name)).toEqual([
      'Fabricante (Manufacturer)',
      'Fabricante (Maker)',
      'Nome do Modelo',
    ]);
  });

  it('colisão entre os VALORES de um atributo FILHO (sintético)', () => {
    const { atributos } = projetarAtributos([
      atributo(100408, [
        valor(2530, [
          atributo(101237, [
            valorRotulado(1156, 'Lã', 'Fleece'),
            valorRotulado(1775, 'Lã', 'Wool'),
          ]),
        ]),
      ]),
    ]);
    expect(
      atributos[0]?.attributeValueList[0]?.childAttributeList[0]?.attributeValueList.map(
        (v) => v.name,
      ),
    ).toEqual(['Lã (Fleece)', 'Lã (Wool)']);
  });

  it('colisão entre NETOS — a lista de atributos do 3º nível (sintético)', () => {
    const neto = (id: number, nome: string) => ({
      ...atributo(id, [], [traducao('Fabricante')]),
      name: nome,
    });
    const filho = atributo(2, [valor(20, [neto(31, 'Manufacturer'), neto(32, 'Maker')])]);
    const { atributos } = projetarAtributos([atributo(1, [valor(10, [filho])])]);
    const netos =
      atributos[0]?.attributeValueList[0]?.childAttributeList[0]?.attributeValueList[0]
        ?.childAttributeList ?? [];
    expect(netos.map((a) => a.name)).toEqual(['Fabricante (Manufacturer)', 'Fabricante (Maker)']);
  });

  it('⛔ QUASE-PAR: rótulos iguais em LISTAS DIFERENTES não colidem', () => {
    // Um atributo e o seu próprio valor; o mesmo «Sim» sob dois atributos; um
    // filho com o rótulo de uma raiz — nenhuma dessas é uma lista de irmãos.
    const { atributos } = projetarAtributos([
      atributo(
        1,
        [
          valor(
            10,
            [atributo(3, [valor(30, [], [traducao('Sim')])], [traducao('Material')])],
            [traducao('Material')],
          ),
        ],
        [traducao('Material')],
      ),
      atributo(2, [valor(20, [], [traducao('Sim')])], [traducao('Garantia')]),
    ]);
    const v10 = atributos[0]?.attributeValueList[0];
    const filho = v10?.childAttributeList[0];

    expect(atributos.map((a) => a.name)).toEqual(['Material', 'Garantia']);
    expect(v10?.name).toBe('Material');
    expect(filho?.name).toBe('Material');
    expect(filho?.attributeValueList[0]?.name).toBe('Sim');
    expect(atributos[1]?.attributeValueList[0]?.name).toBe('Sim');
  });

  it('⛔ QUASE-PAR: o mesmo attribute_id duas vezes na raiz não é colisão — o rótulo fica nu', () => {
    const material = atributo(100134, [], [traducao('Material')]);
    const { atributos } = projetarAtributos([material, material]);
    expect(atributos.map((a) => a.name)).toEqual(['Material', 'Material']);
  });

  it('⛔ QUASE-PAR: o mesmo value_id duas vezes numa lista de valores não é colisão', () => {
    const porcelana = valorRotulado(1801, 'Porcelana', 'Porcelain');
    expect(nomesDosValores([atributo(100134, [porcelana, porcelana])])).toEqual([
      'Porcelana',
      'Porcelana',
    ]);
  });

  it('PAR: um id repetido DENTRO de um grupo que colide de verdade conta uma vez só', () => {
    const porcelana = valorRotulado(1801, 'Porcelana', 'Porcelain');
    expect(
      nomesDosValores([
        atributo(100134, [porcelana, porcelana, valorRotulado(1955, 'Porcelana', 'Fine China')]),
      ]),
    ).toEqual(['Porcelana (Porcelain)', 'Porcelana (Porcelain)', 'Porcelana (Fine China)']);
  });

  it('× o publicador: uma raiz obrigatória repetida na árvore é nomeada UMA vez, sem sufixo', () => {
    const material = atributo(100134, [], [traducao('Material')]);
    expect(atributosParaPublicar(null, projetarAtributos([material, material])).faltando).toEqual([
      'Material',
    ]);
  });

  it('⚠️ UMA passada: um rótulo sufixado não é comparado de novo com os irmãos intactos (residual documentado)', () => {
    expect(
      nomesDosValores([
        atributo(100134, [
          valorRotulado(1, 'Lã', 'Wool'),
          valorRotulado(2, 'Lã', 'Fleece'),
          valorRotulado(3, 'Lã (Wool)', 'Merino'),
        ]),
      ]),
    ).toEqual(['Lã (Wool)', 'Lã (Fleece)', 'Lã (Wool)']);
  });

  it('não muta a árvore de entrada — o cache entrega a MESMA árvore a cada pedido', () => {
    const arvore: ShopeeAttribute[] = [
      atributo(
        100134,
        [
          valorRotulado(1801, 'Porcelana', 'Porcelain'),
          valorRotulado(1955, 'Porcelana', 'Fine China'),
          valor(1802, [atributo(5, [], [traducao('Filho')])], [traducao('Cerâmica')]),
        ],
        [traducao('Material')],
      ),
    ];
    const antes = structuredClone(arvore);
    const primeira = projetarAtributos(arvore);
    expect(arvore).toEqual(antes);
    expect(projetarAtributos(arvore)).toEqual(primeira);
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
