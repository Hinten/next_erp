import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ShopeeConfigError } from '../src/errors';
import {
  type GetReturnListParams,
  type OfferReturnParams,
  type ShopeeReturnSolution,
  SHOPEE_GET_AVAILABLE_SOLUTIONS_PATH,
  SHOPEE_GET_RETURN_DETAIL_PATH,
  SHOPEE_GET_RETURN_LIST_PATH,
  SHOPEE_RETURN_ACCEPT_OFFER_PATH,
  SHOPEE_RETURN_CONFIRM_PATH,
  SHOPEE_RETURN_LIST_MAX_PAGE_SIZE,
  SHOPEE_RETURN_LIST_MAX_WINDOW_SECONDS,
  SHOPEE_RETURN_OFFER_PATH,
  SHOPEE_RETURN_SOLUTION,
  SHOPEE_RETURNS_ERROR_ALIASES,
  assertAlvoDeDevolucao,
  assertOfferReturnParams,
  assertReturnListParams,
  normalizarSolucaoDeDevolucao,
  shopeeReturnSolutionSchema,
} from '../src/devolucoes';
import * as publico from '../src/index';
import {
  shopeeReturnAvailableSolutionsSchema,
  shopeeReturnDetailBodySchema,
  shopeeReturnDetailSchema,
  shopeeReturnListRowSchema,
  shopeeReturnListSchema,
  shopeeReturnWriteSchema,
} from '../src/types';

/** Os ids de fixture — o ALFANUMÉRICO é o formato das amostras da própria doc. */
const RETURN_SN_ALFANUMERICO = '260910ABCDE0001';
const RETURN_SN_DIGITOS = '2609100000000001';

/** Um segundo de referência qualquer (2026-09-10T00:00:00Z). */
const T0 = 1_788_998_400;
const DIA = 86_400;

/** Roda `fn` e devolve o `ShopeeConfigError` que ela lançou — falha se não lançou ou lançou outra coisa. */
function recusa(fn: () => void): ShopeeConfigError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ShopeeConfigError) return err;
    throw err;
  }
  throw new Error('esperava um ShopeeConfigError, e nada foi lançado');
}

const FONTE_DEVOLUCOES = readFileSync(new URL('../src/devolucoes.ts', import.meta.url), 'utf8');

