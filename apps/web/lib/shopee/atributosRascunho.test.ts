import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  TIPO_PROBLEMA_ATRIBUTO_SHOPEE,
  atributosShopeeRequisicaoSchema,
  type ArvoreAtributosShopee,
  type AtributoDto,
  type AtributoInfoDto,
  type AtributoShopeeRequisicao,
  type AtributoValorDto,
} from '@delfrance/schemas';

import {
  MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE,
  MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE,
  TIPO_CONTROLE_ATRIBUTO_SHOPEE,
  aplicarEdicaoDoAtributoShopee,
  controleDoAtributoShopee,
  digitacoesBloqueiam,
  linhasDoEditorDeAtributosShopee,
  type DigitacoesAtributosShopee,
  type EdicaoDoAtributoShopee,
  type LinhaAtributoShopee,
  type ResultadoDaEdicaoDoAtributoShopee,
} from './atributosRascunho';

/**
 * The draft's attribute editor model (#1911 P13). Every tree is hand-written in
 * the shape of the public `get_attribute_tree.br-*` captures as `apps/shopee`
 * projects them (a web test cannot import that app's fixtures): public taxonomy
 * where a BR id is named, invented (the `9xxxxx` ids) everywhere else; every
 * typed value is invented.
 *
 * Each rule has a pair and a near miss: a test that the rule APPLIES cannot show
 * where it STOPS (#1372). The walk, the decoder and the validator are the REAL
 * schemas ones — nothing here is faked.
 */

/* -------------------------------------------------------------------------- */
/*                                  Fixtures                                   */
/* -------------------------------------------------------------------------- */

const info = (p: Partial<AtributoInfoDto>): AtributoInfoDto => ({
  inputType: null,
  inputValidationType: 0,
  formatType: 1,
  dateFormatType: null,
  attributeUnitList: null,
  maxValueCount: null,
  introduction: null,
  isOem: false,
  supportSearchValue: false,
  ...p,
});

const valor = (
  valueId: number,
  name: string | null,
  filhos: AtributoDto[] = [],
  valueUnit: string | null = null,
): AtributoValorDto => ({ valueId, name, valueUnit, childAttributeList: filhos });

const atributo = (
  attributeId: number,
  name: string | null,
  i: Partial<AtributoInfoDto> | null,
  valores: AtributoValorDto[] = [],
  mandatory = false,
): AtributoDto => ({
  attributeId,
  mandatory,
  name,
  attributeInfo: i === null ? null : info(i),
  attributeValueList: valores,
});

// br-b-capa: the three mandatory children of 100408 = 2530, in the tree's order.
const FABRICANTE = atributo(
  101237,
  'Fabricante',
  { inputType: 2, inputValidationType: 2, supportSearchValue: true },
  [],
  true,
);
const HOMOLOGACAO = atributo(
  101197,
  'Nr. de Homologação',
  { inputType: 3, inputValidationType: 2 },
  [],
  true,
);
const NOME_DO_MODELO = atributo(
  101040,
  'Nome do Modelo',
  { inputType: 3, inputValidationType: 2 },
  [],
  true,
);
const COM_FIO = 2498;
const SEM_FIO = 2530;
const ROTULO_SEM_FIO = 'Sem fio (Bluetooth, Wifi, Radiofrequência)';
const TIPO_DE_CONEXAO = atributo(
  100408,
  'Tipo de Conexão',
  { inputType: 1 },
  [
    valor(COM_FIO, 'Com fio, Sem conexão ou Outros'),
    valor(SEM_FIO, ROTULO_SEM_FIO, [FABRICANTE, HOMOLOGACAO, NOME_DO_MODELO]),
  ],
  true,
);

const UNIDADES_101029 = [
  'ML',
  'L',
  'MG',
  'G/GR',
  'KG',
  'CM',
  'M',
  'Dozen',
  'Piece',
  'Pack',
  'Set',
  'Box',
];
const TAMANHO_DO_PACOTE = atributo(101029, 'Tamanho Do Pacote', {
  inputType: 3,
  inputValidationType: 3,
  formatType: 2,
  attributeUnitList: UNIDADES_101029,
});

// br-a-caneca
const PAIS_DE_ORIGEM = atributo(
  100037,
  'País de Origem',
  { inputType: 2, inputValidationType: 2 },
  [valor(35, 'China'), valor(6737, 'Brasil')],
);
const MATERIAL = atributo(
  100134,
  'Material',
  { inputType: 5, inputValidationType: 2, maxValueCount: 5 },
  [valor(1207, 'Plástico'), valor(1218, 'Vidro'), valor(1481, 'Cerâmica')],
);
const CAPACIDADE = atributo(100278, 'Capacidade de Volume', {
  inputType: 5,
  inputValidationType: 3,
  formatType: 2,
  attributeUnitList: ['L', 'ml'],
  maxValueCount: 5,
});
const QUANTIDADE = atributo(100999, 'Quantidade da embalagem', {
  inputType: 3,
  inputValidationType: 2,
});

// br-anuncio-atributos
const GENERO = atributo(100022, 'Gênero', { inputType: 1 }, [
  valor(674, 'Unissex'),
  valor(681, 'Menino'),
  valor(745, 'Menina'),
]);
const CONDICAO = atributo(100413, 'Condição', { inputType: 2, inputValidationType: 2 });
const MODELO = atributo(101639, 'Modelo', {
  inputType: 5,
  inputValidationType: 2,
  maxValueCount: 5,
});
const SIM = 20996;
const RADIO = atributo(
  106664,
  'Contém bluetooh, Wi-fi e/ou Tecnologia de Radio Frequência?',
  { inputType: 1 },
  [valor(SIM, 'Sim', [NOME_DO_MODELO, FABRICANTE, HOMOLOGACAO]), valor(20997, 'Não')],
);

// br-d-cafe: list values that carry a unit.
const VOLUME = atributo(
  100248,
  'Volume',
  { inputType: 2, inputValidationType: 3, formatType: 2, attributeUnitList: ['ml', 'L'] },
  [valor(499, '1L', [], 'L'), valor(511, '10ml', [], 'ml')],
);
const PESO = atributo(
  100095,
  'Peso do Produto',
  { inputType: 2, inputValidationType: 3, formatType: 2, attributeUnitList: ['g', 'kg'] },
  [valor(631, '1kg', [], 'kg'), valor(640, '1.5kg', [], 'kg'), valor(646, '2kg', [], 'kg')],
);

// Synthetic (no BR attribute has these shapes).
const MULTIPLA_SO_LISTA = atributo(
  900001,
  'Sintético múltiplo',
  { inputType: 4, maxValueCount: 3 },
  [valor(900101, 'Um'), valor(900102, 'Dois'), valor(900103, 'Três'), valor(900104, 'Quatro')],
);
const DATA = atributo(900002, 'Sintético data', {
  inputType: 3,
  inputValidationType: 4,
  dateFormatType: 0,
});
const TIPO_9 = atributo(900003, 'Sintético tipo 9', { inputType: 9 }, [valor(900131, 'X')]);
const SO_BUSCA = atributo(
  900004,
  'Sintético só busca',
  { inputType: 1, supportSearchValue: true },
  [valor(900141, 'Algum')],
  true,
);
const TIPO_1_SEM_VALORES = atributo(900005, 'Sintético tipo 1 vazio', { inputType: 1 });
const UNIDADE_SEM_LISTA = atributo(900006, 'Sintético unidade sem lista', {
  inputType: 3,
  inputValidationType: 3,
  formatType: 2,
  attributeUnitList: null,
});
const INTEIRO = atributo(900007, 'Sintético inteiro', { inputType: 3, inputValidationType: 1 });
const MATERIAL_UNICO = atributo(
  900008,
  'Sintético material único',
  { inputType: 2, inputValidationType: 2 },
  [valor(1207, 'Plástico'), valor(1218, 'Vidro')],
);
const SEM_INFO = atributo(900009, 'Sintético sem info', null, [valor(900191, 'X')]);
/** A mandatory decimal child with a unit — so a typing on a CHILD can block. */
const FILHO_DO_TIPO_2 = atributo(
  900011,
  'Sintético filho',
  { inputType: 3, inputValidationType: 3, formatType: 2, attributeUnitList: ['KG'] },
  [],
  true,
);
const PAI_TIPO_2 = atributo(900010, 'Sintético pai tipo 2', { inputType: 2 }, [
  valor(900110, 'Abre', [FILHO_DO_TIPO_2]),
  valor(900111, 'Fecha'),
]);

const arvore = (atributos: AtributoDto[], truncated = false): ArvoreAtributosShopee => ({
  atributos,
  truncated,
});

const CAPA = arvore([TIPO_DE_CONEXAO, MATERIAL, TAMANHO_DO_PACOTE]);
const CANECA = arvore([PAIS_DE_ORIGEM, MATERIAL, CAPACIDADE, QUANTIDADE, TAMANHO_DO_PACOTE]);
const ANUNCIO = arvore([GENERO, CONDICAO, MODELO, RADIO]);
const CAFE = arvore([VOLUME, PESO]);
const SINTETICA = arvore([
  MULTIPLA_SO_LISTA,
  DATA,
  SO_BUSCA,
  INTEIRO,
  MATERIAL_UNICO,
  PAI_TIPO_2,
  PAIS_DE_ORIGEM,
]);

const at = (
  attributeId: number,
  ...attribute_value_list: AtributoShopeeRequisicao['attribute_value_list'][number][]
): AtributoShopeeRequisicao => ({ attribute_id: attributeId, attribute_value_list });

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                    */
/* -------------------------------------------------------------------------- */

interface Estado {
  readonly arvore: ArvoreAtributosShopee;
  readonly lista: readonly AtributoShopeeRequisicao[] | null;
  readonly guardados?: readonly AtributoShopeeRequisicao[] | null;
  readonly digitacoes?: DigitacoesAtributosShopee;
}

function editar(
  e: Estado,
  attributeId: number,
  edicao: EdicaoDoAtributoShopee,
): ResultadoDaEdicaoDoAtributoShopee {
  return aplicarEdicaoDoAtributoShopee({
    arvore: e.arvore,
    lista: e.lista,
    guardados: e.guardados ?? null,
    digitacoes: e.digitacoes ?? {},
    attributeId,
    edicao,
  });
}

