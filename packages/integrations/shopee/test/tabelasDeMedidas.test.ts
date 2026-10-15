import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ShopeeConfigError } from '../src/errors';
import * as publico from '../src/index';
import {
  type GetSizeChartDetailParams,
  type GetSizeChartListParams,
  SHOPEE_GET_SIZE_CHART_DETAIL_PATH,
  SHOPEE_GET_SIZE_CHART_LIST_PATH,
  SHOPEE_SIZE_CHART_LIST_DRAINED,
  SHOPEE_SIZE_CHART_LIST_MAX_PAGE_SIZE,
  assertSizeChartDetailParams,
  assertSizeChartListParams,
  lerPaginaDeTabelasDeMedidas,
} from '../src/tabelasDeMedidas';
import { type ShopeeSizeChartList, shopeeSizeChartListPayloadSchema } from '../src/types';

/** Ids de AMOSTRA da própria doc da Shopee (públicos) — nunca de uma loja real. */
const CATEGORIA_DOC = 400055;
const TABELA_DOC = 700024641;

const FONTE = readFileSync(new URL('../src/tabelasDeMedidas.ts', import.meta.url), 'utf8');

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

/** `true` quando o guarda aceita; `false` quando recusa com `ShopeeConfigError`. */
function aceita(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch (err) {
    if (err instanceof ShopeeConfigError) return false;
    throw err;
  }
}

/** Uma página como o SCHEMA a entrega — o leitor só recebe o que o schema produziu. */
function pagina(response: Record<string, unknown>): ShopeeSizeChartList {
  return shopeeSizeChartListPayloadSchema.parse(response);
}

const LISTA_BASE: GetSizeChartListParams = { categoryId: CATEGORIA_DOC, pageSize: 50 };

describe('tabelas de medidas — os caminhos e as constantes do fio (passo 18)', () => {
  it('os dois caminhos são os do cabeçalho das páginas, byte a byte — SEM o espaço final do nome do módulo', () => {
    // ⚠️ M35: a listagem do módulo chama a página `"v2.product.get_size_chart_list "`
    // e o anúncio 1404 a linka com `%20`; o caminho do fio não leva nenhum dos dois.
    expect(SHOPEE_GET_SIZE_CHART_LIST_PATH).toBe('/api/v2/product/get_size_chart_list');
    expect(SHOPEE_GET_SIZE_CHART_DETAIL_PATH).toBe('/api/v2/product/get_size_chart_detail');
    for (const caminho of [SHOPEE_GET_SIZE_CHART_LIST_PATH, SHOPEE_GET_SIZE_CHART_DETAIL_PATH]) {
      expect(caminho).toBe(caminho.trim());
      expect(caminho).not.toMatch(/\s|%20/);
    }
  });

  it('a página tem no máximo 50, e o cursor esgotado é EXATAMENTE `""`', () => {
    expect(SHOPEE_SIZE_CHART_LIST_MAX_PAGE_SIZE).toBe(50);
    expect(SHOPEE_SIZE_CHART_LIST_DRAINED).toBe('');
  });

  it('saem pela porta pública do pacote (`index.ts` re-exporta o módulo por wildcard)', () => {
    expect(publico.SHOPEE_GET_SIZE_CHART_LIST_PATH).toBe(SHOPEE_GET_SIZE_CHART_LIST_PATH);
    expect(publico.SHOPEE_GET_SIZE_CHART_DETAIL_PATH).toBe(SHOPEE_GET_SIZE_CHART_DETAIL_PATH);
    expect(publico.SHOPEE_SIZE_CHART_LIST_MAX_PAGE_SIZE).toBe(SHOPEE_SIZE_CHART_LIST_MAX_PAGE_SIZE);
    expect(publico.SHOPEE_SIZE_CHART_LIST_DRAINED).toBe(SHOPEE_SIZE_CHART_LIST_DRAINED);
    expect(publico.assertSizeChartListParams).toBe(assertSizeChartListParams);
    expect(publico.assertSizeChartDetailParams).toBe(assertSizeChartDetailParams);
    expect(publico.lerPaginaDeTabelasDeMedidas).toBe(lerPaginaDeTabelasDeMedidas);
  });

  it('FONTE: o módulo nunca importa `api.ts` e não declara projeção de tabela (é do `@delfrance/schemas`)', () => {
    expect(FONTE).not.toMatch(/from '\.\/api'/);
    expect(FONTE).not.toContain('projetar');
    expect(FONTE).not.toContain('SHOPEE_SIZE_CHART_INPUT_TYPE =');
    // Só tipos de `./types` — nada de schema em tempo de execução neste módulo.
    expect(FONTE).toMatch(/import type \{ ShopeeSizeChartList \} from '\.\/types';/);
  });
});