describe('devoluções — os caminhos e as constantes do fio (passo 17)', () => {
  it('os seis caminhos são os da doc, byte a byte', () => {
    expect(SHOPEE_GET_RETURN_LIST_PATH).toBe('/api/v2/returns/get_return_list');
    expect(SHOPEE_GET_RETURN_DETAIL_PATH).toBe('/api/v2/returns/get_return_detail');
    expect(SHOPEE_GET_AVAILABLE_SOLUTIONS_PATH).toBe('/api/v2/returns/get_available_solutions');
    expect(SHOPEE_RETURN_CONFIRM_PATH).toBe('/api/v2/returns/confirm');
    expect(SHOPEE_RETURN_OFFER_PATH).toBe('/api/v2/returns/offer');
    expect(SHOPEE_RETURN_ACCEPT_OFFER_PATH).toBe('/api/v2/returns/accept_offer');
  });

  it('os limites: página de até 100, janela de EXATAMENTE 15 dias em segundos', () => {
    expect(SHOPEE_RETURN_LIST_MAX_PAGE_SIZE).toBe(100);
    expect(SHOPEE_RETURN_LIST_MAX_WINDOW_SECONDS).toBe(15 * DIA);
  });

  it('o alias do envelope é EXATAMENTE `[" ", "-"]` — nem `""`, nem uma variante aparada', () => {
    // ⚠️ A comparação no transporte é EXATA (`call.ts`, estágio 1): um `'  '`
    // ou um `'\t'` continua falha. Este pin impede o alias de crescer em
    // silêncio — o registro 231 o ESTREITA, nunca o alarga.
    expect([...SHOPEE_RETURNS_ERROR_ALIASES]).toEqual([' ', '-']);
    expect(SHOPEE_RETURNS_ERROR_ALIASES).not.toContain('');
    expect(SHOPEE_RETURNS_ERROR_ALIASES).not.toContain('  ');
  });

  it('a constante companheira do enum de solução tem EXATAMENTE os membros do enum', () => {
    expect(Object.values(SHOPEE_RETURN_SOLUTION).sort()).toEqual(
      [...shopeeReturnSolutionSchema.options].sort(),
    );
    expect(SHOPEE_RETURN_SOLUTION.devolucaoEReembolso).toBe('RETURN_REFUND');
    expect(SHOPEE_RETURN_SOLUTION.soReembolso).toBe('REFUND');
  });

  it('ESTRUTURAL: o módulo NÃO importa `api.ts` — a aresta corre ao contrário', () => {
    // `api.ts` importa este módulo; a volta seria um ciclo, e é por isso que os
    // dois guardas numéricos aqui são CÓPIAS locais.
    expect(FONTE_DEVOLUCOES).not.toMatch(/from '\.\/api'/);
    expect(FONTE_DEVOLUCOES).not.toMatch(/import\('\.\/api'\)/);
  });

  it('a PORTA: tudo que o passo 17 exporta sai por `@delfrance/integrations-shopee`', () => {
    expect(publico.assertAlvoDeDevolucao).toBe(assertAlvoDeDevolucao);
    expect(publico.assertReturnListParams).toBe(assertReturnListParams);
    expect(publico.assertOfferReturnParams).toBe(assertOfferReturnParams);
    expect(publico.normalizarSolucaoDeDevolucao).toBe(normalizarSolucaoDeDevolucao);
    expect(publico.SHOPEE_RETURNS_ERROR_ALIASES).toBe(SHOPEE_RETURNS_ERROR_ALIASES);
    expect(publico.SHOPEE_RETURN_SOLUTION).toBe(SHOPEE_RETURN_SOLUTION);
    expect(publico.shopeeReturnSolutionSchema).toBe(shopeeReturnSolutionSchema);
    expect(publico.SHOPEE_GET_RETURN_LIST_PATH).toBe(SHOPEE_GET_RETURN_LIST_PATH);
    expect(publico.SHOPEE_GET_RETURN_DETAIL_PATH).toBe(SHOPEE_GET_RETURN_DETAIL_PATH);
    expect(publico.SHOPEE_GET_AVAILABLE_SOLUTIONS_PATH).toBe(SHOPEE_GET_AVAILABLE_SOLUTIONS_PATH);
    expect(publico.SHOPEE_RETURN_CONFIRM_PATH).toBe(SHOPEE_RETURN_CONFIRM_PATH);
    expect(publico.SHOPEE_RETURN_OFFER_PATH).toBe(SHOPEE_RETURN_OFFER_PATH);
    expect(publico.SHOPEE_RETURN_ACCEPT_OFFER_PATH).toBe(SHOPEE_RETURN_ACCEPT_OFFER_PATH);
    expect(publico.SHOPEE_RETURN_LIST_MAX_PAGE_SIZE).toBe(SHOPEE_RETURN_LIST_MAX_PAGE_SIZE);
    expect(publico.SHOPEE_RETURN_LIST_MAX_WINDOW_SECONDS).toBe(
      SHOPEE_RETURN_LIST_MAX_WINDOW_SECONDS,
    );
    // Os esquemas de resposta são de `types.ts` — e saem pela mesma porta.
    expect(publico.shopeeReturnDetailSchema).toBe(shopeeReturnDetailSchema);
    expect(publico.shopeeReturnDetailBodySchema).toBe(shopeeReturnDetailBodySchema);
    expect(publico.shopeeReturnListSchema).toBe(shopeeReturnListSchema);
    expect(publico.shopeeReturnListRowSchema).toBe(shopeeReturnListRowSchema);
    expect(publico.shopeeReturnAvailableSolutionsSchema).toBe(shopeeReturnAvailableSolutionsSchema);
    expect(publico.shopeeReturnWriteSchema).toBe(shopeeReturnWriteSchema);
  });
});