/** The edit's `ok` answer; a refusal fails the test with its motivo. */
function aceita(
  r: ResultadoDaEdicaoDoAtributoShopee,
): Extract<ResultadoDaEdicaoDoAtributoShopee, { readonly ok: true }> {
  if (!r.ok) throw new TypeError(`edição recusada: ${r.motivo}`);
  return r;
}

/** Edits applied in sequence, each over the previous answer (same base). */
function emSequencia(
  e: Estado,
  passos: readonly (readonly [number, EdicaoDoAtributoShopee])[],
): Extract<ResultadoDaEdicaoDoAtributoShopee, { readonly ok: true }> {
  let lista = e.lista;
  let digitacoes = e.digitacoes ?? {};
  let ultimo: Extract<ResultadoDaEdicaoDoAtributoShopee, { readonly ok: true }> = {
    ok: true,
    lista,
    digitacoes,
  };
  for (const [id, edicao] of passos) {
    ultimo = aceita(editar({ ...e, lista, digitacoes }, id, edicao));
    lista = ultimo.lista;
    digitacoes = ultimo.digitacoes;
  }
  return ultimo;
}

function editor(e: Estado) {
  return linhasDoEditorDeAtributosShopee({
    arvore: e.arvore,
    lista: e.lista,
    guardados: e.guardados ?? null,
    digitacoes: e.digitacoes ?? {},
  });
}

function linha(e: Estado, attributeId: number): LinhaAtributoShopee {
  const achada = editor(e).linhas.find((l) => l.attributeId === attributeId);
  if (achada === undefined) throw new TypeError(`sem linha para ${String(attributeId)}`);
  return achada;
}

const ids = (e: Estado): number[] => editor(e).linhas.map((l) => l.attributeId);

/** The editor never authors what the draft route's write schema refuses. */
function gravavel(lista: readonly AtributoShopeeRequisicao[] | null): void {
  expect(atributosShopeeRequisicaoSchema.safeParse(lista ?? []).success).toBe(true);
}

const escolher = (valueIds: number[]) => ({ tipo: 'lista', valueIds }) as const;
const texto = (t: string, unidade: string | null = null) =>
  ({ tipo: 'texto', texto: t, unidade }) as const;
const adicionar = (t: string, unidade: string | null = null) =>
  ({ tipo: 'adicionar-personalizado', texto: t, unidade }) as const;

/* -------------------------------------------------------------------------- */
/*                               (1) The control                               */
/* -------------------------------------------------------------------------- */

describe('controleDoAtributoShopee — o controle, na ordem de §3.4', () => {
  it.each([
    ['100408 Tipo de Conexão (tipo 1)', TIPO_DE_CONEXAO, { tipo: 'lista-unica' }],
    ['100022 Gênero (tipo 1)', GENERO, { tipo: 'lista-unica' }],
    ['100037 País de Origem (tipo 2 com lista)', PAIS_DE_ORIGEM, { tipo: 'lista-ou-texto' }],
    ['100095 Peso do Produto (tipo 2 com lista e unidade)', PESO, { tipo: 'lista-ou-texto' }],
    ['101029 Tamanho Do Pacote (tipo 3, decimal, unidade)', TAMANHO_DO_PACOTE, { tipo: 'texto' }],
    ['100999 Quantidade da embalagem (tipo 3)', QUANTIDADE, { tipo: 'texto' }],
    ['101237 Fabricante (tipo 2 sem lista, com busca)', FABRICANTE, { tipo: 'texto' }],
    ['100413 Condição (tipo 2 sem lista)', CONDICAO, { tipo: 'texto' }],
    ['100134 Material (tipo 5 com lista)', MATERIAL, { tipo: 'lista-multipla-ou-texto', max: 5 }],
    [
      '100278 Capacidade de Volume (tipo 5 sem lista)',
      CAPACIDADE,
      { tipo: 'textos-multiplos', max: 5 },
    ],
    ['101639 Modelo (tipo 5 sem lista)', MODELO, { tipo: 'textos-multiplos', max: 5 }],
    ['sintético tipo 4', MULTIPLA_SO_LISTA, { tipo: 'lista-multipla', max: 3 }],
  ])('%s', (_, no, esperado) => {
    expect(controleDoAtributoShopee(no)).toEqual(esperado);
  });

  it.each([
    ['ivt 4 (data)', DATA, MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.data],
    ['input_type 9', TIPO_9, MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.desconhecido],
    ['sem attribute_info', SEM_INFO, MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.desconhecido],
    [
      'só busca (tipo 1 + support_search_value)',
      SO_BUSCA,
      MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.busca,
    ],
    [
      'tipo 1 sem valores',
      TIPO_1_SEM_VALORES,
      MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.listaSemValores,
    ],
    [
      'format_type 2 sem lista de unidades',
      UNIDADE_SEM_LISTA,
      MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.unidadeSemLista,
    ],
  ])('não suportado: %s', (_, no, motivo) => {
    expect(controleDoAtributoShopee(no)).toEqual({ tipo: 'nao-suportado', motivo });
  });

  it('format_type 2 com a lista de unidades VAZIA também é unidade-sem-lista', () => {
    const no = atributo(900020, 'x', {
      inputType: 3,
      inputValidationType: 3,
      formatType: 2,
      attributeUnitList: [],
    });
    expect(controleDoAtributoShopee(no)).toEqual({
      tipo: 'nao-suportado',
      motivo: MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.unidadeSemLista,
    });
  });

  it('⭐ PAR/QUASE-PAR: tipo 2 SEM lista é texto ⟷ tipo 1 sem lista é não suportado', () => {
    expect(controleDoAtributoShopee(CONDICAO).tipo).toBe(TIPO_CONTROLE_ATRIBUTO_SHOPEE.texto);
    expect(controleDoAtributoShopee(TIPO_1_SEM_VALORES).tipo).toBe(
      TIPO_CONTROLE_ATRIBUTO_SHOPEE.naoSuportado,
    );
  });

  it('⭐ PAR/QUASE-PAR: tipo 5 SEM lista é textos-multiplos ⟷ tipo 4 sem lista é não suportado', () => {
    const tipo4Vazio = atributo(900021, 'x', { inputType: 4, maxValueCount: 2 });
    expect(controleDoAtributoShopee(MODELO).tipo).toBe(
      TIPO_CONTROLE_ATRIBUTO_SHOPEE.textosMultiplos,
    );
    expect(controleDoAtributoShopee(tipo4Vazio)).toEqual({
      tipo: 'nao-suportado',
      motivo: MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.listaSemValores,
    });
  });

  it('a ordem: ivt 4 vence mesmo num tipo 1 com valores, e num input_type desconhecido', () => {
    const data1 = atributo(900022, 'x', { inputType: 1, inputValidationType: 4 }, [valor(1, 'a')]);
    const data9 = atributo(900023, 'x', { inputType: 9, inputValidationType: 4 });
    expect(controleDoAtributoShopee(data1)).toEqual({ tipo: 'nao-suportado', motivo: 'data' });
    expect(controleDoAtributoShopee(data9)).toEqual({ tipo: 'nao-suportado', motivo: 'data' });
  });

  it('a ordem: a busca vem antes da unidade sem lista', () => {
    const no = atributo(900024, 'x', {
      inputType: 1,
      supportSearchValue: true,
      formatType: 2,
      attributeUnitList: null,
    });
    expect(controleDoAtributoShopee(no)).toEqual({ tipo: 'nao-suportado', motivo: 'busca' });
  });

  it('⭐ QUASE-PAR: busca COM personalizado aceito (Fabricante) é um texto, não «busca»', () => {
    expect(controleDoAtributoShopee(FABRICANTE)).toEqual({ tipo: 'texto' });
    expect(controleDoAtributoShopee(SO_BUSCA).tipo).toBe('nao-suportado');
  });

  it('⭐ QUASE-PAR: uma lista cujo único valor é o id 0 não tem o que escolher', () => {
    const soZero = atributo(900025, 'x', { inputType: 1 }, [valor(0, 'zero')]);
    const comUm = atributo(900026, 'x', { inputType: 1 }, [valor(1, 'um')]);
    expect(controleDoAtributoShopee(soZero)).toEqual({
      tipo: 'nao-suportado',
      motivo: 'lista-sem-valores',
    });
    expect(controleDoAtributoShopee(comUm)).toEqual({ tipo: 'lista-unica' });
  });

  it('sem max_value_count ⇒ max null (sem limite)', () => {
    const no = atributo(900027, 'x', { inputType: 5 }, [valor(1, 'a')]);
    expect(controleDoAtributoShopee(no)).toEqual({ tipo: 'lista-multipla-ou-texto', max: null });
  });
});

/* -------------------------------------------------------------------------- */
/*                       (2) Rows: options, units, names                       */
/* -------------------------------------------------------------------------- */

