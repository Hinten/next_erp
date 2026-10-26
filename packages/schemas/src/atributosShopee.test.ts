import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  atributoShopeeRequisicaoSchema,
  atributosParaEnvioShopee,
  atributosParaGravarShopee,
  atributosParaRequisicaoShopee,
  atributosShopeeRequisicaoSchema,
  atributosVisiveisShopee,
  DATE_FORMAT_TYPE_ATRIBUTO_SHOPEE,
  lerAtributosArmazenadosShopee,
  lerDataDeAtributoShopee,
  MOTIVO_DESCARTE_ATRIBUTO_SHOPEE,
  motivoDescarteAtributoShopeeSchema,
  MSG_ATRIBUTO_REPETIDO_SHOPEE,
  MSG_NOME_EM_VALOR_DA_LISTA_ATRIBUTO_SHOPEE,
  MSG_PERSONALIZADO_SEM_NOME_ATRIBUTO_SHOPEE,
  ORIGEM_VALOR_ATRIBUTO_SHOPEE,
  origemValorAtributoShopeeSchema,
  timestampDeDataShopee,
  TIPO_PROBLEMA_ATRIBUTO_SHOPEE,
  tipoDeEntradaShopee,
  tipoProblemaAtributoShopeeSchema,
  validarAtributosShopee,
  type ArvoreAtributosShopee,
  type AtributoLidoShopee,
  type ProblemaAtributoShopee,
} from './atributosShopee';
import type { AtributoDto, AtributoInfoDto, AtributoValorDto } from './taxonomiaShopeeDto';

/* ---------------------------------- fixtures ------------------------------ */

const T = TIPO_PROBLEMA_ATRIBUTO_SHOPEE;
const M = MOTIVO_DESCARTE_ATRIBUTO_SHOPEE;
const O = ORIGEM_VALOR_ATRIBUTO_SHOPEE;

function info(over: Partial<AtributoInfoDto> = {}): AtributoInfoDto {
  return {
    inputType: 2,
    inputValidationType: 2,
    formatType: 1,
    dateFormatType: null,
    attributeUnitList: null,
    maxValueCount: null,
    introduction: null,
    isOem: false,
    supportSearchValue: false,
    ...over,
  };
}

function atributo(
  attributeId: number,
  over: Partial<AtributoDto> & { readonly info?: Partial<AtributoInfoDto> } = {},
): AtributoDto {
  const { info: infoOver, ...resto } = over;
  return {
    attributeId,
    mandatory: false,
    name: `Atributo ${String(attributeId)}`,
    attributeInfo: info(infoOver),
    attributeValueList: [],
    ...resto,
  };
}

function valor(valueId: number, name: string | null, filhos: AtributoDto[] = []): AtributoValorDto {
  return { valueId, name, valueUnit: null, childAttributeList: filhos };
}

function arvore(atributos: AtributoDto[], truncated = false): ArvoreAtributosShopee {
  return { atributos, truncated };
}

/** Decode a stored list — every test reads the tree against DECODED values, like the callers. */
function lidos(armazenados: unknown): readonly AtributoLidoShopee[] {
  return lerAtributosArmazenadosShopee(armazenados).atributos;
}

/** guide 209 §2.5's own example: "Weight Type" → "Body Weights" unlocks "Body Weights Type". */
const FILHO_HALTER = atributo(200, { name: 'Tipo de halter', mandatory: true });
const FILHO_BARRA = atributo(300, { name: 'Tipo de barra', mandatory: true });
const TIPO_DE_PESO = atributo(100, {
  name: 'Tipo de peso',
  info: { inputType: 1 },
  attributeValueList: [valor(1, 'Halteres', [FILHO_HALTER]), valor(2, 'Barras', [FILHO_BARRA])],
});
const MARCA_DO_TECIDO = atributo(400, { name: 'Tecido' });
const PESO = arvore([TIPO_DE_PESO, MARCA_DO_TECIDO]);

/** The problems as `[attributeId, tipo]` pairs, in order. */
function pares(problemas: readonly ProblemaAtributoShopee[]): [number, string][] {
  return problemas.map((p) => [p.attributeId, p.tipo]);
}

/**
 * ORACLE — the publisher's attribute list BEFORE P6 (`montagemAnuncio.ts`'s
 * `atributosParaPublicar` + `lerValorArmazenado` at `6b8e3b81e`), frozen here
 * verbatim in semantics so the decoder's neutrality is a test, not a claim.
 */
function listaAntesDoP6(armazenados: readonly unknown[] | null): unknown[] {
  const util = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t.length > 0 ? t : null;
  };
  const lerValor = (bruto: unknown): Record<string, unknown> | null => {
    if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) return null;
    const linha = bruto as Record<string, unknown>;
    const valueId = linha.value_id;
    if (typeof valueId !== 'number' || !Number.isInteger(valueId) || valueId < 0) return null;
    const nome = util(linha.original_value_name);
    const unidade = util(linha.value_unit);
    if (valueId === 0 && nome === null) return null;
    return {
      value_id: valueId,
      ...(valueId === 0 && nome !== null ? { original_value_name: nome } : {}),
      ...(unidade !== null ? { value_unit: unidade } : {}),
    };
  };
  const lista: unknown[] = [];
  const vistos = new Set<number>();
  for (const bruto of armazenados ?? []) {
    if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) continue;
    const linha = bruto as Record<string, unknown>;
    const id = linha.attribute_id;
    if (typeof id !== 'number' || !Number.isInteger(id)) continue;
    const brutos = Array.isArray(linha.attribute_value_list) ? linha.attribute_value_list : [];
    const valores: unknown[] = [];
    for (const v of brutos) {
      const l = lerValor(v);
      if (l !== null) valores.push(l);
    }
    if (valores.length === 0) continue;
    if (vistos.has(id)) continue;
    vistos.add(id);
    lista.push({ attribute_id: id, attribute_value_list: valores });
  }
  return lista;
}

/* -------------------------------------------------------------------------- */
/*                               (1) the decoder                               */
/* -------------------------------------------------------------------------- */