describe('tabelas de medidas — os guardas (antes do token, nunca ecoam um valor)', () => {
  it('A3 — a lista aceita as duas bordas da página e um cursor de espaços; recusa cada vizinho', () => {
    expect(aceita(() => assertSizeChartListParams(LISTA_BASE))).toBe(true);
    expect(aceita(() => assertSizeChartListParams({ ...LISTA_BASE, pageSize: 1 }))).toBe(true);
    expect(
      aceita(() =>
        assertSizeChartListParams({
          ...LISTA_BASE,
          pageSize: SHOPEE_SIZE_CHART_LIST_MAX_PAGE_SIZE,
        }),
      ),
    ).toBe(true);
    expect(aceita(() => assertSizeChartListParams({ ...LISTA_BASE, cursor: '1683255510' }))).toBe(
      true,
    );
    // ⚠️ Só a sentinela é recusada: um cursor de espaços é JULGADO, nunca reescrito.
    expect(aceita(() => assertSizeChartListParams({ ...LISTA_BASE, cursor: ' ' }))).toBe(true);
    expect(aceita(() => assertSizeChartListParams({ ...LISTA_BASE, categoryId: 1 }))).toBe(true);
    expect(
      aceita(() =>
        assertSizeChartListParams({ ...LISTA_BASE, categoryId: Number.MAX_SAFE_INTEGER }),
      ),
    ).toBe(true);

    const ruins: readonly (readonly [string, Record<string, unknown>])[] = [
      ['categoryId 0', { categoryId: 0 }],
      ['categoryId -1', { categoryId: -1 }],
      ['categoryId 1.5', { categoryId: 1.5 }],
      ['categoryId NaN', { categoryId: Number.NaN }],
      ['categoryId 2**53', { categoryId: 2 ** 53 }],
      ['categoryId texto', { categoryId: String(CATEGORIA_DOC) }],
      ['pageSize 0', { pageSize: 0 }],
      // M33 — a página da Shopee diz "Max=50"; 51 e 100 (o teto de OUTRAS listas) são recusados.
      ['pageSize 51', { pageSize: SHOPEE_SIZE_CHART_LIST_MAX_PAGE_SIZE + 1 }],
      ['pageSize 100', { pageSize: 100 }],
      ['pageSize 1.5', { pageSize: 1.5 }],
      ['pageSize ausente', { pageSize: undefined }],
      // M28 — `''` é a última página E o padrão da Shopee: devolvê-lo recomeçaria da página 1.
      ['cursor vazio', { cursor: '' }],
      ['cursor número', { cursor: 1683255510 }],
      ['cursor null', { cursor: null }],
    ];
    for (const [rotulo, mudanca] of ruins) {
      const p = { ...LISTA_BASE, ...mudanca } as unknown as GetSizeChartListParams;
      expect(
        aceita(() => assertSizeChartListParams(p)),
        rotulo,
      ).toBe(false);
    }
  });

  it('A3 — o detalhe aceita um inteiro positivo seguro e recusa `0` (a sentinela de DESANEXAR) e cada vizinho', () => {
    expect(aceita(() => assertSizeChartDetailParams({ sizeChartId: TABELA_DOC }))).toBe(true);
    expect(aceita(() => assertSizeChartDetailParams({ sizeChartId: 1 }))).toBe(true);
    expect(
      aceita(() => assertSizeChartDetailParams({ sizeChartId: Number.MAX_SAFE_INTEGER })),
    ).toBe(true);
    for (const sizeChartId of [0, -1, 1.5, Number.NaN, 2 ** 53, String(TABELA_DOC), null]) {
      const p = { sizeChartId } as unknown as GetSizeChartDetailParams;
      expect(
        aceita(() => assertSizeChartDetailParams(p)),
        String(sizeChartId),
      ).toBe(false);
    }
  });

  it('a recusa nomeia o CAMPO e um tipo — nunca o valor', () => {
    const casos: readonly (readonly [() => void, string, string])[] = [
      [
        () => assertSizeChartListParams({ ...LISTA_BASE, categoryId: -987654321 }),
        'category_id',
        '987654321',
      ],
      [() => assertSizeChartListParams({ ...LISTA_BASE, pageSize: 4321 }), 'page_size', '4321'],
      [
        () =>
          assertSizeChartListParams({
            ...LISTA_BASE,
            cursor: 7654321 as unknown as string,
          }),
        'cursor',
        '7654321',
      ],
      [
        () => assertSizeChartDetailParams({ sizeChartId: -700024641 }),
        'size_chart_id',
        '700024641',
      ],
    ];
    for (const [fn, campo, valor] of casos) {
      const erro = recusa(fn);
      expect(erro.message, campo).toContain(campo);
      expect(erro.message, campo).not.toContain(valor);
    }
    expect(
      recusa(() => assertSizeChartListParams({ ...LISTA_BASE, cursor: '' })).message,
    ).toContain('cursor');
  });
});