describe('linhasDoEditorDeAtributosShopee — opções, unidades e nomes', () => {
  it('⭐ as unidades de 101029 são as 12 da Shopee, na ordem, VERBATIM; sem unidade escolhida', () => {
    const l = linha({ arvore: CAPA, lista: null }, 101029);
    expect(l.unidades).toEqual(UNIDADES_101029);
    expect(l.unidadeDigitada).toBeNull();
    expect(l.tipoDoValor).toBe('decimal');
  });

  it('⭐ PAR/QUASE-PAR: `ML` é oferecido em 101029 ⟷ NÃO em 100248, que diz `ml`', () => {
    expect(linha({ arvore: CAPA, lista: null }, 101029).unidades).toContain('ML');
    const volume = linha({ arvore: CAFE, lista: null }, 100248).unidades;
    expect(volume).toEqual(['ml', 'L']);
    expect(volume).not.toContain('ML');
  });

  it('um atributo sem format_type 2 não tem unidades', () => {
    expect(linha({ arvore: CANECA, lista: null }, 100999).unidades).toBeNull();
  });

  it('as opções são a lista da árvore, na ordem; `#id` quando o valor não tem nome', () => {
    const semNome = atributo(900030, 'x', { inputType: 1 }, [valor(7, null), valor(8, 'oito')]);
    expect(linha({ arvore: arvore([semNome]), lista: null }, 900030).opcoes).toEqual([
      { valueId: 7, rotulo: '#7' },
      { valueId: 8, rotulo: 'oito' },
    ]);
    expect(linha({ arvore: CAPA, lista: null }, 100408).opcoes).toEqual([
      { valueId: COM_FIO, rotulo: 'Com fio, Sem conexão ou Outros' },
      { valueId: SEM_FIO, rotulo: ROTULO_SEM_FIO },
    ]);
  });

  it('o rótulo do atributo é o nome da árvore; `#id` quando não tem', () => {
    const semNome = atributo(900031, null, { inputType: 3 });
    expect(linha({ arvore: arvore([semNome]), lista: null }, 900031).rotulo).toBe('#900031');
    expect(linha({ arvore: CAPA, lista: null }, 100408).rotulo).toBe('Tipo de Conexão');
  });

  it('⭐ PAR/QUASE-PAR: um valor guardado na forma de LEITURA mostra o rótulo da ÁRVORE, nunca o inglês gravado', () => {
    const lidoDaShopee = [
      {
        attribute_id: 100408,
        attribute_value_list: [
          { value_id: SEM_FIO, original_value_name: 'Wireless', value_unit: null },
        ],
      },
    ] as unknown as AtributoShopeeRequisicao[];
    const l = linha({ arvore: CAPA, lista: lidoDaShopee, guardados: lidoDaShopee }, 100408);
    expect(l.valores.map((v) => v.rotulo)).toEqual([ROTULO_SEM_FIO]);
    expect(l.valores.map((v) => v.rotulo)).not.toContain('Wireless');
    expect(l.escolhidos).toEqual([SEM_FIO]);
    expect(l.valores[0]?.valor).toEqual({ value_id: SEM_FIO });
  });

  it('⭐ e o editor nunca reenvia a forma de leitura: editar OUTRO atributo grava `{value_id}` e mais nada', () => {
    const lidoDaShopee = [
      {
        attribute_id: 100408,
        attribute_value_list: [
          { value_id: SEM_FIO, original_value_name: 'Wireless', value_unit: null },
        ],
      },
    ] as unknown as AtributoShopeeRequisicao[];
    const r = aceita(
      editar(
        { arvore: CAPA, lista: lidoDaShopee, guardados: lidoDaShopee },
        101029,
        texto('2', 'KG'),
      ),
    );
    expect(r.lista?.[0]).toEqual({
      attribute_id: 100408,
      attribute_value_list: [{ value_id: SEM_FIO }],
    });
    expect(JSON.stringify(r.lista?.[0])).not.toContain('Wireless');
    gravavel(r.lista);
  });

  it('a descrição é o `introduction` da Shopee quando vem; a nota de busca só onde há busca', () => {
    const comIntro = atributo(900032, 'x', { inputType: 3, introduction: 'Uma dica' });
    expect(linha({ arvore: arvore([comIntro]), lista: null }, 900032).descricao).toBe('Uma dica');
    const comFilhos = { arvore: CAPA, lista: [at(100408, { value_id: SEM_FIO })] };
    expect(linha(comFilhos, 101237).buscaNaShopee).toBe(true);
    expect(linha(comFilhos, 101197).buscaNaShopee).toBe(false);
    expect(linha(comFilhos, 101197).descricao).toBeNull();
  });

  it('o tipo do valor: decimal (ivt 3), inteiro (ivt 1), texto (null)', () => {
    expect(linha({ arvore: SINTETICA, lista: null }, 900007).tipoDoValor).toBe('inteiro');
    expect(linha({ arvore: CANECA, lista: null }, 100278).tipoDoValor).toBe('decimal');
    expect(linha({ arvore: CANECA, lista: null }, 100999).tipoDoValor).toBeNull();
  });

  it('⭐ PAR/QUASE-PAR: um decimal guardado `0.125` aparece `0,125` (sem limite de casas) ⟷ nunca `0.125`', () => {
    const l = linha(
      {
        arvore: CANECA,
        lista: [at(100278, { value_id: 0, original_value_name: '0.125', value_unit: 'L' })],
      },
      100278,
    );
    expect(l.valores.map((v) => [v.rotulo, v.unidade])).toEqual([['0,125', 'L']]);
  });

  it('o texto do campo de um decimal guardado vem com vírgula, e a unidade guardada vem junto', () => {
    const l = linha(
      {
        arvore: CAPA,
        lista: [at(101029, { value_id: 0, original_value_name: '1.5', value_unit: 'KG' })],
      },
      101029,
    );
    expect(l.textoDigitado).toBe('1,5');
    expect(l.unidadeDigitada).toBe('KG');
    expect(l.digitacao).toBeNull();
  });

  it('um controle de lista não tem texto digitado', () => {
    const l = linha({ arvore: CAPA, lista: [at(100408, { value_id: COM_FIO })] }, 100408);
    expect(l.textoDigitado).toBe('');
    expect(l.unidadeDigitada).toBeNull();
    expect(l.outroValor).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                     (3) Typed values: decimal and units                     */
/* -------------------------------------------------------------------------- */

describe('aplicarEdicaoDoAtributoShopee — decimal digitado e unidade (D-9, D-10, #1372)', () => {
  const vazio: Estado = { arvore: CAPA, lista: null };

  it('⭐ `1,5` + `KG` ⇒ `{value_id: 0, original_value_name: "1.5", value_unit: "KG"}`, sem digitação', () => {
    const r = aceita(editar(vazio, 101029, texto('1,5', 'KG')));
    expect(r.lista).toEqual([
      at(101029, { value_id: 0, original_value_name: '1.5', value_unit: 'KG' }),
    ]);
    expect(r.digitacoes).toEqual({});
    gravavel(r.lista);
  });

  it('⭐ `1,5` SEM unidade ⇒ digitação que BLOQUEIA, a lista intocada (nunca a primeira unidade)', () => {
    const antes = [at(100408, { value_id: COM_FIO })];
    const r = aceita(editar({ arvore: CAPA, lista: antes }, 101029, texto('1,5')));
    expect(r.lista).toBe(antes);
    expect(r.digitacoes).toEqual({
      '101029': {
        texto: '1,5',
        unidade: null,
        motivo: MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.unidadeInvalida,
      },
    });
    expect(digitacoesBloqueiam(r.digitacoes)).toBe(true);
  });

  it('uma unidade `""` vale como nenhuma: bloqueia igual', () => {
    const r = aceita(editar(vazio, 101029, texto('1,5', '')));
    expect(r.lista).toBeNull();
    expect(r.digitacoes['101029']?.motivo).toBe(MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.unidadeInvalida);
  });

  it.each(['1.5', '1.500', '1.234,5', '1,5 kg', '1,', ',5', 'abc'])(
    '⭐ `%s` num decimal ⇒ digitação `tipo-de-valor` que bloqueia, a lista intocada',
    (digitado) => {
      const r = aceita(editar(vazio, 101029, texto(digitado, 'KG')));
      expect(r.lista).toBeNull();
      expect(r.digitacoes).toEqual({
        '101029': {
          texto: digitado,
          unidade: 'KG',
          motivo: MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.tipoDeValor,
        },
      });
    },
  );

  it('⭐ `1,` e depois `1,7` ⇒ a digitação some e a lista guarda `1.7`', () => {
    const r = emSequencia(vazio, [
      [101029, texto('1,', 'KG')],
      [101029, texto('1,7', 'KG')],
    ]);
    expect(r.digitacoes).toEqual({});
    expect(r.lista).toEqual([
      at(101029, { value_id: 0, original_value_name: '1.7', value_unit: 'KG' }),
    ]);
  });

  it('⭐ PAR: `1,5` sobre um `1.5` guardado devolve os BYTES guardados', () => {
    const guardados = [at(101029, { value_id: 0, original_value_name: '1.5', value_unit: 'KG' })];
    const r = aceita(
      editar({ arvore: CAPA, lista: guardados, guardados }, 101029, texto('1,5', 'KG')),
    );
    expect(JSON.stringify(r.lista)).toBe(JSON.stringify(guardados));
  });

  it('⭐ QUASE-PAR: `1,50` sobre um `1.5` guardado é uma EDIÇÃO — `1.50`, nunca dobrado num número', () => {
    const guardados = [at(101029, { value_id: 0, original_value_name: '1.5', value_unit: 'KG' })];
    const r = aceita(
      editar({ arvore: CAPA, lista: guardados, guardados }, 101029, texto('1,50', 'KG')),
    );
    expect(r.lista).toEqual([
      at(101029, { value_id: 0, original_value_name: '1.50', value_unit: 'KG' }),
    ]);
    expect(r.lista).not.toEqual(guardados);
    expect(linha({ arvore: CAPA, lista: r.lista }, 101029).textoDigitado).toBe('1,50');
  });

  it('⭐ QUASE-PAR: `01,5` guarda `01.5`, nunca `1.5`', () => {
    const r = aceita(editar(vazio, 101029, texto('01,5', 'KG')));
    expect(r.lista?.[0]?.attribute_value_list[0]?.original_value_name).toBe('01.5');
  });

  it('⭐ PAR/QUASE-PAR: a unidade é EXATA — `ML` vale em 101029 ⟷ `ml` bloqueia (sem dobrar a caixa)', () => {
    expect(aceita(editar(vazio, 101029, texto('2', 'ML'))).lista).toEqual([
      at(101029, { value_id: 0, original_value_name: '2', value_unit: 'ML' }),
    ]);
    const r = aceita(editar(vazio, 101029, texto('2', 'ml')));
    expect(r.lista).toBeNull();
    expect(r.digitacoes['101029']?.motivo).toBe(MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.unidadeInvalida);
  });

  it('texto em branco ⇒ o valor sai; guardado ⇒ vai para «Serão removidos ao salvar»', () => {
    const guardados = [
      at(100408, { value_id: COM_FIO }),
      at(101029, { value_id: 0, original_value_name: '1.5', value_unit: 'KG' }),
    ];
    const r = aceita(editar({ arvore: CAPA, lista: guardados, guardados }, 101029, texto('  ')));
    expect(r.lista).toEqual([at(100408, { value_id: COM_FIO })]);
    expect(r.digitacoes).toEqual({});
    const ed = editor({ arvore: CAPA, lista: r.lista, guardados });
    expect(ed.removidosAoSalvar).toEqual([
      expect.objectContaining({ attributeId: 101029, rotulo: 'Tamanho Do Pacote', inteiro: true }),
    ]);
    expect(ed.removidosAoSalvar[0]?.valores.map((v) => [v.rotulo, v.unidade])).toEqual([
      ['1,5', 'KG'],
    ]);
  });

  it('⭐ PAR/QUASE-PAR: texto em branco + unidade ⇒ digitação que NÃO bloqueia, e lembra a unidade', () => {
    const r = aceita(editar(vazio, 101029, texto('', 'KG')));
    expect(r.lista).toBeNull();
    expect(r.digitacoes).toEqual({ '101029': { texto: '', unidade: 'KG', motivo: null } });
    expect(digitacoesBloqueiam(r.digitacoes)).toBe(false);
    const l = linha({ arvore: CAPA, lista: r.lista, digitacoes: r.digitacoes }, 101029);
    expect([l.textoDigitado, l.unidadeDigitada, l.digitacao]).toEqual(['', 'KG', null]);
  });

  it('uma unidade num atributo SEM unidade é ignorada', () => {
    const r = aceita(editar({ arvore: CANECA, lista: null }, 100999, texto('3', 'KG')));
    expect(r.lista).toEqual([at(100999, { value_id: 0, original_value_name: '3' })]);
  });

  it('⭐ PAR/QUASE-PAR: um texto é guardado CRU (`Algodão orgânico `) ⟷ o rótulo mostrado é o lido', () => {
    const r = aceita(editar({ arvore: ANUNCIO, lista: null }, 100413, texto('Algodão orgânico ')));
    expect(r.lista).toEqual([
      at(100413, { value_id: 0, original_value_name: 'Algodão orgânico ' }),
    ]);
    const l = linha({ arvore: ANUNCIO, lista: r.lista }, 100413);
    expect(l.textoDigitado).toBe('Algodão orgânico ');
    expect(l.valores[0]?.rotulo).toBe('Algodão orgânico');
    gravavel(r.lista);
  });

  it('o texto cru sobrevive a uma edição de OUTRO atributo', () => {
    const r = emSequencia({ arvore: ANUNCIO, lista: null }, [
      [100413, texto('Seminovo ')],
      [100022, escolher([674])],
    ]);
    // No base: the walk's order (100022 is the first root).
    expect(r.lista).toEqual([
      at(100022, { value_id: 674 }),
      at(100413, { value_id: 0, original_value_name: 'Seminovo ' }),
    ]);
  });

  it('⭐ PAR/QUASE-PAR: o ponto só é recusado num DECIMAL — num texto, `1.5` é um texto como outro', () => {
    const r = aceita(editar({ arvore: CANECA, lista: null }, 100999, texto('1.5')));
    expect(r.lista).toEqual([at(100999, { value_id: 0, original_value_name: '1.5' })]);
  });

  it('⭐ PAR/QUASE-PAR: inteiro (ivt 1) — o validador decide: `15` e ` 15 ` valem ⟷ `1,5` bloqueia', () => {
    const e: Estado = { arvore: SINTETICA, lista: null };
    expect(aceita(editar(e, 900007, texto('15'))).lista).toEqual([
      at(900007, { value_id: 0, original_value_name: '15' }),
    ]);
    expect(aceita(editar(e, 900007, texto(' 15 '))).lista).toEqual([
      at(900007, { value_id: 0, original_value_name: ' 15 ' }),
    ]);
    const r = aceita(editar(e, 900007, texto('1,5')));
    expect(r.lista).toBeNull();
    expect(r.digitacoes['900007']?.motivo).toBe(MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.tipoDeValor);
  });

  it('a digitação que bloqueia aparece na linha com o texto cru e o motivo', () => {
    const r = aceita(editar(vazio, 101029, texto('1.5', 'KG')));
    const l = linha({ arvore: CAPA, lista: r.lista, digitacoes: r.digitacoes }, 101029);
    expect([l.textoDigitado, l.unidadeDigitada, l.digitacao]).toEqual([
      '1.5',
      'KG',
      MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.tipoDeValor,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                    (4) A single list + «Outro valor» (type 2)               */
/* -------------------------------------------------------------------------- */

describe('aplicarEdicaoDoAtributoShopee — lista única e «Outro valor»', () => {
  const e: Estado = { arvore: SINTETICA, lista: null };

  it('⭐ PAR/QUASE-PAR: «Outro valor» `Plástico` (um rótulo da lista) fica PERSONALIZADO ⟷ escolher «Plástico» é `{value_id: 1207}`', () => {
    expect(aceita(editar(e, 900008, texto('Plástico'))).lista).toEqual([
      at(900008, { value_id: 0, original_value_name: 'Plástico' }),
    ]);
    expect(aceita(editar(e, 900008, escolher([1207]))).lista).toEqual([
      at(900008, { value_id: 1207 }),
    ]);
  });

  it('o mesmo no composer múltiplo de 100134: `Plástico` digitado não vira o 1207', () => {
    const r = aceita(editar({ arvore: CANECA, lista: null }, 100134, adicionar('Plástico')));
    expect(r.lista).toEqual([at(100134, { value_id: 0, original_value_name: 'Plástico' })]);
  });

  it('escolher da lista troca o personalizado; digitar troca o valor da lista (um valor só)', () => {
    const r1 = emSequencia(e, [
      [900008, texto('Bambu')],
      [900008, escolher([1218])],
    ]);
    expect(r1.lista).toEqual([at(900008, { value_id: 1218 })]);
    const r2 = emSequencia(e, [
      [900008, escolher([1218])],
      [900008, texto('Bambu')],
    ]);
    expect(r2.lista).toEqual([at(900008, { value_id: 0, original_value_name: 'Bambu' })]);
  });

  it('«Outro valor» aparece com um personalizado ou uma digitação ⟷ não com um valor da lista', () => {
    const comPersonalizado = aceita(editar(e, 900008, texto('Bambu')));
    expect(linha({ ...e, lista: comPersonalizado.lista }, 900008).outroValor).toBe(true);
    const comLista = aceita(editar(e, 900008, escolher([1218])));
    expect(linha({ ...e, lista: comLista.lista }, 900008).outroValor).toBe(false);
  });

  it('`valueIds: []` limpa o valor e a digitação da linha', () => {
    const peso: Estado = { arvore: CAFE, lista: null };
    const r = emSequencia(peso, [
      [100095, texto('1,', 'kg')],
      [100095, escolher([])],
    ]);
    expect(r.lista).toBeNull();
    expect(r.digitacoes).toEqual({});
  });

  it('⭐ 100095 «Outro valor» `1,5` + `kg` ⇒ `{0, "1.5", "kg"}` ⟷ `KG` bloqueia (a lista diz `kg`)', () => {
    const peso: Estado = { arvore: CAFE, lista: null };
    expect(aceita(editar(peso, 100095, texto('1,5', 'kg'))).lista).toEqual([
      at(100095, { value_id: 0, original_value_name: '1.5', value_unit: 'kg' }),
    ]);
    const r = aceita(editar(peso, 100095, texto('1,5', 'KG')));
    expect(r.lista).toBeNull();
    expect(r.digitacoes['100095']?.motivo).toBe(MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.unidadeInvalida);
  });

  it('a escolha num `Select` único, com dois ids, é recusada (`valores-demais`)', () => {
    const r = editar({ arvore: CAPA, lista: null }, 100408, escolher([COM_FIO, SEM_FIO]));
    expect(r).toEqual({ ok: false, motivo: MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.valoresDemais });
  });
});

/* -------------------------------------------------------------------------- */
/*                              (5) Children                                   */
/* -------------------------------------------------------------------------- */

describe('filhos — só sob o valor ESCOLHIDO (o walk da schemas)', () => {
  it('⭐ PAR: 2530 escolhido ⇒ os 3 filhos, logo abaixo do pai, profundidade 1, com o pai e o valor', () => {
    const r = aceita(editar({ arvore: CAPA, lista: null }, 100408, escolher([SEM_FIO])));
    const e: Estado = { arvore: CAPA, lista: r.lista };
    expect(ids(e)).toEqual([100408, 101237, 101197, 101040, 100134, 101029]);
    const fabricante = linha(e, 101237);
    expect(fabricante.profundidade).toBe(1);
    expect(fabricante.obrigatorio).toBe(true);
    expect(fabricante.pai).toEqual({
      attributeId: 100408,
      rotulo: 'Tipo de Conexão',
      valueId: SEM_FIO,
      valor: ROTULO_SEM_FIO,
    });
    expect(fabricante.nome).toBe(`Fabricante (em Tipo de Conexão: ${ROTULO_SEM_FIO})`);
    expect(linha(e, 100408).profundidade).toBe(0);
    expect(linha(e, 100408).pai).toBeNull();
  });

  it('⭐ QUASE-PAR: 2498 escolhido ⇒ nenhum filho', () => {
    const r = aceita(editar({ arvore: CAPA, lista: null }, 100408, escolher([COM_FIO])));
    expect(ids({ arvore: CAPA, lista: r.lista })).toEqual([100408, 100134, 101029]);
  });

  it('as pendências obrigatórias dos filhos aparecem nas linhas (obrigatorio-ausente)', () => {
    const e: Estado = { arvore: CAPA, lista: [at(100408, { value_id: SEM_FIO })] };
    expect(linha(e, 101197).problemas).toEqual([
      {
        tipo: TIPO_PROBLEMA_ATRIBUTO_SHOPEE.obrigatorioAusente,
        valor: null,
        unidade: null,
        maximo: null,
      },
    ]);
  });

  it('⭐ trocar 2530 → 2498 tira os valores dos filhos e os lista em «Serão removidos ao salvar»', () => {
    const guardados = [
      at(100408, { value_id: SEM_FIO }),
      at(101237, { value_id: 0, original_value_name: 'Fabricante Inventado' }),
      at(101197, { value_id: 0, original_value_name: '00000-00-00000' }),
      at(101040, { value_id: 0, original_value_name: 'Modelo Inventado' }),
    ];
    const r = aceita(
      editar({ arvore: CAPA, lista: guardados, guardados }, 100408, escolher([COM_FIO])),
    );
    expect(r.lista).toEqual([at(100408, { value_id: COM_FIO })]);
    const removidos = editor({ arvore: CAPA, lista: r.lista, guardados }).removidosAoSalvar;
    expect(removidos.map((x) => [x.attributeId, x.rotulo, x.inteiro])).toEqual([
      [101237, 'Fabricante', true],
      [101197, 'Nr. de Homologação', true],
      [101040, 'Nome do Modelo', true],
    ]);
  });

  it('⭐ PAR/QUASE-PAR: a digitação que bloqueia num filho que some sai ⟷ a de uma raiz visível fica', () => {
    const r = emSequencia({ arvore: SINTETICA, lista: null }, [
      [900010, escolher([900110])],
      [900011, texto('1,5')], // the child: no unit ⇒ blocking
      [900007, texto('1,5')], // a root integer ⇒ blocking
    ]);
    expect(Object.keys(r.digitacoes).sort()).toEqual(['900007', '900011']);
    const depois = aceita(
      editar(
        { arvore: SINTETICA, lista: r.lista, digitacoes: r.digitacoes },
        900010,
        escolher([900111]),
      ),
    );
    expect(Object.keys(depois.digitacoes)).toEqual(['900007']);
    expect(digitacoesBloqueiam(depois.digitacoes)).toBe(true);
  });

  it('⭐ PAR: o pai OPCIONAL 106664 = 20996 «Sim» mostra 3 filhos obrigatórios', () => {
    const r = aceita(editar({ arvore: ANUNCIO, lista: null }, 106664, escolher([SIM])));
    const e: Estado = { arvore: ANUNCIO, lista: r.lista };
    expect(ids(e)).toEqual([100022, 100413, 101639, 106664, 101040, 101237, 101197]);
    expect(
      editor(e)
        .linhas.filter((l) => l.profundidade === 1)
        .every((l) => l.obrigatorio),
    ).toBe(true);
    expect(linha(e, 106664).obrigatorio).toBe(false);
  });

  it('⭐ QUASE-PAR: 106664 sem valor ⇒ nenhum filho; 20997 «Não» ⇒ nenhum filho', () => {
    expect(ids({ arvore: ANUNCIO, lista: null })).toEqual([100022, 100413, 101639, 106664]);
    const nao = aceita(editar({ arvore: ANUNCIO, lista: null }, 106664, escolher([20997])));
    expect(ids({ arvore: ANUNCIO, lista: nao.lista })).toEqual([100022, 100413, 101639, 106664]);
  });

  it('⭐ PAR/QUASE-PAR: um personalizado no pai não destrava nada ⟷ o valor da lista destrava', () => {
    const e: Estado = { arvore: SINTETICA, lista: null };
    const personalizado = aceita(editar(e, 900010, texto('Abre')));
    expect(ids({ ...e, lista: personalizado.lista })).not.toContain(900011);
    const daLista = aceita(editar(e, 900010, escolher([900110])));
    expect(ids({ ...e, lista: daLista.lista })).toContain(900011);
  });

  it('um personalizado guardado num pai tipo 1 não destrava nada e aparece como `personalizado-nao-permitido`', () => {
    const e: Estado = {
      arvore: CAPA,
      lista: [at(100408, { value_id: 0, original_value_name: ROTULO_SEM_FIO })],
    };
    expect(ids(e)).toEqual([100408, 100134, 101029]);
    expect(linha(e, 100408).problemas).toEqual([
      {
        tipo: TIPO_PROBLEMA_ATRIBUTO_SHOPEE.personalizadoNaoPermitido,
        valor: ROTULO_SEM_FIO,
        unidade: null,
        maximo: null,
      },
    ]);
  });

  it('uma edição num filho que o walk não mostra não faz nada', () => {
    const e: Estado = { arvore: CAPA, lista: [at(100408, { value_id: COM_FIO })] };
    const r = editar(e, 101237, texto('Fabricante Inventado'));
    expect(r).toEqual({ ok: true, lista: e.lista, digitacoes: {} });
  });
});

/* -------------------------------------------------------------------------- */
/*                       (6) Multiple values and the cap                       */
/* -------------------------------------------------------------------------- */

describe('valores múltiplos e `max_value_count` (inclusivo)', () => {
  it('⭐ PAR/QUASE-PAR: 100278 aceita o 5º valor do composer ⟷ recusa o 6º, sem mudar nada', () => {
    const e: Estado = { arvore: CANECA, lista: null };
    const cinco = emSequencia(e, [
      [100278, adicionar('1', 'L')],
      [100278, adicionar('2', 'L')],
      [100278, adicionar('3', 'L')],
      [100278, adicionar('4', 'L')],
    ]);
    expect(linha({ ...e, lista: cinco.lista }, 100278).podeAdicionar).toBe(true);
    const quinto = aceita(editar({ ...e, lista: cinco.lista }, 100278, adicionar('5', 'L')));
    expect(quinto.lista?.[0]?.attribute_value_list).toHaveLength(5);
    expect(linha({ ...e, lista: quinto.lista }, 100278).podeAdicionar).toBe(false);
    expect(editar({ ...e, lista: quinto.lista }, 100278, adicionar('6', 'L'))).toEqual({
      ok: false,
      motivo: MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.valoresDemais,
    });
  });

  it('⭐ o limite do MultiSelect de 100134 é max menos os personalizados', () => {
    const e: Estado = { arvore: CANECA, lista: null };
    expect(linha(e, 100134).maxEscolhas).toBe(5);
    const dois = emSequencia(e, [
      [100134, adicionar('Bambu')],
      [100134, adicionar('Cortiça')],
    ]);
    expect(linha({ ...e, lista: dois.lista }, 100134).maxEscolhas).toBe(3);
    expect(linha({ arvore: SINTETICA, lista: null }, 900001).maxEscolhas).toBe(3);
    expect(linha({ arvore: CAPA, lista: null }, 100408).maxEscolhas).toBeNull();
  });

  it('⭐ PAR: num `lista-multipla` (tipo 4) um personalizado GUARDADO (apontado) sai pelo `remover-personalizado` — e vai a «Serão removidos ao salvar» — e conta no limite do MultiSelect ⟷ QUASE-PAR: escolher da lista o MANTÉM, enquanto num `lista-unica` (100408) a escolha o troca', () => {
    const guardados = [at(900001, { value_id: 0, original_value_name: 'Outro' })];
    const e: Estado = { arvore: SINTETICA, lista: guardados, guardados };
    expect(linha(e, 900001).problemas.map((p) => p.tipo)).toEqual([
      TIPO_PROBLEMA_ATRIBUTO_SHOPEE.personalizadoNaoPermitido,
    ]);
    expect(linha(e, 900001).maxEscolhas).toBe(2);
    const removido = aceita(editar(e, 900001, { tipo: 'remover-personalizado', indice: 0 }));
    expect(removido.lista).toBeNull();
    expect(
      editor({ ...e, lista: removido.lista }).removidosAoSalvar.map((i) => i.attributeId),
    ).toEqual([900001]);

    const escolhido = aceita(editar(e, 900001, escolher([900101])));
    expect(escolhido.lista).toEqual([
      at(900001, { value_id: 0, original_value_name: 'Outro' }, { value_id: 900101 }),
    ]);
    const unica = [at(100408, { value_id: 0, original_value_name: 'Outro' })];
    expect(
      aceita(editar({ arvore: CAPA, lista: unica, guardados: unica }, 100408, escolher([COM_FIO])))
        .lista,
    ).toEqual([at(100408, { value_id: COM_FIO })]);
    // Nothing ADDS a custom value on a list-only control.
    expect(editar(e, 900001, adicionar('Mais'))).toEqual({
      ok: true,
      lista: guardados,
      digitacoes: {},
    });
  });

  it('⭐ PAR/QUASE-PAR: escolher além do max (tipo 4) é recusado ⟷ reduzir uma lista guardada acima do max é aceito', () => {
    const e: Estado = { arvore: SINTETICA, lista: null };
    expect(editar(e, 900001, escolher([900101, 900102, 900103, 900104]))).toEqual({
      ok: false,
      motivo: MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.valoresDemais,
    });
    expect(aceita(editar(e, 900001, escolher([900101, 900102, 900103]))).lista).toEqual([
      at(900001, { value_id: 900101 }, { value_id: 900102 }, { value_id: 900103 }),
    ]);
    // Stored over the cap (5 on a max of 3, one of them an id the list lost):
    // reducing to 4 is still over the cap, and is accepted — it is carried.
    const acima = [
      at(
        900001,
        { value_id: 900101 },
        { value_id: 900102 },
        { value_id: 900103 },
        { value_id: 900104 },
        { value_id: 999999 },
      ),
    ];
    const reduzida = aceita(
      editar(
        { ...e, lista: acima, guardados: acima },
        900001,
        escolher([900101, 900102, 900103, 900104]),
      ),
    );
    expect(reduzida.lista?.[0]?.attribute_value_list).toHaveLength(4);
    // Near miss: from the same over-cap state, GROWING (4 ⇒ 5) is authoring.
    const quatro = [
      at(
        900001,
        { value_id: 900101 },
        { value_id: 900102 },
        { value_id: 900103 },
        { value_id: 999999 },
      ),
    ];
    expect(
      editar(
        { ...e, lista: quatro, guardados: quatro },
        900001,
        escolher([900101, 900102, 900103, 900104, 999999]),
      ),
    ).toEqual({ ok: false, motivo: MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.valoresDemais });
  });

  it('a mensagem de `valores-demais` diz o limite: 1 numa escolha única, max numa múltipla', () => {
    const unica = linha(
      { arvore: CAPA, lista: [at(100408, { value_id: COM_FIO }, { value_id: SEM_FIO })] },
      100408,
    );
    expect(unica.problemas).toContainEqual({
      tipo: TIPO_PROBLEMA_ATRIBUTO_SHOPEE.valoresDemais,
      valor: null,
      unidade: null,
      maximo: 1,
    });
    const multipla = linha(
      {
        arvore: SINTETICA,
        lista: [
          at(
            900001,
            { value_id: 900101 },
            { value_id: 900102 },
            { value_id: 900103 },
            { value_id: 900104 },
          ),
        ],
      },
      900001,
    );
    expect(multipla.problemas).toEqual([
      { tipo: TIPO_PROBLEMA_ATRIBUTO_SHOPEE.valoresDemais, valor: null, unidade: null, maximo: 3 },
    ]);
  });

  it('escolher na lista múltipla mantém os personalizados', () => {
    const r = emSequencia({ arvore: CANECA, lista: null }, [
      [100134, adicionar('Bambu')],
      [100134, escolher([1218])],
      [100134, escolher([1218, 1207])],
    ]);
    expect(r.lista).toEqual([
      at(
        100134,
        { value_id: 0, original_value_name: 'Bambu' },
        { value_id: 1218 },
        { value_id: 1207 },
      ),
    ]);
  });

  it('⭐ PAR/QUASE-PAR: um id fora da lista nunca é escrito ⟷ um id GUARDADO devolvido pelo componente fica', () => {
    const e: Estado = { arvore: CANECA, lista: null };
    expect(aceita(editar(e, 100134, escolher([999999]))).lista).toBeNull();
    const velho = [at(100134, { value_id: 999999 })];
    const r = aceita(
      editar({ ...e, lista: velho, guardados: velho }, 100134, escolher([999999, 1207])),
    );
    expect(r.lista).toEqual([at(100134, { value_id: 999999 }, { value_id: 1207 })]);
  });

  it('`vazio`: o composer recusa um texto em branco', () => {
    expect(editar({ arvore: CANECA, lista: null }, 100134, adicionar('   '))).toEqual({
      ok: false,
      motivo: MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.vazio,
    });
  });

  it('⭐ PAR: `repetido` — `Algodão ` é o mesmo que `Algodão` já guardado', () => {
    const e: Estado = {
      arvore: CANECA,
      lista: [at(100134, { value_id: 0, original_value_name: 'Algodão' })],
    };
    expect(editar(e, 100134, adicionar('Algodão '))).toEqual({
      ok: false,
      motivo: MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.repetido,
    });
  });

  it('⭐ QUASE-PAR: `algodão` (outra caixa) é OUTRO valor', () => {
    const e: Estado = {
      arvore: CANECA,
      lista: [at(100134, { value_id: 0, original_value_name: 'Algodão' })],
    };
    expect(
      aceita(editar(e, 100134, adicionar('algodão'))).lista?.[0]?.attribute_value_list,
    ).toEqual([
      { value_id: 0, original_value_name: 'Algodão' },
      { value_id: 0, original_value_name: 'algodão' },
    ]);
  });

  it('⭐ PAR/QUASE-PAR: `1,5 L` repete um `1.5 L` guardado ⟷ `1,50 L` e `1,5 ml` são outros (#1372)', () => {
    const e: Estado = {
      arvore: CANECA,
      lista: [at(100278, { value_id: 0, original_value_name: '1.5', value_unit: 'L' })],
    };
    expect(editar(e, 100278, adicionar('1,5', 'L'))).toEqual({
      ok: false,
      motivo: MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.repetido,
    });
    expect(
      aceita(editar(e, 100278, adicionar('1,50', 'L'))).lista?.[0]?.attribute_value_list,
    ).toEqual([
      { value_id: 0, original_value_name: '1.5', value_unit: 'L' },
      { value_id: 0, original_value_name: '1.50', value_unit: 'L' },
    ]);
    expect(
      aceita(editar(e, 100278, adicionar('1,5', 'ml'))).lista?.[0]?.attribute_value_list,
    ).toHaveLength(2);
  });

  it('o composer de um decimal recusa o ponto e exige a unidade', () => {
    const e: Estado = { arvore: CANECA, lista: null };
    expect(editar(e, 100278, adicionar('1.5', 'L'))).toEqual({
      ok: false,
      motivo: MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.tipoDeValor,
    });
    expect(editar(e, 100278, adicionar('1,5'))).toEqual({
      ok: false,
      motivo: MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.unidadeInvalida,
    });
  });

  it('⭐ PAR/QUASE-PAR: remover um chip GUARDADO vai para «Serão removidos» (parcial) ⟷ um chip nunca guardado não', () => {
    const guardados = [
      at(100134, { value_id: 1207 }, { value_id: 0, original_value_name: 'Bambu' }),
    ];
    const r = aceita(
      editar({ arvore: CANECA, lista: guardados, guardados }, 100134, {
        tipo: 'remover-personalizado',
        indice: 0,
      }),
    );
    expect(r.lista).toEqual([at(100134, { value_id: 1207 })]);
    expect(editor({ arvore: CANECA, lista: r.lista, guardados }).removidosAoSalvar).toEqual([
      {
        attributeId: 100134,
        rotulo: 'Material',
        inteiro: false,
        motivo: null,
        valores: [
          {
            valor: { value_id: 0, original_value_name: 'Bambu' },
            personalizado: true,
            rotulo: 'Bambu',
            unidade: null,
            indicePersonalizado: null,
          },
        ],
      },
    ]);
    const novo = emSequencia({ arvore: CANECA, lista: guardados, guardados }, [
      [100134, adicionar('Cortiça')],
      [100134, { tipo: 'remover-personalizado', indice: 1 }],
    ]);
    expect(novo.lista).toEqual(guardados);
    expect(editor({ arvore: CANECA, lista: novo.lista, guardados }).removidosAoSalvar).toEqual([]);
  });

  it('o índice conta só os personalizados; fora do intervalo não muda nada', () => {
    const e: Estado = {
      arvore: CANECA,
      lista: [
        at(
          100134,
          { value_id: 0, original_value_name: 'A' },
          { value_id: 1207 },
          { value_id: 0, original_value_name: 'B' },
        ),
      ],
    };
    const l = linha(e, 100134);
    expect(l.valores.map((v) => v.indicePersonalizado)).toEqual([0, null, 1]);
    expect(aceita(editar(e, 100134, { tipo: 'remover-personalizado', indice: 1 })).lista).toEqual([
      at(100134, { value_id: 0, original_value_name: 'A' }, { value_id: 1207 }),
    ]);
    expect(editar(e, 100134, { tipo: 'remover-personalizado', indice: 2 })).toEqual({
      ok: true,
      lista: e.lista,
      digitacoes: {},
    });
  });

  it('desmarcar um valor da lista GUARDADO num múltiplo também vai para «Serão removidos» ⟷ trocar o valor de um único não', () => {
    const guardados = [at(100134, { value_id: 1207 }, { value_id: 1218 })];
    const r = aceita(
      editar({ arvore: CANECA, lista: guardados, guardados }, 100134, escolher([1218])),
    );
    const removidos = editor({ arvore: CANECA, lista: r.lista, guardados }).removidosAoSalvar;
    expect(
      removidos.map((x) => [x.attributeId, x.inteiro, x.valores.map((v) => v.rotulo)]),
    ).toEqual([[100134, false, ['Plástico']]]);
    const unico = [at(100037, { value_id: 6737 })];
    const trocado = aceita(
      editar({ arvore: CANECA, lista: unico, guardados: unico }, 100037, escolher([35])),
    );
    expect(
      editor({ arvore: CANECA, lista: trocado.lista, guardados: unico }).removidosAoSalvar,
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                         (7) The base-relative order                         */
/* -------------------------------------------------------------------------- */

describe('a ordem relativa à base — nunca uma igualdade, mas sem sujeira fantasma', () => {
  const guardados = [
    at(100037, { value_id: 6737 }),
    at(100134, { value_id: 1207 }, { value_id: 0, original_value_name: 'x' }),
  ];
  const e: Estado = { arvore: CANECA, lista: guardados, guardados };

  it('⭐ escolher 35 e depois 6737 de novo devolve os BYTES da base', () => {
    const r = emSequencia(e, [
      [100037, escolher([35])],
      [100037, escolher([6737])],
    ]);
    expect(JSON.stringify(r.lista)).toBe(JSON.stringify(guardados));
  });

  it('⭐ PAR: tirar o 1207 e pô-lo de volta devolve a ordem da base', () => {
    const r = emSequencia(e, [
      [100134, escolher([])],
      [100134, escolher([1207])],
    ]);
    expect(JSON.stringify(r.lista)).toBe(JSON.stringify(guardados));
  });

  /** The custom value FIRST, so a re-add appended at the end would show. */
  const xPrimeiro = [at(100134, { value_id: 0, original_value_name: 'x' }, { value_id: 1207 })];
  const comXPrimeiro: Estado = { arvore: CANECA, lista: xPrimeiro, guardados: xPrimeiro };

  it('⭐ PAR: remover o `x` e readicionar `x ` (a mesma leitura) volta ao lugar da base, no 1º', () => {
    const r = emSequencia(comXPrimeiro, [
      [100134, { tipo: 'remover-personalizado', indice: 0 }],
      [100134, adicionar('x ')],
    ]);
    expect(r.lista?.[0]?.attribute_value_list).toEqual([
      { value_id: 0, original_value_name: 'x ' },
      { value_id: 1207 },
    ]);
  });

  const removerX = { tipo: 'remover-personalizado', indice: 0 } as const;

  it('⭐ PAR: remover o `x` e readicionar `x ` (a mesma leitura) não lista nada em «Serão removidos ao salvar»', () => {
    const r = emSequencia(comXPrimeiro, [
      [100134, removerX],
      [100134, adicionar('x ')],
    ]);
    expect(editor({ ...comXPrimeiro, lista: r.lista }).removidosAoSalvar).toEqual([]);
  });

  it('⭐ QUASE-PAR: readicionar `X` (outra caixa) deixa o `x` guardado em «Serão removidos ao salvar»', () => {
    const r = emSequencia(comXPrimeiro, [
      [100134, removerX],
      [100134, adicionar('X')],
    ]);
    expect(
      editor({ ...comXPrimeiro, lista: r.lista }).removidosAoSalvar.map((i) => [
        i.attributeId,
        i.inteiro,
        i.valores.map((v) => v.rotulo),
      ]),
    ).toEqual([[100134, false, ['x']]]);
  });

  const decimal = [at(100278, { value_id: 0, original_value_name: '1.5', value_unit: 'L' })];
  const comDecimal: Estado = { arvore: CANECA, lista: decimal, guardados: decimal };

  it('⭐ PAR: remover o `1.5 L` e adicionar `1,5` L não lista nada em «Serão removidos ao salvar»', () => {
    const r = emSequencia(comDecimal, [
      [100278, removerX],
      [100278, adicionar('1,5', 'L')],
    ]);
    expect(editor({ ...comDecimal, lista: r.lista }).removidosAoSalvar).toEqual([]);
  });

  it('⭐ QUASE-PAR: adicionar `1,50` L no lugar do `1.5 L` lista o `1,5 L` em «Serão removidos ao salvar» — nunca dobrado num número (#1372)', () => {
    const r = emSequencia(comDecimal, [
      [100278, removerX],
      [100278, adicionar('1,50', 'L')],
    ]);
    expect(
      editor({ ...comDecimal, lista: r.lista }).removidosAoSalvar.map((i) => [
        i.attributeId,
        i.inteiro,
        i.valores.map((v) => [v.rotulo, v.unidade]),
      ]),
    ).toEqual([[100278, false, [['1,5', 'L']]]]);
  });

  it('⭐ QUASE-PAR: readicionar `X` (outra caixa) é um valor NOVO, no fim', () => {
    const r = emSequencia(comXPrimeiro, [
      [100134, { tipo: 'remover-personalizado', indice: 0 }],
      [100134, adicionar('X')],
    ]);
    expect(r.lista?.[0]?.attribute_value_list).toEqual([
      { value_id: 1207 },
      { value_id: 0, original_value_name: 'X' },
    ]);
  });

  it('⭐ PAR/QUASE-PAR: a ordem dos ATRIBUTOS da base fica ⟷ sem base, a do walk', () => {
    const invertidos = [at(100134, { value_id: 1207 }), at(100037, { value_id: 6737 })];
    const comBase = aceita(
      editar({ arvore: CANECA, lista: invertidos, guardados: invertidos }, 100037, escolher([35])),
    );
    expect(comBase.lista?.map((x) => x.attribute_id)).toEqual([100134, 100037]);
    const semBase = aceita(editar({ arvore: CANECA, lista: invertidos }, 100037, escolher([35])));
    expect(semBase.lista?.map((x) => x.attribute_id)).toEqual([100037, 100134]);
  });

  it('os atributos novos seguem os da base, na ordem do walk', () => {
    const r = emSequencia(e, [
      [101029, texto('2', 'KG')],
      [100999, texto('3')],
    ]);
    expect(r.lista?.map((x) => x.attribute_id)).toEqual([100037, 100134, 100999, 101029]);
  });

  it('⭐ PAR/QUASE-PAR: reescolher um `{640, "kg"}` importado reusa o objeto GUARDADO ⟷ escolher 646 dá `{value_id: 646}`', () => {
    const importado = [at(100095, { value_id: 640, value_unit: 'kg' })];
    const cafe: Estado = { arvore: CAFE, lista: importado, guardados: importado };
    const reescolhido = emSequencia(cafe, [
      [100095, escolher([631])],
      [100095, escolher([640])],
    ]);
    expect(JSON.stringify(reescolhido.lista)).toBe(JSON.stringify(importado));
    expect(aceita(editar(cafe, 100095, escolher([646]))).lista).toEqual([
      at(100095, { value_id: 646 }),
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                   (8) Orphans, the save filter, truncation                  */
/* -------------------------------------------------------------------------- */

describe('«sem lugar»: listados ao abrir, removidos só por uma edição', () => {
  const ORFAO = 999001;
  const guardados = [
    at(100037, { value_id: 6737 }),
    at(ORFAO, { value_id: 0, original_value_name: 'Algo de outra categoria' }),
  ];
  const e: Estado = { arvore: CANECA, lista: guardados, guardados };

  it('⭐ ao abrir: o `fora-da-categoria` está em `semLugar`, e nada vai ser removido', () => {
    const ed = editor(e);
    expect(ed.semLugar).toEqual([
      {
        attributeId: ORFAO,
        rotulo: `#${String(ORFAO)}`,
        inteiro: true,
        motivo: TIPO_PROBLEMA_ATRIBUTO_SHOPEE.foraDaCategoria,
        valores: [
          {
            valor: { value_id: 0, original_value_name: 'Algo de outra categoria' },
            personalizado: true,
            rotulo: 'Algo de outra categoria',
            unidade: null,
            indicePersonalizado: null,
          },
        ],
      },
    ]);
    expect(ed.removidosAoSalvar).toEqual([]);
    expect(ed.linhas.map((l) => l.attributeId)).not.toContain(ORFAO);
  });

  it('um filho guardado sob um valor NÃO escolhido é `filho-sem-pai`, com o nome da árvore', () => {
    const filho = [
      at(100408, { value_id: COM_FIO }),
      at(101237, { value_id: 0, original_value_name: 'Fabricante Inventado' }),
    ];
    expect(editor({ arvore: CAPA, lista: filho, guardados: filho }).semLugar).toEqual([
      expect.objectContaining({
        attributeId: 101237,
        rotulo: 'Fabricante',
        motivo: TIPO_PROBLEMA_ATRIBUTO_SHOPEE.filhoSemPai,
      }),
    ]);
  });

  it('⭐ «Marcar para remover» tira os sem lugar e os põe em «Serão removidos ao salvar»', () => {
    const r = aceita(editar(e, 0, { tipo: 'remover-sem-lugar' }));
    expect(r.lista).toEqual([at(100037, { value_id: 6737 })]);
    const ed = editor({ ...e, lista: r.lista });
    expect(ed.semLugar).toEqual([]);
    expect(ed.removidosAoSalvar.map((x) => [x.attributeId, x.inteiro])).toEqual([[ORFAO, true]]);
  });

  it('⭐ qualquer outra edição também os tira (e os lista)', () => {
    const r = aceita(editar(e, 100999, texto('3')));
    expect(r.lista?.map((x) => x.attribute_id)).toEqual([100037, 100999]);
    expect(editor({ ...e, lista: r.lista }).removidosAoSalvar.map((x) => x.attributeId)).toEqual([
      ORFAO,
    ]);
  });

  it('⭐ PAR/QUASE-PAR: numa árvore TRUNCADA eles ficam numa edição, e não aparecem como sem lugar', () => {
    const truncada: Estado = { ...e, arvore: { ...CANECA, truncated: true } };
    expect(editor(truncada).semLugar).toEqual([]);
    const r = aceita(editar(truncada, 100999, texto('3')));
    expect(r.lista?.map((x) => x.attribute_id)).toEqual([100037, ORFAO, 100999]);
    expect(aceita(editar(truncada, 0, { tipo: 'remover-sem-lugar' })).lista).toEqual(guardados);
  });

  it('⛔ numa árvore TRUNCADA um id que nenhuma escrita aceita (`-3`) É listado sem lugar — «Marcar para remover» o põe em «Serão removidos ao salvar» ⟷ QUASE-PAR: um id POSITIVO escondido não é listado (a gravação o carrega)', () => {
    const legado = [
      { attribute_id: -3, attribute_value_list: [{ value_id: 0, original_value_name: 'x' }] },
      at(100037, { value_id: 6737 }),
    ];
    const truncada: Estado = {
      arvore: { ...CANECA, truncated: true },
      lista: legado,
      guardados: legado,
    };
    expect(editor(truncada).semLugar.map((x) => x.attributeId)).toEqual([-3]);
    const r = aceita(editar(truncada, 0, { tipo: 'remover-sem-lugar' }));
    expect(r.lista).toEqual([at(100037, { value_id: 6737 })]);
    gravavel(r.lista);
    expect(
      editor({ ...truncada, lista: r.lista }).removidosAoSalvar.map((x) => x.attributeId),
    ).toEqual([-3]);

    expect(editor({ ...e, arvore: { ...CANECA, truncated: true } }).semLugar).toEqual([]);
  });

  it('⭐ PAR/QUASE-PAR: um id legado `-3` intocado fica ⟷ editado numa árvore completa, o walk o tira', () => {
    const legado = [
      { attribute_id: -3, attribute_value_list: [{ value_id: 1 }] },
      at(100037, { value_id: 6737 }),
    ];
    expect(
      editor({ arvore: CANECA, lista: legado, guardados: legado }).semLugar.map(
        (x) => x.attributeId,
      ),
    ).toEqual([-3]);
    const r = aceita(
      editar({ arvore: CANECA, lista: legado, guardados: legado }, 100037, escolher([35])),
    );
    expect(r.lista).toEqual([at(100037, { value_id: 35 })]);
    gravavel(r.lista);
  });

  it('«Marcar para remover» sem lista não faz nada', () => {
    expect(editar({ arvore: CANECA, lista: null }, 0, { tipo: 'remover-sem-lugar' })).toEqual({
      ok: true,
      lista: null,
      digitacoes: {},
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                             (9) Empty ⇒ null                                */
/* -------------------------------------------------------------------------- */

describe('lista vazia ⇒ `null`, salvo quando a base é ela mesma `[]`', () => {
  it('⭐ PAR: sem base, escolher e desescolher volta a `null` (limpo)', () => {
    const r = emSequencia({ arvore: CAPA, lista: null }, [
      [100408, escolher([COM_FIO])],
      [100408, escolher([])],
    ]);
    expect(r.lista).toBeNull();
  });

  it('⭐ QUASE-PAR: com a base `[]`, o mesmo volta a `[]`', () => {
    const r = emSequencia({ arvore: CAPA, lista: [], guardados: [] }, [
      [100408, escolher([COM_FIO])],
      [100408, escolher([])],
    ]);
    expect(r.lista).toEqual([]);
  });

  it('esvaziar uma base com valores dá `null` (limpa o guardado, como a troca de categoria)', () => {
    const guardados = [at(100408, { value_id: COM_FIO })];
    expect(
      aceita(editar({ arvore: CAPA, lista: guardados, guardados }, 100408, escolher([]))).lista,
    ).toBeNull();
  });

  it('depois da troca de categoria (`lista: null` sobre uma base cheia), tudo da base vai ser removido', () => {
    const guardados = [
      at(100408, { value_id: COM_FIO }),
      at(999002, { value_id: 0, original_value_name: 'y' }),
    ];
    const ed = editor({ arvore: CAPA, lista: null, guardados });
    expect(ed.removidosAoSalvar.map((x) => [x.attributeId, x.rotulo, x.inteiro])).toEqual([
      [100408, 'Tipo de Conexão', true],
      [999002, '#999002', true],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*             (10) Edits that do not apply, and carried values                */
/* -------------------------------------------------------------------------- */

describe('edições que não se aplicam, e o que é só carregado', () => {
  it.each([
    ['`texto` numa lista só', CAPA, 100408, texto('Sem fio')],
    ['`lista` num texto', CANECA, 100999, escolher([1])],
    ['`adicionar` num único', CANECA, 100037, adicionar('x')],
    [
      '`remover-personalizado` num único',
      CANECA,
      100037,
      { tipo: 'remover-personalizado', indice: 0 } as const,
    ],
    ['um id que a árvore não tem', CANECA, 424242, escolher([1])],
  ])('%s ⇒ a entrada volta igual, sem filtro', (_, arv, id, edicao) => {
    const guardados = [
      at(100037, { value_id: 6737 }),
      at(999003, { value_id: 0, original_value_name: 'o' }),
    ];
    const digitacoes: DigitacoesAtributosShopee = {
      '101029': { texto: '', unidade: 'KG', motivo: null },
    };
    const r = editar({ arvore: arv, lista: guardados, guardados, digitacoes }, id, edicao);
    expect(r).toEqual({ ok: true, lista: guardados, digitacoes });
    if (r.ok) {
      expect(r.lista).toBe(guardados);
      expect(r.digitacoes).toBe(digitacoes);
    }
  });

  it('⭐ «não suportado» (data): mostra o guardado, não se edita, e é carregado intacto', () => {
    const guardados = [
      at(900002, { value_id: 0, original_value_name: '06/2021' }),
      at(100037, { value_id: 6737 }),
    ];
    const e: Estado = { arvore: SINTETICA, lista: guardados, guardados };
    const l = linha(e, 900002);
    expect(l.controle).toEqual({ tipo: 'nao-suportado', motivo: 'data' });
    expect(l.valores.map((v) => v.rotulo)).toEqual(['06/2021']);
    expect(l.problemas.map((p) => [p.tipo, p.valor])).toEqual([
      [TIPO_PROBLEMA_ATRIBUTO_SHOPEE.dataEmFormatoDeLeitura, '06/2021'],
    ]);
    expect(l.textoDigitado).toBe('');
    expect(editar(e, 900002, texto('07/2021'))).toEqual({
      ok: true,
      lista: guardados,
      digitacoes: {},
    });
    const outra = aceita(editar(e, 100037, escolher([35])));
    expect(outra.lista?.[0]).toEqual(guardados[0]);
  });

  it('um obrigatório só de busca mostra `obrigatorio-ausente` e `obrigatorio-requer-busca`', () => {
    const l = linha({ arvore: SINTETICA, lista: null }, 900004);
    expect(l.controle).toEqual({ tipo: 'nao-suportado', motivo: 'busca' });
    expect(l.problemas.map((p) => p.tipo)).toEqual([
      TIPO_PROBLEMA_ATRIBUTO_SHOPEE.obrigatorioAusente,
      TIPO_PROBLEMA_ATRIBUTO_SHOPEE.obrigatorioRequerBusca,
    ]);
  });

  it('⭐ PAR/QUASE-PAR: um valor guardado que o validador marca é CARREGADO (sem bloquear) ⟷ digitado, é recusado', () => {
    const guardados = [
      at(100037, { value_id: 6737 }),
      at(101029, { value_id: 0, original_value_name: 'abc', value_unit: 'cm' }),
    ];
    const e: Estado = { arvore: CANECA, lista: guardados, guardados };
    expect(linha(e, 101029).problemas).toEqual([
      {
        tipo: TIPO_PROBLEMA_ATRIBUTO_SHOPEE.unidadeInvalida,
        valor: 'abc',
        unidade: 'cm',
        maximo: null,
      },
      {
        tipo: TIPO_PROBLEMA_ATRIBUTO_SHOPEE.tipoDeValor,
        valor: 'abc',
        unidade: null,
        maximo: null,
      },
    ]);
    const outra = aceita(editar(e, 100037, escolher([35])));
    expect(outra.lista?.[1]).toEqual(guardados[1]);
    expect(digitacoesBloqueiam(outra.digitacoes)).toBe(false);
    const digitado = aceita(editar(e, 101029, texto('abc', 'CM')));
    expect(digitado.lista).toBe(guardados);
    expect(digitado.digitacoes['101029']?.motivo).toBe(
      MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.tipoDeValor,
    );
  });

  it('⭐ QUASE-PAR: a unidade guardada `CM` não é `unidade-invalida` em 101029; `cm` é', () => {
    const ok = linha(
      {
        arvore: CANECA,
        lista: [at(101029, { value_id: 0, original_value_name: '25', value_unit: 'CM' })],
      },
      101029,
    );
    expect(ok.problemas).toEqual([]);
    const marcado = linha(
      {
        arvore: CANECA,
        lista: [at(101029, { value_id: 0, original_value_name: '25', value_unit: 'cm' })],
      },
      101029,
    );
    expect(marcado.problemas).toEqual([
      {
        tipo: TIPO_PROBLEMA_ATRIBUTO_SHOPEE.unidadeInvalida,
        valor: '25',
        unidade: 'cm',
        maximo: null,
      },
    ]);
  });

  it('⭐ PAR/QUASE-PAR: uma unidade guardada FORA da lista (`cm` em 101029) nunca é dobrada na da lista — o campo mostra `cm` e redigitar o número BLOQUEIA ⟷ `CM` guardado é aceito como está', () => {
    const fora = [at(101029, { value_id: 0, original_value_name: '25', value_unit: 'cm' })];
    const e = { arvore: CANECA, lista: fora, guardados: fora };
    const l = linha(e, 101029);
    expect(l.unidadeDigitada).toBe('cm');
    // The input re-sends its row's unit with the retyped number (`EntradaDeTexto`).
    const r = aceita(editar(e, 101029, texto('26', l.unidadeDigitada)));
    expect(r.lista).toBe(fora);
    expect(r.digitacoes['101029']?.motivo).toBe(MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.unidadeInvalida);

    const certa = [at(101029, { value_id: 0, original_value_name: '25', value_unit: 'CM' })];
    const ec = { arvore: CANECA, lista: certa, guardados: certa };
    const lc = linha(ec, 101029);
    expect(lc.unidadeDigitada).toBe('CM');
    expect(aceita(editar(ec, 101029, texto('26', lc.unidadeDigitada))).lista).toEqual([
      at(101029, { value_id: 0, original_value_name: '26', value_unit: 'CM' }),
    ]);
  });

  it('⭐ PAR/QUASE-PAR: cada valor guardado volta com o SEU objeto cru, mesmo quando o decodificador descarta um valor ou um elemento ANTES dele — nunca o nome do descartado', () => {
    // A value the decoder drops (`value_id: -1`) BEFORE the kept custom value…
    const valorDescartado = [
      at(
        100037,
        { value_id: -1, original_value_name: 'Descartado' },
        { value_id: 0, original_value_name: 'Atlântida ' },
      ),
    ];
    // …and an element it drops (no integer `attribute_id`) BEFORE the kept attribute.
    const elementoDescartado = [
      {
        attribute_id: 'x',
        attribute_value_list: [{ value_id: 0, original_value_name: 'Descartado' }],
      },
      at(100037, { value_id: 0, original_value_name: 'Atlântida ' }),
    ] as unknown as AtributoShopeeRequisicao[];
    // PAR: nothing dropped — the same raw name.
    const limpo = [at(100037, { value_id: 0, original_value_name: 'Atlântida ' })];
    for (const guardado of [limpo, valorDescartado, elementoDescartado]) {
      const e = { arvore: CANECA, lista: guardado, guardados: guardado };
      expect(linha(e, 100037).textoDigitado).toBe('Atlântida ');
      // An edit of ANOTHER attribute writes this one back with its OWN raw object.
      const r = aceita(editar(e, 101029, texto('2', 'KG')));
      expect(r.lista?.find((x) => x.attribute_id === 100037)).toEqual(
        at(100037, { value_id: 0, original_value_name: 'Atlântida ' }),
      );
      expect(JSON.stringify(r.lista)).not.toContain('Descartado');
    }
  });

  it('um personalizado guardado sem unidade num atributo de unidade: `unidade-invalida`, unidade null («nenhuma»)', () => {
    const l = linha(
      { arvore: CANECA, lista: [at(101029, { value_id: 0, original_value_name: '25' })] },
      101029,
    );
    expect(l.problemas).toEqual([
      {
        tipo: TIPO_PROBLEMA_ATRIBUTO_SHOPEE.unidadeInvalida,
        valor: '25',
        unidade: null,
        maximo: null,
      },
    ]);
  });

  it('a mensagem nomeia o valor que o validador marca SOZINHO, não o primeiro da lista', () => {
    const l = linha(
      {
        arvore: CANECA,
        lista: [
          at(
            100278,
            { value_id: 0, original_value_name: '1.5', value_unit: 'L' },
            { value_id: 0, original_value_name: '2', value_unit: 'KG' },
          ),
        ],
      },
      100278,
    );
    expect(l.problemas).toEqual([
      {
        tipo: TIPO_PROBLEMA_ATRIBUTO_SHOPEE.unidadeInvalida,
        valor: '2',
        unidade: 'KG',
        maximo: null,
      },
    ]);
  });

  it('`valor-fora-da-lista`: o valor marcado aparece como `#id`', () => {
    const l = linha({ arvore: CANECA, lista: [at(100037, { value_id: 999999 })] }, 100037);
    expect(l.problemas).toEqual([
      {
        tipo: TIPO_PROBLEMA_ATRIBUTO_SHOPEE.valorForaDaLista,
        valor: '#999999',
        unidade: null,
        maximo: null,
      },
    ]);
    expect(l.escolhidos).toEqual([999999]);
  });
});

/* -------------------------------------------------------------------------- */
/*                         (11) digitacoesBloqueiam                            */
/* -------------------------------------------------------------------------- */

describe('digitacoesBloqueiam — alguma digitação com texto não vazio', () => {
  it.each([
    ['nenhuma', {}, false],
    ['branco + unidade', { '1': { texto: '', unidade: 'KG', motivo: null } }, false],
    ['só espaços', { '1': { texto: '   ', unidade: 'KG', motivo: null } }, false],
    [
      '`1,` (tipo-de-valor)',
      { '1': { texto: '1,', unidade: 'KG', motivo: 'tipo-de-valor' } },
      true,
    ],
    [
      'uma que bloqueia entre outras que não',
      {
        '1': { texto: '', unidade: 'KG', motivo: null },
        '2': { texto: '2', unidade: null, motivo: 'unidade-invalida' },
      },
      true,
    ],
  ] as const)('%s ⇒ %s', (_, d, esperado) => {
    expect(digitacoesBloqueiam(d)).toBe(esperado);
  });
});

/* -------------------------------------------------------------------------- */
/*                         (12) The copy stays elsewhere                       */
/* -------------------------------------------------------------------------- */

describe('o módulo não tem frases da saída do Seller Centre (#1369, correção 7)', () => {
  it('⭐ `atributosRascunho.ts` nunca soletra a saída pelo Seller Centre — ela é a de `anuncioProduto.ts`', () => {
    const aqui = dirname(fileURLToPath(import.meta.url));
    const fonte = readFileSync(join(aqui, 'atributosRascunho.ts'), 'utf8');
    // Built from parts, so this file never holds the phrase either.
    const saida = ['procure', 'o', 'sku'].join(' ');
    expect(fonte.toLowerCase()).not.toContain(saida);
  });
});