describe('lerAtributosArmazenadosShopee — UM decodificador para as três formas guardadas (D9)', () => {
  it('a forma de REQUISIÇÃO passa como está, na ordem guardada', () => {
    const guardado = [
      { attribute_id: 10, attribute_value_list: [{ value_id: 55 }] },
      { attribute_id: 11, attribute_value_list: [{ value_id: 0, original_value_name: 'Algodão' }] },
      { attribute_id: 12, attribute_value_list: [{ value_id: 7, value_unit: 'cm' }] },
    ];
    const r = lerAtributosArmazenadosShopee(guardado);
    expect(atributosParaRequisicaoShopee(r.atributos)).toEqual(guardado);
    expect(r.descartes).toEqual([]);
    expect(r.atributos.flatMap((a) => a.valores.map((v) => v.origem))).toEqual([
      O.requisicao,
      O.requisicao,
      O.requisicao,
    ]);
  });

  it('a forma de LEITURA (a importação, verbatim) vira a de requisição: o nome de um id ≠ 0 SAI', () => {
    const lido = [
      {
        attribute_id: 10,
        original_attribute_name: 'Material',
        is_mandatory: true,
        attribute_value_list: [
          { value_id: 55, original_value_name: 'Algodão', value_unit: null, extra: 1 },
          { value_id: 0, original_value_name: ' Linho ', value_unit: null },
          { value_id: 9, original_value_name: '30', value_unit: 'cm' },
        ],
      },
    ];
    const r = lerAtributosArmazenadosShopee(lido);
    expect(atributosParaRequisicaoShopee(r.atributos)).toEqual([
      {
        attribute_id: 10,
        attribute_value_list: [
          { value_id: 55 },
          { value_id: 0, original_value_name: 'Linho' },
          { value_id: 9, value_unit: 'cm' },
        ],
      },
    ]);
    expect(r.atributos[0]?.valores.map((v) => v.origem)).toEqual([O.leitura, O.leitura, O.leitura]);
  });

  it('PAR/QUASE-PAR (b): `value_id: 55` não leva nome ⟷ `value_id: "55"` é DESCARTADO (nunca coagido)', () => {
    expect(
      atributosParaRequisicaoShopee(
        lidos([
          { attribute_id: 1, attribute_value_list: [{ value_id: 55, original_value_name: 'X' }] },
        ]),
      ),
    ).toEqual([{ attribute_id: 1, attribute_value_list: [{ value_id: 55 }] }]);
    const texto = lerAtributosArmazenadosShopee([
      { attribute_id: 1, attribute_value_list: [{ value_id: '55' }] },
    ]);
    expect(texto.atributos).toEqual([]);
    expect(texto.descartes.map((d) => d.motivo)).toEqual([M.valorIlegivel, M.semValores]);
  });

  it('⚠️ Q1 LIGADO (c): o valor legado SEM value_id é LIDO como personalizado e ENVIADO `{value_id: 0, …}`', () => {
    for (const legado of [
      { original_value_name: 'Algodão' },
      { value_id: null, original_value_name: 'Algodão' },
      { value_id: undefined, original_value_name: ' Algodão ' },
    ]) {
      const r = lerAtributosArmazenadosShopee([
        { attribute_id: 1, attribute_value_list: [legado] },
      ]);
      expect(r.atributos[0]?.valores[0]?.origem, JSON.stringify(legado)).toBe(O.legadoSemValueId);
      expect(atributosParaRequisicaoShopee(r.atributos), JSON.stringify(legado)).toEqual([
        {
          attribute_id: 1,
          attribute_value_list: [{ value_id: 0, original_value_name: 'Algodão' }],
        },
      ]);
    }
    // the unit rides along, like any custom value's
    expect(
      atributosParaRequisicaoShopee(
        lidos([
          {
            attribute_id: 1,
            attribute_value_list: [{ original_value_name: '30', value_unit: 'cm' }],
          },
        ]),
      ),
    ).toEqual([
      {
        attribute_id: 1,
        attribute_value_list: [{ value_id: 0, original_value_name: '30', value_unit: 'cm' }],
      },
    ]);
  });

  it('⛔ Q1, o outro lado (c): o legado com nome em BRANCO ou ausente é DESCARTADO — nada a enviar', () => {
    for (const legado of [
      { original_value_name: '  ' },
      { original_value_name: '' },
      { value_id: null, original_value_name: null },
      { value_unit: 'cm' },
      {},
    ]) {
      const r = lerAtributosArmazenadosShopee([
        { attribute_id: 1, attribute_value_list: [legado] },
      ]);
      expect(r.atributos, JSON.stringify(legado)).toEqual([]);
      expect(r.descartes[0]?.motivo, JSON.stringify(legado)).toBe(M.personalizadoSemNome);
    }
  });

  it('personalizado `value_id: 0` sem nome é descartado; o atributo sem valor nenhum também (nunca vai vazio)', () => {
    const r = lerAtributosArmazenadosShopee([
      {
        attribute_id: 1,
        attribute_value_list: [{ value_id: 0 }, { value_id: 0, original_value_name: ' ' }],
      },
      { attribute_id: 2, attribute_value_list: [] },
      { attribute_id: 3 },
    ]);
    expect(r.atributos).toEqual([]);
    expect(r.descartes).toEqual([
      { posicao: 0, posicaoValor: 0, attributeId: 1, motivo: M.personalizadoSemNome },
      { posicao: 0, posicaoValor: 1, attributeId: 1, motivo: M.personalizadoSemNome },
      { posicao: 0, posicaoValor: null, attributeId: 1, motivo: M.semValores },
      { posicao: 1, posicaoValor: null, attributeId: 2, motivo: M.semValores },
      { posicao: 2, posicaoValor: null, attributeId: 3, motivo: M.semValores },
    ]);
  });

  it('⛔ value_id ilegível: texto, fracionário, negativo, booleano, objeto — descartado', () => {
    for (const ruim of ['55', 1.5, -1, true, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = lerAtributosArmazenadosShopee([
        { attribute_id: 1, attribute_value_list: [{ value_id: ruim, original_value_name: 'X' }] },
      ]);
      expect(r.atributos, String(ruim)).toEqual([]);
      expect(r.descartes[0]?.motivo, String(ruim)).toBe(M.valorIlegivel);
    }
  });

  it('⛔ elemento ilegível: não-objeto, lista, sem attribute_id inteiro', () => {
    const r = lerAtributosArmazenadosShopee([
      null,
      7,
      'x',
      [{ attribute_id: 1 }],
      { attribute_id: '1', attribute_value_list: [{ value_id: 1 }] },
      { attribute_id: 1.5, attribute_value_list: [{ value_id: 1 }] },
      { attribute_value_list: [{ value_id: 1 }] },
    ]);
    expect(r.atributos).toEqual([]);
    expect(r.descartes.map((d) => [d.posicao, d.motivo])).toEqual(
      [0, 1, 2, 3, 4, 5, 6].map((i) => [i, M.entradaIlegivel]),
    );
  });

  it('dois elementos com o mesmo attribute_id: o PRIMEIRO vence ⟷ um primeiro SEM valor útil não reserva o id', () => {
    const primeiroVence = lerAtributosArmazenadosShopee([
      { attribute_id: 1, attribute_value_list: [{ value_id: 5 }] },
      { attribute_id: 1, attribute_value_list: [{ value_id: 6 }] },
    ]);
    expect(atributosParaRequisicaoShopee(primeiroVence.atributos)).toEqual([
      { attribute_id: 1, attribute_value_list: [{ value_id: 5 }] },
    ]);
    expect(primeiroVence.descartes.map((d) => d.motivo)).toEqual([M.atributoRepetido]);

    const vazioNaoReserva = lidos([
      { attribute_id: 1, attribute_value_list: [{ value_id: '5' }] },
      { attribute_id: 1, attribute_value_list: [{ value_id: 6 }] },
    ]);
    expect(atributosParaRequisicaoShopee(vazioNaoReserva)).toEqual([
      { attribute_id: 1, attribute_value_list: [{ value_id: 6 }] },
    ]);
  });

  it('total: qualquer valor que não seja lista lê VAZIO', () => {
    for (const bruto of [null, undefined, 'x', 7, {}, { attribute_id: 1 }]) {
      expect(lerAtributosArmazenadosShopee(bruto), String(bruto)).toEqual({
        atributos: [],
        descartes: [],
      });
    }
  });

  it('NEUTRALIDADE: para toda entrada que o publicador aceitava antes do P6, a lista é BYTE-IDÊNTICA', () => {
    const corpus: (readonly unknown[] | null)[] = [
      null,
      [],
      [{ attribute_id: 1, attribute_value_list: [{ value_id: 5 }] }],
      [
        { attribute_id: 1, attribute_value_list: [{ value_id: 0, original_value_name: ' a ' }] },
        {
          attribute_id: 2,
          attribute_value_list: [{ value_id: 3, value_unit: '  ' }, { value_id: 4 }],
        },
        { attribute_id: 2, attribute_value_list: [{ value_id: 9 }] },
        { attribute_id: -3, attribute_value_list: [{ value_id: 2 ** 60 }] },
        { attribute_id: 4, attribute_value_list: 'x' },
        { attribute_id: 5, attribute_value_list: [null, [], 'x', { value_id: -2 }] },
        { attribute_id: 6, attribute_value_list: [{ value_id: 0, original_value_name: 7 }] },
        {
          attribute_id: 7,
          attribute_value_list: [{ value_id: 8, original_value_name: 'leitura', value_unit: null }],
        },
        null,
        'lixo',
      ],
    ];
    for (const armazenados of corpus) {
      expect(
        atributosParaRequisicaoShopee(lidos(armazenados)),
        JSON.stringify(armazenados),
      ).toEqual(listaAntesDoP6(armazenados));
    }
  });

  it('⚠️ a ÚNICA diferença para o publicador antigo é a linha legada do Q1 (B2): antes descartada, agora enviada', () => {
    const legado = [
      { attribute_id: 1, attribute_value_list: [{ original_value_name: 'Algodão' }] },
    ];
    expect(listaAntesDoP6(legado)).toEqual([]);
    expect(atributosParaRequisicaoShopee(lidos(legado))).toEqual([
      { attribute_id: 1, attribute_value_list: [{ value_id: 0, original_value_name: 'Algodão' }] },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                           (2) the write schema                              */
/* -------------------------------------------------------------------------- */

describe('atributoShopeeRequisicaoSchema — o que uma ESCRITA aceita (estrita, normaliza)', () => {
  it('PAR: um valor da lista, um personalizado e um com unidade', () => {
    const lista = [
      { attribute_id: 10, attribute_value_list: [{ value_id: 55 }, { value_id: 56 }] },
      { attribute_id: 11, attribute_value_list: [{ value_id: 0, original_value_name: 'Algodão' }] },
      {
        attribute_id: 12,
        attribute_value_list: [{ value_id: 0, original_value_name: '30', value_unit: 'cm' }],
      },
    ];
    expect(atributosShopeeRequisicaoSchema.parse(lista)).toEqual(lista);
  });

  it('normaliza ao que o decodificador LÊ: nome aparado, unidade em branco omitida', () => {
    expect(
      atributoShopeeRequisicaoSchema.parse({
        attribute_id: 1,
        attribute_value_list: [
          { value_id: 0, original_value_name: ' Algodão ', value_unit: '' },
          { value_id: 7, value_unit: ' cm ' },
        ],
      }),
    ).toEqual({
      attribute_id: 1,
      attribute_value_list: [
        { value_id: 0, original_value_name: 'Algodão' },
        { value_id: 7, value_unit: 'cm' },
      ],
    });
  });

  it('⛔ personalizado sem nome (ausente, vazio, só espaços) é 400 com a frase', () => {
    for (const valorRuim of [
      { value_id: 0 },
      { value_id: 0, original_value_name: '' },
      { value_id: 0, original_value_name: '   ' },
    ]) {
      const r = atributoShopeeRequisicaoSchema.safeParse({
        attribute_id: 1,
        attribute_value_list: [valorRuim],
      });
      expect(r.success, JSON.stringify(valorRuim)).toBe(false);
      expect(r.error?.issues.map((i) => i.message)).toEqual([
        MSG_PERSONALIZADO_SEM_NOME_ATRIBUTO_SHOPEE,
      ]);
    }
  });

  it('⛔ a forma de LEITURA não é escrita: o NOME num valor da lista, as chaves do atributo lido', () => {
    const comNome = atributoShopeeRequisicaoSchema.safeParse({
      attribute_id: 1,
      attribute_value_list: [{ value_id: 55, original_value_name: 'Algodão', value_unit: null }],
    });
    expect(comNome.success).toBe(false);
    expect(comNome.error?.issues.map((i) => i.message)).toEqual([
      MSG_NOME_EM_VALOR_DA_LISTA_ATRIBUTO_SHOPEE,
    ]);
    for (const chave of [{ original_attribute_name: 'Material' }, { is_mandatory: true }]) {
      expect(
        atributoShopeeRequisicaoSchema.safeParse({
          attribute_id: 1,
          attribute_value_list: [{ value_id: 55 }],
          ...chave,
        }).success,
        JSON.stringify(chave),
      ).toBe(false);
    }
  });

  it('QUASE-PAR: um `null` de nome ou unidade é AUSENTE — normalizado, nunca gravado', () => {
    expect(
      atributoShopeeRequisicaoSchema.parse({
        attribute_id: 1,
        attribute_value_list: [
          { value_id: 55, original_value_name: null, value_unit: null },
          { value_id: 0, original_value_name: 'Linho', value_unit: null },
        ],
      }),
    ).toEqual({
      attribute_id: 1,
      attribute_value_list: [{ value_id: 55 }, { value_id: 0, original_value_name: 'Linho' }],
    });
    // …but a custom value still needs its name: `null` there is "no name"
    expect(
      atributoShopeeRequisicaoSchema.safeParse({
        attribute_id: 1,
        attribute_value_list: [{ value_id: 0, original_value_name: null }],
      }).success,
    ).toBe(false);
  });

  it('⛔ ids que não são números inteiros válidos, lista vazia, chave desconhecida, o legado sem value_id', () => {
    for (const ruim of [
      { attribute_id: 1, attribute_value_list: [{ value_id: '55' }] },
      { attribute_id: 1, attribute_value_list: [{ value_id: -1 }] },
      { attribute_id: 1, attribute_value_list: [{ value_id: 1.5 }] },
      { attribute_id: 1, attribute_value_list: [{ value_id: 2 ** 53 }] },
      { attribute_id: 1, attribute_value_list: [{ original_value_name: 'Algodão' }] },
      { attribute_id: 1, attribute_value_list: [{ value_id: 5, extra: 1 }] },
      { attribute_id: 1, attribute_value_list: [] },
      { attribute_id: 1 },
      { attribute_id: 0, attribute_value_list: [{ value_id: 5 }] },
      { attribute_id: -1, attribute_value_list: [{ value_id: 5 }] },
      { attribute_id: '1', attribute_value_list: [{ value_id: 5 }] },
      { attribute_id: 1, attribute_value_list: [{ value_id: 5 }], original_attribute_name: 'x' },
    ]) {
      expect(atributoShopeeRequisicaoSchema.safeParse(ruim).success, JSON.stringify(ruim)).toBe(
        false,
      );
    }
  });

  it('⛔ a lista: o mesmo attribute_id duas vezes é 400 (o decodificador leria só o primeiro)', () => {
    const r = atributosShopeeRequisicaoSchema.safeParse([
      { attribute_id: 1, attribute_value_list: [{ value_id: 5 }] },
      { attribute_id: 2, attribute_value_list: [{ value_id: 6 }] },
      { attribute_id: 1, attribute_value_list: [{ value_id: 7 }] },
    ]);
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => [i.path, i.message])).toEqual([
      [[2, 'attribute_id'], MSG_ATRIBUTO_REPETIDO_SHOPEE],
    ]);
  });

  it('IDA E VOLTA: tudo que a escrita aceita o decodificador lê de volta IGUAL (sem descarte)', () => {
    const escritas = [
      [{ attribute_id: 1, attribute_value_list: [{ value_id: 5 }] }],
      [
        {
          attribute_id: 1,
          attribute_value_list: [
            { value_id: 0, original_value_name: '  Linho ', value_unit: ' ' },
            { value_id: 9, value_unit: 'kg' },
          ],
        },
        {
          attribute_id: 3,
          attribute_value_list: [{ value_id: 0, original_value_name: '06/2021' }],
        },
      ],
      [],
    ];
    for (const bruta of escritas) {
      const escrita = atributosShopeeRequisicaoSchema.parse(bruta);
      const relida = lerAtributosArmazenadosShopee(escrita);
      expect(relida.descartes, JSON.stringify(bruta)).toEqual([]);
      expect(atributosParaRequisicaoShopee(relida.atributos), JSON.stringify(bruta)).toEqual(
        escrita,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                             (3) the input type                              */
/* -------------------------------------------------------------------------- */

describe('tipoDeEntradaShopee — UMA leitura de input_type (guide 209 §2.2)', () => {
  it('a tabela 1–5', () => {
    expect([1, 2, 3, 4, 5].map((inputType) => tipoDeEntradaShopee(info({ inputType })))).toEqual([
      { conhecida: true, multipla: false, aceitaPersonalizado: false, listaFornecida: true },
      { conhecida: true, multipla: false, aceitaPersonalizado: true, listaFornecida: true },
      { conhecida: true, multipla: false, aceitaPersonalizado: true, listaFornecida: false },
      { conhecida: true, multipla: true, aceitaPersonalizado: false, listaFornecida: true },
      { conhecida: true, multipla: true, aceitaPersonalizado: true, listaFornecida: true },
    ]);
  });

  it('⛔ null, 0, 6, sem attributeInfo ⇒ desconhecida (nunca um palpite)', () => {
    for (const entrada of [
      info({ inputType: null }),
      info({ inputType: 0 }),
      info({ inputType: 6 }),
      null,
      undefined,
    ]) {
      expect(tipoDeEntradaShopee(entrada)).toEqual({ conhecida: false });
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                       (4) the visible-given-values walk                     */
/* -------------------------------------------------------------------------- */

describe('atributosVisiveisShopee — o que os valores ESCOLHIDOS mostram (guide 209 §2.5)', () => {
  const escolher = (valueId: number) =>
    lidos([{ attribute_id: 100, attribute_value_list: [{ value_id: valueId }] }]);

  it('sem escolha: só as RAÍZES, em ordem', () => {
    expect(atributosVisiveisShopee(PESO, []).map((v) => v.atributo.attributeId)).toEqual([
      100, 400,
    ]);
  });

  it('PAR/QUASE-PAR (a): o valor escolhido mostra SEU filho ⟷ o filho do valor NÃO escolhido fica invisível', () => {
    expect(atributosVisiveisShopee(PESO, escolher(1)).map((v) => v.atributo.attributeId)).toEqual([
      100, 200, 400,
    ]);
    expect(atributosVisiveisShopee(PESO, escolher(2)).map((v) => v.atributo.attributeId)).toEqual([
      100, 300, 400,
    ]);
  });

  it('múltipla: a UNIÃO dos filhos de todos os valores escolhidos, na ordem da árvore', () => {
    const ambos = lidos([
      { attribute_id: 100, attribute_value_list: [{ value_id: 2 }, { value_id: 1 }] },
    ]);
    expect(atributosVisiveisShopee(PESO, ambos).map((v) => v.atributo.attributeId)).toEqual([
      100, 200, 300, 400,
    ]);
  });

  it('o personalizado (value_id 0) não desbloqueia filho — nem um valor da árvore com id 0', () => {
    const comZero = atributo(100, {
      attributeValueList: [valor(0, 'Outro', [FILHO_HALTER])],
    });
    const personalizado = lidos([
      { attribute_id: 100, attribute_value_list: [{ value_id: 0, original_value_name: 'Outro' }] },
    ]);
    expect(
      atributosVisiveisShopee(arvore([comZero]), personalizado).map((v) => v.atributo.attributeId),
    ).toEqual([100]);
  });

  it('recursivo: um neto aparece sob o filho cujo valor foi escolhido', () => {
    const neto = atributo(900, { name: 'Neto' });
    const filho = atributo(200, {
      name: 'Filho',
      attributeValueList: [valor(20, 'F20', [neto])],
    });
    const raiz = atributo(100, { name: 'Raiz', attributeValueList: [valor(10, 'R10', [filho])] });
    const visiveis = atributosVisiveisShopee(
      arvore([raiz]),
      lidos([
        { attribute_id: 100, attribute_value_list: [{ value_id: 10 }] },
        { attribute_id: 200, attribute_value_list: [{ value_id: 20 }] },
      ]),
    );
    expect(visiveis.map((v) => [v.atributo.attributeId, v.nome])).toEqual([
      [100, 'Raiz'],
      [200, 'Filho (em Raiz: R10)'],
      [900, 'Neto (em Filho: F20)'],
    ]);
    expect(visiveis[2]?.pai?.valor.valueId).toBe(20);
  });

  it('um id visto duas vezes: a PRIMEIRA ocorrência vence; uma raiz é sempre raiz', () => {
    const repetido = atributo(500, { name: 'Repetido' });
    const raiz = atributo(100, {
      name: 'Raiz',
      attributeValueList: [
        valor(1, 'A', [repetido, atributo(400, { name: 'Raiz também' })]),
        valor(2, 'B', [repetido]),
      ],
    });
    const visiveis = atributosVisiveisShopee(
      arvore([raiz, atributo(400, { name: 'Raiz também' }), raiz]),
      lidos([{ attribute_id: 100, attribute_value_list: [{ value_id: 1 }, { value_id: 2 }] }]),
    );
    expect(visiveis.map((v) => [v.atributo.attributeId, v.pai?.valor.valueId ?? null])).toEqual([
      [100, null],
      [500, 1],
      [400, null],
    ]);
  });

  it('uma lista montada À MÃO com o mesmo id duas vezes: a caminhada, o validador e a gravação leem a PRIMEIRA ⟷ a segunda nunca', () => {
    // The decoder never emits a repeated id, but the editor (P13) may hand these
    // functions a list it built itself — the docblock promises the decoder's own
    // FIRST-wins rule for those too.
    const aMao: AtributoLidoShopee[] = [
      { attributeId: 100, valores: [{ valor: { value_id: 1 }, origem: O.requisicao }] },
      { attributeId: 100, valores: [{ valor: { value_id: 2 }, origem: O.requisicao }] },
    ];
    expect(atributosVisiveisShopee(PESO, aMao).map((v) => v.atributo.attributeId)).toEqual([
      100, 200, 400,
    ]);
    expect(pares(validarAtributosShopee(PESO, aMao))).toEqual([[200, T.obrigatorioAusente]]);
    expect(atributosParaGravarShopee(PESO, aMao)).toEqual([
      { attribute_id: 100, attribute_value_list: [{ value_id: 1 }] },
    ]);
  });

  it('o nome: `name`, senão `#id`; o do valor, senão `#valueId`', () => {
    const semNome = atributo(77, { name: null });
    const raiz = atributo(100, { name: null, attributeValueList: [valor(3, null, [semNome])] });
    expect(
      atributosVisiveisShopee(
        arvore([raiz]),
        lidos([{ attribute_id: 100, attribute_value_list: [{ value_id: 3 }] }]),
      ).map((v) => v.nome),
    ).toEqual(['#100', '#77 (em #100: #3)']);
  });
});

/* -------------------------------------------------------------------------- */
/*                               (5) the validator                             */
/* -------------------------------------------------------------------------- */

describe('validarAtributosShopee — obrigatório (B1) e os tipos do editor', () => {
  it('a raiz obrigatória sem valor: `obrigatorio-ausente`, com `name ?? "#id"` (o texto do publicador)', () => {
    const r = validarAtributosShopee(
      arvore([
        atributo(77, { mandatory: true, name: null }),
        atributo(78, { mandatory: true, name: 'Cor' }),
      ]),
      [],
    );
    expect(r).toEqual([
      { attributeId: 77, nome: '#77', tipo: T.obrigatorioAusente },
      { attributeId: 78, nome: 'Cor', tipo: T.obrigatorioAusente },
    ]);
  });

  it('PAR/QUASE-PAR (a) B1: o filho obrigatório sob o valor ESCOLHIDO falta ⟷ sob o NÃO escolhido, não', () => {
    const halteres = lidos([{ attribute_id: 100, attribute_value_list: [{ value_id: 1 }] }]);
    expect(validarAtributosShopee(PESO, halteres)).toEqual([
      {
        attributeId: 200,
        nome: 'Tipo de halter (em Tipo de peso: Halteres)',
        tipo: T.obrigatorioAusente,
      },
    ]);
    const barras = lidos([{ attribute_id: 100, attribute_value_list: [{ value_id: 2 }] }]);
    expect(pares(validarAtributosShopee(PESO, barras))).toEqual([[300, T.obrigatorioAusente]]);
    // …and once the child has a value, nothing is missing.
    const completo = lidos([
      { attribute_id: 100, attribute_value_list: [{ value_id: 1 }] },
      {
        attribute_id: 200,
        attribute_value_list: [{ value_id: 0, original_value_name: 'Ajustável' }],
      },
    ]);
    expect(validarAtributosShopee(PESO, completo)).toEqual([]);
  });

  it('o filho legado (Q1) satisfaz o obrigatório — ele É enviado', () => {
    const r = validarAtributosShopee(
      PESO,
      lidos([
        { attribute_id: 100, attribute_value_list: [{ value_id: 1 }] },
        { attribute_id: 200, attribute_value_list: [{ original_value_name: 'Ajustável' }] },
      ]),
    );
    expect(r).toEqual([]);
  });

  it('`obrigatorio-requer-busca` é uma linha A MAIS (nunca no lugar): sem personalizado + supportSearchValue', () => {
    const busca = atributo(10, {
      mandatory: true,
      name: 'Modelo',
      info: { inputType: 1, supportSearchValue: true },
    });
    expect(pares(validarAtributosShopee(arvore([busca]), []))).toEqual([
      [10, T.obrigatorioAusente],
      [10, T.obrigatorioRequerBusca],
    ]);
    // ⟷ the same attribute taking custom values (type 2), or of an unknown type: no hint.
    for (const inputType of [2, null]) {
      const outro = atributo(10, {
        mandatory: true,
        info: { inputType, supportSearchValue: true },
      });
      expect(pares(validarAtributosShopee(arvore([outro]), [])), String(inputType)).toEqual([
        [10, T.obrigatorioAusente],
      ]);
    }
  });

  it('`personalizado-nao-permitido`: um personalizado nos tipos 1 e 4 ⟷ não nos tipos 2, 3, 5', () => {
    const personalizado = lidos([
      { attribute_id: 10, attribute_value_list: [{ value_id: 0, original_value_name: 'X' }] },
    ]);
    for (const [inputType, esperado] of [
      [1, [[10, T.personalizadoNaoPermitido]]],
      [4, [[10, T.personalizadoNaoPermitido]]],
      [2, []],
      [3, []],
      [5, []],
    ] as const) {
      expect(
        pares(
          validarAtributosShopee(arvore([atributo(10, { info: { inputType } })]), personalizado),
        ),
        String(inputType),
      ).toEqual(esperado);
    }
  });

  it('PAR/QUASE-PAR (g): `valor-fora-da-lista` dispara ⟷ NÃO quando os valores vêm por busca', () => {
    const tree = (supportSearchValue: boolean) =>
      arvore([
        atributo(10, {
          info: { inputType: 1, supportSearchValue },
          attributeValueList: [valor(1, 'Um'), valor(2, 'Dois')],
        }),
      ]);
    const foraDaLista = lidos([{ attribute_id: 10, attribute_value_list: [{ value_id: 999 }] }]);
    expect(pares(validarAtributosShopee(tree(false), foraDaLista))).toEqual([
      [10, T.valorForaDaLista],
    ]);
    expect(validarAtributosShopee(tree(true), foraDaLista)).toEqual([]);
    const daLista = lidos([{ attribute_id: 10, attribute_value_list: [{ value_id: 2 }] }]);
    expect(validarAtributosShopee(tree(false), daLista)).toEqual([]);
  });

  it('PAR/QUASE-PAR (d): `maxValueCount` 3 — três passam ⟷ quatro não (inclusivo); `null` = sem teto', () => {
    const lista = [1, 2, 3, 4, 5].map((id) => valor(id, `V${String(id)}`));
    const multi = (maxValueCount: number | null) =>
      arvore([atributo(10, { info: { inputType: 4, maxValueCount }, attributeValueList: lista })]);
    const escolhidos = (n: number) =>
      lidos([
        {
          attribute_id: 10,
          attribute_value_list: [1, 2, 3, 4, 5].slice(0, n).map((value_id) => ({ value_id })),
        },
      ]);
    expect(validarAtributosShopee(multi(3), escolhidos(3))).toEqual([]);
    expect(pares(validarAtributosShopee(multi(3), escolhidos(4)))).toEqual([[10, T.valoresDemais]]);
    expect(validarAtributosShopee(multi(null), escolhidos(5))).toEqual([]);
  });

  it('`valores-demais` na escolha ÚNICA: um passa ⟷ dois não', () => {
    const unica = arvore([
      atributo(10, {
        info: { inputType: 2 },
        attributeValueList: [valor(1, 'Um'), valor(2, 'Dois')],
      }),
    ]);
    expect(
      validarAtributosShopee(
        unica,
        lidos([{ attribute_id: 10, attribute_value_list: [{ value_id: 1 }] }]),
      ),
    ).toEqual([]);
    expect(
      pares(
        validarAtributosShopee(
          unica,
          lidos([{ attribute_id: 10, attribute_value_list: [{ value_id: 1 }, { value_id: 2 }] }]),
        ),
      ),
    ).toEqual([[10, T.valoresDemais]]);
  });

  it('PAR/QUASE-PAR (e): unidade "cm" ∈ ["cm"] ⟷ "CM" não (EXATO); sem unidade também não', () => {
    const comUnidade = arvore([
      atributo(10, { info: { inputType: 3, formatType: 2, attributeUnitList: ['cm', 'm'] } }),
    ]);
    const com = (value_unit?: string) =>
      lidos([
        {
          attribute_id: 10,
          attribute_value_list: [
            {
              value_id: 0,
              original_value_name: '30',
              ...(value_unit === undefined ? {} : { value_unit }),
            },
          ],
        },
      ]);
    expect(validarAtributosShopee(comUnidade, com('cm'))).toEqual([]);
    expect(pares(validarAtributosShopee(comUnidade, com('CM')))).toEqual([[10, T.unidadeInvalida]]);
    expect(pares(validarAtributosShopee(comUnidade, com()))).toEqual([[10, T.unidadeInvalida]]);
    // with NO unit list the unit is still REQUIRED on a custom value (any one passes)
    const semLista = arvore([
      atributo(10, { info: { inputType: 3, formatType: 2, attributeUnitList: null } }),
    ]);
    expect(pares(validarAtributosShopee(semLista, com()))).toEqual([[10, T.unidadeInvalida]]);
    expect(validarAtributosShopee(semLista, com('qualquer'))).toEqual([]);
    // a unit only binds a CUSTOM value, and only on formatType 2
    const semFormato = arvore([
      atributo(10, { info: { inputType: 3, formatType: 1, attributeUnitList: ['cm'] } }),
    ]);
    expect(validarAtributosShopee(semFormato, com('CM'))).toEqual([]);
  });

  it('`tipo-de-valor`: inteiro e decimal (ponto) no nome do personalizado', () => {
    const tipado = (inputValidationType: number) =>
      arvore([atributo(10, { info: { inputType: 3, inputValidationType } })]);
    const nome = (original_value_name: string) =>
      lidos([{ attribute_id: 10, attribute_value_list: [{ value_id: 0, original_value_name }] }]);
    for (const ok of ['12', '-3', '007'])
      expect(validarAtributosShopee(tipado(1), nome(ok)), ok).toEqual([]);
    for (const ruim of ['12.5', '12a', '1 2', '+3']) {
      expect(pares(validarAtributosShopee(tipado(1), nome(ruim))), ruim).toEqual([
        [10, T.tipoDeValor],
      ]);
    }
    for (const ok of ['12.5', '-0.25', '3'])
      expect(validarAtributosShopee(tipado(3), nome(ok)), ok).toEqual([]);
    for (const ruim of ['12,5', '.5', '5.', 'abc']) {
      expect(pares(validarAtributosShopee(tipado(3), nome(ruim))), ruim).toEqual([
        [10, T.tipoDeValor],
      ]);
    }
    // a string-typed attribute takes anything
    expect(validarAtributosShopee(tipado(2), nome('qualquer coisa'))).toEqual([]);
  });

  it('PAR/QUASE-PAR (f): a data em TIMESTAMP passa ⟷ a mesma data na forma de LEITURA é apontada', () => {
    const data = arvore([
      atributo(10, { info: { inputType: 3, inputValidationType: 4, dateFormatType: 1 } }),
    ]);
    const nome = (original_value_name: string) =>
      lidos([{ attribute_id: 10, attribute_value_list: [{ value_id: 0, original_value_name }] }]);
    expect(validarAtributosShopee(data, nome('1622548800'))).toEqual([]);
    expect(pares(validarAtributosShopee(data, nome('06/2021')))).toEqual([
      [10, T.dataEmFormatoDeLeitura],
    ]);
    expect(pares(validarAtributosShopee(data, nome('junho de 2021')))).toEqual([
      [10, T.tipoDeValor],
    ]);
  });

  it('tipo DESCONHECIDO: só o obrigatório — nada de lista, cota, unidade ou tipo de valor', () => {
    const desconhecido = arvore([
      atributo(10, {
        info: { inputType: null, inputValidationType: 1, formatType: 2, attributeUnitList: ['cm'] },
        attributeValueList: [valor(1, 'Um')],
      }),
    ]);
    const tudoErrado = lidos([
      {
        attribute_id: 10,
        attribute_value_list: [
          { value_id: 999 },
          { value_id: 0, original_value_name: 'abc', value_unit: 'CM' },
        ],
      },
    ]);
    expect(validarAtributosShopee(desconhecido, tudoErrado)).toEqual([]);
    const semInfo = arvore([atributo(10, { attributeInfo: null, mandatory: true })]);
    expect(pares(validarAtributosShopee(semInfo, []))).toEqual([[10, T.obrigatorioAusente]]);
  });

  it('`filho-sem-pai` (o valor do pai mudou) e `fora-da-categoria` (outra categoria), na ordem guardada', () => {
    const r = validarAtributosShopee(
      PESO,
      lidos([
        { attribute_id: 999, attribute_value_list: [{ value_id: 1 }] },
        { attribute_id: 100, attribute_value_list: [{ value_id: 2 }] },
        {
          attribute_id: 300,
          attribute_value_list: [{ value_id: 0, original_value_name: 'Olímpica' }],
        },
        {
          attribute_id: 200,
          attribute_value_list: [{ value_id: 0, original_value_name: 'Ajustável' }],
        },
      ]),
    );
    expect(r).toEqual([
      { attributeId: 999, nome: '#999', tipo: T.foraDaCategoria },
      { attributeId: 200, nome: 'Tipo de halter', tipo: T.filhoSemPai },
    ]);
  });

  it('PAR/QUASE-PAR (h): árvore TRUNCADA é leniente — nada de `filho-sem-pai`/`fora-da-categoria` ⟷ a completa aponta', () => {
    const guardados = lidos([
      { attribute_id: 999, attribute_value_list: [{ value_id: 1 }] },
      { attribute_id: 200, attribute_value_list: [{ value_id: 1 }] },
    ]);
    expect(validarAtributosShopee({ ...PESO, truncated: true }, guardados)).toEqual([]);
    expect(pares(validarAtributosShopee(PESO, guardados))).toEqual([
      [999, T.foraDaCategoria],
      [200, T.filhoSemPai],
    ]);
  });

  it('no máximo uma linha por (atributo, tipo), mesmo com vários valores errados', () => {
    const r = validarAtributosShopee(
      arvore([atributo(10, { info: { inputType: 4, maxValueCount: 1 } })]),
      lidos([
        {
          attribute_id: 10,
          attribute_value_list: [
            { value_id: 0, original_value_name: 'A' },
            { value_id: 0, original_value_name: 'B' },
          ],
        },
      ]),
    );
    expect(pares(r)).toEqual([
      [10, T.personalizadoNaoPermitido],
      [10, T.valoresDemais],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                        (6) what a draft save writes                         */
/* -------------------------------------------------------------------------- */

describe('atributosParaGravarShopee — só o VISÍVEL, na ordem da árvore', () => {
  it('reordena para a ordem da caminhada e solta o filho cujo pai mudou e o de outra categoria', () => {
    const guardados = lidos([
      {
        attribute_id: 400,
        attribute_value_list: [{ value_id: 0, original_value_name: 'Algodão' }],
      },
      { attribute_id: 999, attribute_value_list: [{ value_id: 1 }] },
      {
        attribute_id: 300,
        attribute_value_list: [{ value_id: 0, original_value_name: 'Olímpica' }],
      },
      {
        attribute_id: 200,
        attribute_value_list: [{ value_id: 0, original_value_name: 'Ajustável' }],
      },
      { attribute_id: 100, attribute_value_list: [{ value_id: 1 }] },
    ]);
    expect(atributosParaGravarShopee(PESO, guardados)).toEqual([
      { attribute_id: 100, attribute_value_list: [{ value_id: 1 }] },
      {
        attribute_id: 200,
        attribute_value_list: [{ value_id: 0, original_value_name: 'Ajustável' }],
      },
      {
        attribute_id: 400,
        attribute_value_list: [{ value_id: 0, original_value_name: 'Algodão' }],
      },
    ]);
  });

  it('PAR/QUASE-PAR (h): árvore TRUNCADA guarda o que ela não mostra (no fim, ordem guardada) ⟷ a completa solta', () => {
    const guardados = lidos([
      { attribute_id: 999, attribute_value_list: [{ value_id: 1 }] },
      { attribute_id: 100, attribute_value_list: [{ value_id: 2 }] },
      { attribute_id: 998, attribute_value_list: [{ value_id: 2 }] },
    ]);
    expect(atributosParaGravarShopee({ ...PESO, truncated: true }, guardados)).toEqual([
      { attribute_id: 100, attribute_value_list: [{ value_id: 2 }] },
      { attribute_id: 999, attribute_value_list: [{ value_id: 1 }] },
      { attribute_id: 998, attribute_value_list: [{ value_id: 2 }] },
    ]);
    expect(atributosParaGravarShopee(PESO, guardados)).toEqual([
      { attribute_id: 100, attribute_value_list: [{ value_id: 2 }] },
    ]);
  });

  it('o que ela produz é uma escrita VÁLIDA (a forma de requisição)', () => {
    const gravar = atributosParaGravarShopee(
      PESO,
      lidos([
        {
          attribute_id: 100,
          attribute_value_list: [
            { value_id: 1, original_value_name: 'Halteres', value_unit: null },
          ],
        },
        { attribute_id: 200, attribute_value_list: [{ original_value_name: ' Ajustável ' }] },
      ]),
    );
    expect(atributosShopeeRequisicaoSchema.parse(gravar)).toEqual(gravar);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  (7) dates                                  */
/* -------------------------------------------------------------------------- */

describe('datas — leitura nas duas formas, escrita em UMA convenção (NÃO VERIFICADA até as capturas)', () => {
  it('PAR/QUASE-PAR (f): "06/2021" é a forma de LEITURA ⟷ "1622548800" é TIMESTAMP', () => {
    expect(lerDataDeAtributoShopee('06/2021', DATE_FORMAT_TYPE_ATRIBUTO_SHOPEE.mesAno)).toEqual({
      ano: 2021,
      mes: 6,
      dia: null,
      forma: 'leitura',
    });
    expect(
      lerDataDeAtributoShopee('1622548800', DATE_FORMAT_TYPE_ATRIBUTO_SHOPEE.diaMesAno),
    ).toEqual({
      ano: 2021,
      mes: 6,
      dia: 1,
      forma: 'timestamp',
    });
    expect(lerDataDeAtributoShopee('1622548800', DATE_FORMAT_TYPE_ATRIBUTO_SHOPEE.mesAno)).toEqual({
      ano: 2021,
      mes: 6,
      dia: null,
      forma: 'timestamp',
    });
  });

  it('DD/MM/YYYY e o texto aparado', () => {
    expect(lerDataDeAtributoShopee(' 30/06/2021 ', 0)).toEqual({
      ano: 2021,
      mes: 6,
      dia: 30,
      forma: 'leitura',
    });
  });

  it('⛔ não é data: data impossível (o "31/06/2021" do próprio guia), mês 13, formatos soltos, vazio', () => {
    for (const ruim of [
      '31/06/2021',
      '29/02/2023',
      '13/2021',
      '00/2021',
      '6/2021',
      '2021-06-01',
      '06-2021',
      '-1622548800',
      '1622548800.5',
      '',
      '   ',
      null,
      undefined,
    ]) {
      expect(lerDataDeAtributoShopee(ruim, 0), String(ruim)).toBeNull();
    }
  });

  it('ano bissexto: 29/02 em 2024 e 2000 ⟷ não em 2023 nem em 1900', () => {
    expect(lerDataDeAtributoShopee('29/02/2024', 0)?.dia).toBe(29);
    expect(lerDataDeAtributoShopee('29/02/2000', 0)?.dia).toBe(29);
    expect(lerDataDeAtributoShopee('29/02/2023', 0)).toBeNull();
    expect(lerDataDeAtributoShopee('29/02/1900', 0)).toBeNull();
  });

  it('a ESCRITA: segundos das 12:00 UTC do dia (dia 1 quando só mês/ano)', () => {
    expect(timestampDeDataShopee({ ano: 2021, mes: 6, dia: 1 })).toBe('1622548800');
    expect(timestampDeDataShopee({ ano: 2021, mes: 6, dia: null })).toBe('1622548800');
    expect(timestampDeDataShopee({ ano: 2021, mes: 6, dia: 30 })).toBe(
      String(1622548800 + 29 * 86_400),
    );
  });

  it('⚠️ 12:00 UTC é o MESMO dia civil de UTC−11 a UTC+11 (BRT, UTC, Singapura)', () => {
    const segundos = Number(timestampDeDataShopee({ ano: 2024, mes: 2, dia: 29 }));
    for (const deslocamentoH of [-11, -3, 0, 8, 11]) {
      const local = new Date((segundos + deslocamentoH * 3_600) * 1000);
      expect(
        [local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate()],
        String(deslocamentoH),
      ).toEqual([2024, 2, 29]);
    }
  });

  it('IDA E VOLTA: o timestamp escrito é lido de volta como a mesma data', () => {
    for (const data of [
      { ano: 2021, mes: 6, dia: 1 },
      { ano: 2024, mes: 2, dia: 29 },
      { ano: 1970, mes: 1, dia: 1 },
      { ano: 2099, mes: 12, dia: 31 },
    ]) {
      const ts = timestampDeDataShopee(data);
      expect(lerDataDeAtributoShopee(ts, 0), JSON.stringify(data)).toEqual({
        ...data,
        forma: 'timestamp',
      });
    }
  });

  it('⛔ a escrita recusa (null) data impossível, antes de 1970, depois de 9999, não inteira', () => {
    for (const ruim of [
      { ano: 2021, mes: 6, dia: 31 },
      { ano: 2023, mes: 2, dia: 29 },
      { ano: 1969, mes: 12, dia: 31 },
      { ano: 10_000, mes: 1, dia: 1 },
      { ano: 2021, mes: 0, dia: 1 },
      { ano: 2021, mes: 13, dia: null },
      { ano: 2021.5, mes: 6, dia: 1 },
    ]) {
      expect(timestampDeDataShopee(ruim), JSON.stringify(ruim)).toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                    (7b) what a publish SENDS (P6 review)                    */
/* -------------------------------------------------------------------------- */

describe('atributosParaEnvioShopee — a data na forma de LEITURA sai na de ESCRITA (guide 209 §2.3)', () => {
  const FABRICACAO = atributo(505, {
    name: 'Fabricação',
    info: { inputType: 3, inputValidationType: 4, dateFormatType: 1 },
  });
  const VALIDADE = atributo(506, {
    name: 'Validade',
    info: { inputType: 3, inputValidationType: 4, dateFormatType: 0 },
  });
  /** A date CHILD, under value 1 of a list attribute. */
  const DATA_FILHA = atributo(701, {
    name: 'Lote',
    info: { inputType: 3, inputValidationType: 4, dateFormatType: 0 },
  });
  const COM_FILHA = atributo(700, {
    name: 'Tipo',
    info: { inputType: 1 },
    attributeValueList: [valor(1, 'Com lote', [DATA_FILHA]), valor(2, 'Sem lote')],
  });
  const DATAS = arvore([FABRICACAO, VALIDADE, COM_FILHA]);

  /** One custom value on one attribute. */
  function custom(attributeId: number, nome: string) {
    return {
      attribute_id: attributeId,
      attribute_value_list: [{ value_id: 0, original_value_name: nome }],
    };
  }

  it('PAR: "06/2021" (MM/YYYY) e "30/06/2021" (DD/MM/YYYY) num nó de data saem como o timestamp da convenção ÚNICA', () => {
    const enviados = atributosParaEnvioShopee(
      DATAS,
      lidos([custom(505, '06/2021'), custom(506, ' 30/06/2021 ')]),
    );
    expect(enviados).toEqual([
      custom(505, timestampDeDataShopee({ ano: 2021, mes: 6, dia: null }) ?? 'x'),
      custom(506, timestampDeDataShopee({ ano: 2021, mes: 6, dia: 30 }) ?? 'x'),
    ]);
    // The literal too: a change of convention is seen HERE, not only through the function.
    expect(enviados[0]?.attribute_value_list[0]?.original_value_name).toBe('1622548800');
  });

  it('⛔ QUASE-PAR: o MESMO "06/2021" num nó que NÃO é data (inputValidationType 2, 1, 3, null) ou fora da árvore sai como está', () => {
    const naoData = arvore([
      atributo(510, { info: { inputType: 3, inputValidationType: 2 } }),
      atributo(511, { info: { inputType: 3, inputValidationType: 1 } }),
      atributo(512, { info: { inputType: 3, inputValidationType: 3 } }),
      atributo(513, { info: { inputType: 3, inputValidationType: null } }),
      atributo(514, { attributeInfo: null }),
    ]);
    const guardados = [510, 511, 512, 513, 514, 9999].map((id) => custom(id, '06/2021'));
    expect(atributosParaEnvioShopee(naoData, lidos(guardados))).toEqual(guardados);
  });

  it('⛔ QUASE-PAR: um TIMESTAMP nunca é re-codificado — nem o que não cai às 12:00 UTC', () => {
    // 00:00 UTC of 2021-06-01 on a day node, 12:00 UTC of 2021-06-17 on a month-only node:
    // re-encoding either would answer 1622548800 — so leaving them is a real decision.
    const guardados = [custom(506, '1622505600'), custom(505, '1623931200')];
    expect(timestampDeDataShopee({ ano: 2021, mes: 6, dia: 1 })).toBe('1622548800');
    expect(atributosParaEnvioShopee(DATAS, lidos(guardados))).toEqual(guardados);
  });

  it('⛔ QUASE-PAR: o que não é data real ("31/06/2021", "13/2021", "abc") e um valor DA LISTA (sem nome) num nó de data saem como estão', () => {
    const guardados = [
      custom(506, '31/06/2021'),
      custom(505, '13/2021'),
      custom(701, 'abc'),
      { attribute_id: 700, attribute_value_list: [{ value_id: 2 }] },
    ];
    expect(atributosParaEnvioShopee(DATAS, lidos(guardados))).toEqual(guardados);
  });

  it('⛔ QUASE-PAR: uma data de LEITURA sem forma de escrita (antes de 1970: não há timestamp negativo) sai como está', () => {
    const antesDe1970 = [custom(505, '06/1969')];
    // Not vacuous: it IS a read-form date — only the write form refuses it.
    expect(lerDataDeAtributoShopee('06/1969', 1)?.forma).toBe('leitura');
    expect(timestampDeDataShopee({ ano: 1969, mes: 6, dia: null })).toBeNull();
    expect(atributosParaEnvioShopee(DATAS, lidos(antesDe1970))).toEqual(antesDe1970);
  });

  it('o nó é procurado na árvore INTEIRA: a data filha de um valor NÃO escolhido (órfã, que o publicador ENVIA) também é convertida', () => {
    const escolhido = lidos([
      { attribute_id: 700, attribute_value_list: [{ value_id: 1 }] },
      custom(701, '01/02/2024'),
    ]);
    const orfao = lidos([
      { attribute_id: 700, attribute_value_list: [{ value_id: 2 }] },
      custom(701, '01/02/2024'),
    ]);
    const esperado = timestampDeDataShopee({ ano: 2024, mes: 2, dia: 1 }) ?? 'x';
    for (const [nome, lista] of [
      ['escolhido', escolhido],
      ['órfão', orfao],
    ] as const) {
      expect(atributosParaEnvioShopee(DATAS, lista)[1], nome).toEqual(custom(701, esperado));
    }
  });

  it('TODOS os valores de um nó de data são convertidos, um a um — não só o primeiro (o timestamp entre eles fica)', () => {
    const guardado = [
      {
        attribute_id: 506,
        attribute_value_list: [
          { value_id: 0, original_value_name: '30/06/2021' },
          { value_id: 0, original_value_name: '1622505600' },
          { value_id: 0, original_value_name: '01/07/2021' },
        ],
      },
    ];
    expect(atributosParaEnvioShopee(DATAS, lidos(guardado))).toEqual([
      {
        attribute_id: 506,
        attribute_value_list: [
          {
            value_id: 0,
            original_value_name: timestampDeDataShopee({ ano: 2021, mes: 6, dia: 30 }) ?? 'x',
          },
          { value_id: 0, original_value_name: '1622505600' },
          {
            value_id: 0,
            original_value_name: timestampDeDataShopee({ ano: 2021, mes: 7, dia: 1 }) ?? 'x',
          },
        ],
      },
    ]);
  });

  it('árvore TRUNCADA: o nó que ela TEM converte; o que ficou abaixo do corte (ela não tem) sai como está', () => {
    const truncada = arvore([FABRICACAO], true);
    expect(
      atributosParaEnvioShopee(truncada, lidos([custom(505, '06/2021'), custom(506, '06/2021')])),
    ).toEqual([custom(505, '1622548800'), custom(506, '06/2021')]);
  });

  it('fora das datas, É a lista de atributosParaRequisicaoShopee — mesmos atributos, mesmos valores, mesma ORDEM, unidade preservada', () => {
    const corpus: unknown[] = [
      { attribute_id: 6, attribute_value_list: [{ value_id: 9, original_value_name: 'Lido' }] },
      {
        attribute_id: 505,
        attribute_value_list: [{ value_id: 0, original_value_name: '06/2021', value_unit: 'mês' }],
      },
      { attribute_id: 1, attribute_value_list: [{ value_id: 5, value_unit: ' kg ' }] },
      { attribute_id: 5, attribute_value_list: [{ original_value_name: 'Legado' }] },
    ];
    const enviados = atributosParaEnvioShopee(DATAS, lidos(corpus));
    const requisicao = atributosParaRequisicaoShopee(lidos(corpus));
    expect(enviados.map((a) => a.attribute_id)).toEqual(requisicao.map((a) => a.attribute_id));
    expect(enviados.filter((a) => a.attribute_id !== 505)).toEqual(
      requisicao.filter((a) => a.attribute_id !== 505),
    );
    expect(enviados[1]).toEqual({
      attribute_id: 505,
      attribute_value_list: [{ value_id: 0, original_value_name: '1622548800', value_unit: 'mês' }],
    });
    // With NO tree nothing is a date: the send list IS the request list.
    expect(atributosParaEnvioShopee(arvore([]), lidos(corpus))).toEqual(requisicao);
  });
});

/* -------------------------------------------------------------------------- */
/*                        (8) vocabularies and the file                        */
/* -------------------------------------------------------------------------- */

describe('os vocabulários: cada enum tem sua constante, e nada mais', () => {
  it('as constantes cobrem exatamente os enums', () => {
    expect(Object.values(TIPO_PROBLEMA_ATRIBUTO_SHOPEE)).toEqual(
      tipoProblemaAtributoShopeeSchema.options,
    );
    expect(Object.values(ORIGEM_VALOR_ATRIBUTO_SHOPEE)).toEqual(
      origemValorAtributoShopeeSchema.options,
    );
    expect(Object.values(MOTIVO_DESCARTE_ATRIBUTO_SHOPEE)).toEqual(
      motivoDescarteAtributoShopeeSchema.options,
    );
  });
});

describe('atributosShopee.ts — o texto do arquivo', () => {
  const FONTE = readFileSync(join(import.meta.dirname, 'atributosShopee.ts'), 'utf8');

  it('é puro: nenhum relógio, nenhuma transação, nenhum fuso ambiente', () => {
    for (const proibido of [
      'Date.now(',
      'new Date()',
      'runTransaction',
      'getFullYear(',
      'getMonth(',
      'getDate(',
      'getHours(',
      'toLocale',
      'firebase',
    ]) {
      expect(FONTE, proibido).not.toContain(proibido);
    }
  });

  it('⚠️ a convenção de data mora num ÚNICO par de funções (as capturas emendam só ali)', () => {
    expect(FONTE.match(/Date\.UTC\(/g)).toHaveLength(1);
    expect(FONTE.match(/new Date\(/g)).toHaveLength(1);
    expect(FONTE.match(/HORA_UTC_DA_DATA_SHOPEE/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