describe('P1 — lerPaginaDeTabelasDeMedidas: a continuação de TRÊS valores', () => {
  it('a amostra da doc: três ids na ordem da Shopee, `total` 3, e `next_cursor: ""` é `fim`', () => {
    const lida = lerPaginaDeTabelasDeMedidas(
      pagina({
        next_cursor: '',
        size_chart_list: [
          { size_chart_id: 700024641 },
          { size_chart_id: 700024613 },
          { size_chart_id: 700024605 },
        ],
        total_count: 3,
      }),
    );
    expect(lida).toStrictEqual({
      ids: [700024641, 700024613, 700024605],
      linhasIlegiveis: 0,
      total: 3,
      continuacao: { estado: 'fim' },
    });
  });

  it('M30/M31 — `""` é `fim`, um cursor é `seguinte` VERBATIM, e ausente/`null` é `sem-cursor` (NÃO `fim`)', () => {
    const continuacao = (resto: Record<string, unknown>) =>
      lerPaginaDeTabelasDeMedidas(pagina({ size_chart_list: [], ...resto })).continuacao;

    expect(continuacao({ next_cursor: '' })).toStrictEqual({ estado: 'fim' });
    expect(continuacao({ next_cursor: 'x' })).toStrictEqual({ estado: 'seguinte', cursor: 'x' });
    // M29 — nada aparado: os bytes que vieram são os que voltam.
    expect(continuacao({ next_cursor: ' a+b/c= 1 ' })).toStrictEqual({
      estado: 'seguinte',
      cursor: ' a+b/c= 1 ',
    });
    // Um cursor de ESPAÇOS não é a sentinela: `' '` ≢ `''`.
    expect(continuacao({ next_cursor: ' ' })).toStrictEqual({ estado: 'seguinte', cursor: ' ' });
    expect(continuacao({})).toStrictEqual({ estado: 'sem-cursor' });
    expect(continuacao({ next_cursor: null })).toStrictEqual({ estado: 'sem-cursor' });
    // Um cursor-NÚMERO seguro chega como os seus dígitos (o schema o lê como texto).
    expect(continuacao({ next_cursor: 1683255510 })).toStrictEqual({
      estado: 'seguinte',
      cursor: '1683255510',
    });
  });

  it('M32 — `total_count` NUNCA termina: total atingido com um cursor de volta ainda é `seguinte`', () => {
    const lida = lerPaginaDeTabelasDeMedidas(
      pagina({ size_chart_list: [{ size_chart_id: 1 }], total_count: 1, next_cursor: 'x' }),
    );
    expect(lida.total).toBe(1);
    expect(lida.continuacao).toStrictEqual({ estado: 'seguinte', cursor: 'x' });
    // …e o inverso: total ZERO com `""` é `fim` pelo cursor, não pela contagem.
    const vazia = lerPaginaDeTabelasDeMedidas(pagina({ total_count: 0, next_cursor: '' }));
    expect(vazia.continuacao).toStrictEqual({ estado: 'fim' });
  });

  it('as linhas ilegíveis são CONTADAS e ficam fora de `ids`; a ordem é a da Shopee e nada é deduplicado', () => {
    const lida = lerPaginaDeTabelasDeMedidas(
      pagina({
        size_chart_list: [
          { size_chart_id: 3 },
          { size_chart_id: 'x' },
          null,
          { size_chart_id: 0 },
          { size_chart_id: 1 },
          { size_chart_id: 3 },
        ],
        total_count: 6,
        next_cursor: '',
      }),
    );
    expect(lida.ids).toStrictEqual([3, 1, 3]);
    expect(lida.linhasIlegiveis).toBe(3);
  });

  it('`size_chart_list` nulo ou ausente lê ZERO ids; `total_count` ilegível ou ausente lê `null`', () => {
    for (const resto of [{ size_chart_list: null }, {}]) {
      const lida = lerPaginaDeTabelasDeMedidas(pagina({ ...resto, next_cursor: '' }));
      expect(lida.ids).toStrictEqual([]);
      expect(lida.linhasIlegiveis).toBe(0);
      expect(lida.total).toBeNull();
    }
    expect(lerPaginaDeTabelasDeMedidas(pagina({ total_count: 'abc' })).total).toBeNull();
  });
});