describe('assertAlvoDeDevolucao — `return_sn` não-vazio, VERBATIM', () => {
  it('aceita o id ALFANUMÉRICO (o formato das amostras da doc) e o só-dígitos', () => {
    // ⚠️ Um guarda só-dígitos (o `Number.isSafeInteger(claimId)` do ML)
    // recusaria todo id real: as amostras da doc são alfanuméricas.
    expect(() => assertAlvoDeDevolucao({ returnSn: RETURN_SN_ALFANUMERICO })).not.toThrow();
    expect(() => assertAlvoDeDevolucao({ returnSn: RETURN_SN_DIGITOS })).not.toThrow();
  });

  it('JULGA e não REESCREVE: um id com espaço passa e o objeto sai intacto', () => {
    const alvo = { returnSn: ` ${RETURN_SN_ALFANUMERICO} ` };
    expect(() => assertAlvoDeDevolucao(alvo)).not.toThrow();
    expect(alvo.returnSn).toBe(` ${RETURN_SN_ALFANUMERICO} `);
  });

  it('recusa vazio, só-espaço e o que não é texto — sempre `ShopeeConfigError`', () => {
    for (const bruto of ['', ' ', '   ', '\t', '\n', null, undefined, 0, 2609100000000001, {}]) {
      const erro = recusa(() => assertAlvoDeDevolucao({ returnSn: bruto as string }));
      expect(erro.message, JSON.stringify(bruto)).toContain('return_sn');
    }
  });

  it('a mensagem NOMEIA o campo e NUNCA ecoa o valor recebido', () => {
    // Um `return_sn` identifica a devolução de um comprador: a recusa diz o
    // campo, um tamanho ou um tipo — nunca o id.
    const numerico = recusa(() =>
      assertAlvoDeDevolucao({ returnSn: 2609100000000001 as unknown as string }),
    );
    expect(numerico.message).not.toContain('2609100000000001');
    expect(numerico.message).toContain('number');

    const branco = recusa(() => assertAlvoDeDevolucao({ returnSn: '    ' }));
    expect(branco.message).toContain('4 caracteres');
  });
});