describe('P2 — UMA tabela de valores, DOIS leitores: o que a lista aceita, o detalhe aceita', () => {
  /**
   * ⚠️ O leitor da LINHA (`types.ts`) e o guarda do DETALHE (`tabelasDeMedidas.ts`)
   * têm de recusar os MESMOS valores. Um id que a lista aceitasse e o guarda
   * recusasse voltaria da leitura do detalhe como um `ShopeeConfigError` — a
   * classe do NOSSO erro de configuração — sobre um dado da própria Shopee.
   */
  const TABELA: readonly (readonly [unknown, number | null])[] = [
    [1, 1],
    [TABELA_DOC, TABELA_DOC],
    // O PAR que dobra: o texto da tabela de parâmetros ≡ o número da amostra.
    [String(TABELA_DOC), TABELA_DOC],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    // Os quase-iguais que NÃO dobram.
    [2 ** 53, null],
    [0, null],
    ['0', null],
    [-1, null],
    [1.5, null],
    ['7e8', null],
    [String(TABELA_DOC + 1), TABELA_DOC + 1],
  ];

  it.each(TABELA)('%j → linha %j, e o guarda concorda', (bruto, esperado) => {
    const linha = shopeeSizeChartListPayloadSchema.parse({
      size_chart_list: [{ size_chart_id: bruto }],
    }).size_chart_list?.[0];
    const lido = linha === null || linha === undefined ? null : linha.size_chart_id;
    expect(lido).toBe(esperado);

    const doGuarda = aceita(() =>
      assertSizeChartDetailParams({
        sizeChartId: (lido ?? bruto) as number,
      }),
    );
    // ⇔: a linha aceita EXATAMENTE quando o guarda aceita o que ela produziu.
    expect(doGuarda).toBe(lido !== null);
  });
});