describe('assertReturnListParams — os limites de `get_return_list`', () => {
  const BASE: GetReturnListParams = { pageNo: 0, pageSize: 100 };

  it('a página mínima passa: `page_no` 0, `page_size` 100, sem janela', () => {
    expect(() => assertReturnListParams(BASE)).not.toThrow();
    expect(() => assertReturnListParams({ pageNo: 7, pageSize: 1 })).not.toThrow();
  });

  it('`page_size` fora de 1…100 é RECUSADO — 101 incluído', () => {
    for (const pageSize of [0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const erro = recusa(() => assertReturnListParams({ ...BASE, pageSize }));
      expect(erro.message, String(pageSize)).toContain('page_size');
    }
    for (const pageSize of ['10', null]) {
      const erro = recusa(() =>
        assertReturnListParams({ ...BASE, pageSize: pageSize as unknown as number }),
      );
      expect(erro.message).toContain('page_size');
    }
  });

  it('`page_no` aceita 0 e qualquer inteiro seguro >= 0; recusa negativo, fração e texto', () => {
    expect(() => assertReturnListParams({ ...BASE, pageNo: 0 })).not.toThrow();
    expect(() => assertReturnListParams({ ...BASE, pageNo: 1 })).not.toThrow();
    for (const pageNo of [-1, 0.5, Number.NaN, '0' as unknown as number]) {
      const erro = recusa(() => assertReturnListParams({ ...BASE, pageNo }));
      expect(erro.message, String(pageNo)).toContain('page_no');
    }
  });

  it.each(['create', 'update'] as const)(
    'janela `%s_time`: 15 dias EXATOS passam; 15 dias + 1 s são RECUSADOS',
    (campo) => {
      const janela = (de: number, ate: number): GetReturnListParams =>
        campo === 'create'
          ? { ...BASE, createTimeFromS: de, createTimeToS: ate }
          : { ...BASE, updateTimeFromS: de, updateTimeToS: ate };
      expect(() => assertReturnListParams(janela(T0, T0 + 15 * DIA))).not.toThrow();
      const erro = recusa(() => assertReturnListParams(janela(T0, T0 + 15 * DIA + 1)));
      expect(erro.message).toContain(`${campo}_time`);
      expect(erro.message).toContain('15 dias');
    },
  );

  it.each(['create', 'update'] as const)(
    'janela `%s_time`: MEIA janela é recusada, nunca completada',
    (campo) => {
      const so = (lado: 'From' | 'To'): GetReturnListParams =>
        ({ ...BASE, [`${campo}Time${lado}S`]: T0 }) as GetReturnListParams;
      for (const lado of ['From', 'To'] as const) {
        const erro = recusa(() => assertReturnListParams(so(lado)));
        expect(erro.message, lado).toContain(`${campo}_time_from e ${campo}_time_to vão juntos`);
      }
    },
  );

  it.each(['create', 'update'] as const)(
    'janela `%s_time`: `from` igual ou depois de `to`, segundo não-positivo ou fracionário — recusados',
    (campo) => {
      const janela = (de: number, ate: number): GetReturnListParams =>
        campo === 'create'
          ? { ...BASE, createTimeFromS: de, createTimeToS: ate }
          : { ...BASE, updateTimeFromS: de, updateTimeToS: ate };
      for (const [de, ate] of [
        [T0, T0],
        [T0 + 1, T0],
      ] as const) {
        const erro = recusa(() => assertReturnListParams(janela(de, ate)));
        expect(erro.message, `${de}..${ate}`).toContain(`${campo}_time_from deve ser anterior`);
      }
      // Cada um destes é uma janela CURTA (bem abaixo de 15 dias), para que só
      // o guarda de segundos — e não o do tamanho — possa recusá-la.
      for (const [de, ate] of [
        [0, DIA],
        [-5, DIA],
        [T0 + 0.5, T0 + DIA],
        [T0, Number.NaN],
      ] as const) {
        const erro = recusa(() => assertReturnListParams(janela(de, ate)));
        expect(erro.message, `${de}..${ate}`).toContain('inteiro positivo em segundos');
      }
      expect(() => assertReturnListParams(janela(1, DIA))).not.toThrow();
      expect(() => assertReturnListParams(janela(T0, T0 + 1))).not.toThrow();
    },
  );

  it('só a janela de ATUALIZAÇÃO é permitida (registro 234 decide se a Shopee a aceita)', () => {
    expect(() =>
      assertReturnListParams({ ...BASE, updateTimeFromS: T0, updateTimeToS: T0 + DIA }),
    ).not.toThrow();
  });

  it('as duas janelas: `update_time_from` ANTES de `create_time_from` é recusado; igual e depois passam', () => {
    const duas = (criacaoDe: number, atualizacaoDe: number): GetReturnListParams => ({
      ...BASE,
      createTimeFromS: criacaoDe,
      createTimeToS: criacaoDe + DIA,
      updateTimeFromS: atualizacaoDe,
      updateTimeToS: atualizacaoDe + DIA,
    });
    const erro = recusa(() => assertReturnListParams(duas(T0, T0 - 1)));
    expect(erro.message).toContain('update_time_from deve ser >= create_time_from');
    expect(() => assertReturnListParams(duas(T0, T0))).not.toThrow();
    expect(() => assertReturnListParams(duas(T0, T0 + 1))).not.toThrow();
  });

  it('nenhuma recusa ecoa um VALOR — só o campo e o tipo', () => {
    const erro = recusa(() =>
      assertReturnListParams({ ...BASE, createTimeFromS: -T0, createTimeToS: T0 }),
    );
    expect(erro.message).not.toContain(String(T0));
  });
});

describe('assertOfferReturnParams — `offer`', () => {
  const BASE: OfferReturnParams = {
    returnSn: RETURN_SN_ALFANUMERICO,
    proposedSolution: SHOPEE_RETURN_SOLUTION.soReembolso,
  };

  it('aceita as duas soluções, com e sem valor; valores de até 2 casas passam', () => {
    for (const proposedSolution of shopeeReturnSolutionSchema.options) {
      expect(() => assertOfferReturnParams({ ...BASE, proposedSolution })).not.toThrow();
    }
    for (const valor of [10, 12.3, 12.34, 0.01, 1409.9]) {
      expect(
        () => assertOfferReturnParams({ ...BASE, proposedAdjustedRefundAmount: valor }),
        String(valor),
      ).not.toThrow();
    }
  });

  it('uma TERCEIRA casa decimal é RECUSADA, nunca arredondada (12.345)', () => {
    // ⚠️ O pacote nunca escolhe um valor que o chamador não escolheu: o app
    // arredonda com `roundReais` — e um valor que o app arredondou passa aqui
    // por construção.
    const erro = recusa(() =>
      assertOfferReturnParams({ ...BASE, proposedAdjustedRefundAmount: 12.345 }),
    );
    expect(erro.message).toContain('proposed_adjusted_refund_amount');
    expect(erro.message).toContain('duas casas');
    expect(erro.message).not.toContain('12.345');
    expect(erro.message).not.toContain(RETURN_SN_ALFANUMERICO);
  });

  it('valor zero, negativo, não-finito, `null` ou texto — recusados (ausente é a ÚNICA forma de não mandar)', () => {
    for (const valor of [0, -1, -0.01, Number.NaN, Number.POSITIVE_INFINITY, null, '12.34']) {
      const erro = recusa(() =>
        assertOfferReturnParams({
          ...BASE,
          proposedAdjustedRefundAmount: valor as unknown as number,
        }),
      );
      expect(erro.message, String(valor)).toContain('proposed_adjusted_refund_amount');
      expect(erro.message).not.toContain(RETURN_SN_ALFANUMERICO);
    }
  });

  it('`proposed_solution` só aceita a grafia de ESCRITA — nem o int de leitura, nem minúsculas', () => {
    for (const solucao of [
      'refund',
      'Refund',
      'RETURN_AND_REFUND',
      'REFUND_ONLY',
      '',
      0,
      1,
      null,
    ]) {
      const erro = recusa(() =>
        assertOfferReturnParams({
          ...BASE,
          proposedSolution: solucao as unknown as ShopeeReturnSolution,
        }),
      );
      expect(erro.message, String(solucao)).toContain('proposed_solution');
      expect(erro.message).toContain('RETURN_REFUND ou REFUND');
    }
  });

  it('o `return_sn` é julgado PRIMEIRO, pelo mesmo guarda', () => {
    const erro = recusa(() => assertOfferReturnParams({ ...BASE, returnSn: '  ' }));
    expect(erro.message).toContain('return_sn');
  });
});

describe('normalizarSolucaoDeDevolucao — as três grafias, um leitor (uma DOBRA)', () => {
  it('IGUAIS: 0 ≡ "0" ≡ "RETURN_REFUND"; 1 ≡ "1" ≡ "REFUND"', () => {
    for (const bruto of [0, '0', 'RETURN_REFUND']) {
      expect(normalizarSolucaoDeDevolucao(bruto), JSON.stringify(bruto)).toBe(
        SHOPEE_RETURN_SOLUTION.devolucaoEReembolso,
      );
    }
    for (const bruto of [1, '1', 'REFUND']) {
      expect(normalizarSolucaoDeDevolucao(bruto), JSON.stringify(bruto)).toBe(
        SHOPEE_RETURN_SOLUTION.soReembolso,
      );
    }
  });

  it('QUASE-IGUAIS ficam DISTINTOS (→ null): nada é aparado, rebaixado de caixa ou interpretado', () => {
    // ⚠️ O escopo da dobra é o contrato: um teste que só pergunta "dobra?"
    // não vê onde ela PARA. Cada linha abaixo é um vizinho de uma grafia
    // válida que uma dobra larga demais engoliria (#1372).
    for (const bruto of [
      2,
      -1,
      '2',
      ' 0',
      '0 ',
      '01',
      '1.0',
      1.5,
      'refund',
      'Refund',
      'return_refund',
      ' REFUND',
      'REFUND ',
      'RETURN_AND_REFUND',
      'REFUND_ONLY',
      '',
      null,
      undefined,
      true,
      false,
      {},
      [],
      [0],
      'constructor',
      '__proto__',
    ]) {
      expect(normalizarSolucaoDeDevolucao(bruto), JSON.stringify(bruto)).toBeNull();
    }
  });

  it('o valor de saída é sempre um membro do enum de ESCRITA', () => {
    for (const bruto of [0, '0', 'RETURN_REFUND', 1, '1', 'REFUND']) {
      const saida = normalizarSolucaoDeDevolucao(bruto);
      expect(shopeeReturnSolutionSchema.safeParse(saida).success).toBe(true);
    }
  });
});
