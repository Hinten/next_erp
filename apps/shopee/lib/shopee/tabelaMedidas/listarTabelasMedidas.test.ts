import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { z } from 'zod';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_GET_SIZE_CHART_DETAIL_PATH,
  SHOPEE_GET_SIZE_CHART_LIST_PATH,
  SHOPEE_SIZE_CHART_LIST_MAX_PAGE_SIZE,
  SHOPEE_SURFACE,
  ShopeeConfigError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  assertSizeChartDetailParams,
  createShopeeClient,
  resolveShopeeHosts,
  shopeeErrorFromEnvelope,
  shopeeSizeChartDetailSchema,
  shopeeSizeChartListRowSchema,
  shopeeSizeChartListSchema,
  type GetSizeChartDetailParams,
  type GetSizeChartListParams,
  type ShopeeApiError,
  type ShopeeClient,
  type ShopeeSizeChartDetail,
  type ShopeeSizeChartList,
} from '@delfrance/integrations-shopee';
import { entradaTabelaShopeeSchema } from '@delfrance/schemas';

import {
  FIXTURE_SIZE_CHART_DETAIL_DOC,
  FIXTURE_SIZE_CHART_DETAIL_DOC_ID_INEXISTENTE,
  FIXTURE_SIZE_CHART_LIST_DOC,
  lerFixture,
  lerListaDeTabelasDeMedidas,
} from '../fixtures/wireCorpus';
import { listaTabelasMedidasDtoSchema } from './dto';
import {
  LARGURA_DOS_DETALHES,
  MAX_PAGINAS_TABELAS,
  TAMANHO_DA_PAGINA_TABELAS,
  listarTabelasDaCategoria,
} from './listarTabelasMedidas';

/* -------------------------------------------------------------------------- */
/*  Doubles — every page and detail goes through the PACKAGE's own schema,    */
/*  so the walker reads exactly what the real client resolves with.           */
/* -------------------------------------------------------------------------- */

const CATEGORIA = 400055;

/** One list page as the real op resolves it: the wire `response` through the op schema. */
function pagina(response: Record<string, unknown>): ShopeeSizeChartList {
  return shopeeSizeChartListSchema.parse({ error: '', message: '', response }).response;
}

/** One detail as the real op resolves it — a 1-column chart named `nome`, echoing `eco` (default: `id`). */
function detalhe(
  id: number,
  nome: string | null = `tabela-${String(id)}`,
  eco: number | null = id,
): ShopeeSizeChartDetail {
  return shopeeSizeChartDetailSchema.parse({
    error: '',
    message: '',
    response: {
      size_chart_id: eco,
      size_chart_name: nome,
      size_chart_table: {
        column_list: [
          {
            measurement: { display_name: 'Busto', input_type: 'Input Single Number', unit: 'cm' },
            measurement_value_list: [{ option: null, value: 90, min_value: null, max_value: null }],
          },
        ],
      },
    },
  }).response;
}

/** The error the transport really builds for an envelope (class, `kind`, `providerMessage`). */
function doEnvelope(error: string, message: string | null, path: string): ShopeeApiError {
  return shopeeErrorFromEnvelope(
    { error, message, request_id: null, warning: null },
    { path, httpStatus: 200, surface: SHOPEE_SURFACE.business },
  );
}

/** The detail page's own error example, from the committed body. */
function recusaIdInexistente(): ShopeeApiError {
  const corpo = lerFixture(FIXTURE_SIZE_CHART_DETAIL_DOC_ID_INEXISTENTE);
  if (typeof corpo !== 'object' || corpo === null || Array.isArray(corpo)) {
    throw new TypeError('corpo de erro inesperado');
  }
  const { error, message } = corpo;
  if (typeof error !== 'string' || typeof message !== 'string') {
    throw new TypeError('corpo de erro inesperado');
  }
  return doEnvelope(error, message, SHOPEE_GET_SIZE_CHART_DETAIL_PATH);
}

function limiteDeTaxa(path: string): ShopeeRateLimitError {
  const err = doEnvelope('error_rate_limit', 'too many requests', path);
  if (!(err instanceof ShopeeRateLimitError)) throw new TypeError('não é um limite de taxa');
  return err;
}

interface Duplo {
  readonly client: ShopeeClient;
  readonly getSizeChartList: MockInstance<
    (p: GetSizeChartListParams) => Promise<ShopeeSizeChartList>
  >;
  readonly getSizeChartDetail: MockInstance<
    (p: GetSizeChartDetailParams) => Promise<ShopeeSizeChartDetail>
  >;
}

/**
 * `paginas` answers the list calls IN ORDER (a page beyond it is a test bug and
 * throws); `detalhePara` answers each detail by id (default: a readable chart).
 */
function duplo(
  paginas: readonly (ShopeeSizeChartList | Error)[],
  detalhePara: (id: number) => Promise<ShopeeSizeChartDetail> = (id) =>
    Promise.resolve(detalhe(id)),
): Duplo {
  let chamada = 0;
  const getSizeChartList = vi.fn((_: GetSizeChartListParams) => {
    const proxima = paginas[chamada];
    chamada += 1;
    if (proxima === undefined) throw new Error('o teste não previu esta página');
    return proxima instanceof Error ? Promise.reject(proxima) : Promise.resolve(proxima);
  });
  const getSizeChartDetail = vi.fn((p: GetSizeChartDetailParams) => detalhePara(p.sizeChartId));
  const client = { getSizeChartList, getSizeChartDetail } as unknown as ShopeeClient;
  return { client, getSizeChartList, getSizeChartDetail };
}

function idsDasTabelas(r: { readonly tabelas: readonly { readonly sizeChartId: number }[] }) {
  return r.tabelas.map((t) => t.sizeChartId);
}

/** Lets every settled continuation (and the pool's next pulls) run. */
async function drenar(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

let spyInfo: MockInstance<typeof console.info>;
let spyWarn: MockInstance<typeof console.warn>;

beforeEach(() => {
  spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
  spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*                                  the knobs                                  */
/* -------------------------------------------------------------------------- */

describe('os botões', () => {
  it('a página é o máximo do PACOTE (nenhum segundo literal), 2 páginas, largura 4', () => {
    expect(TAMANHO_DA_PAGINA_TABELAS).toBe(SHOPEE_SIZE_CHART_LIST_MAX_PAGE_SIZE);
    expect(TAMANHO_DA_PAGINA_TABELAS).toBe(50);
    expect(MAX_PAGINAS_TABELAS).toBe(2);
    expect(LARGURA_DOS_DETALHES).toBe(4);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  the walk                                   */
/* -------------------------------------------------------------------------- */

describe('listarTabelasDaCategoria — o exemplo da página', () => {
  it('três ids na ordem da Shopee, cada um com o nome do seu detalhe; uma página; completa', async () => {
    const d = duplo([lerListaDeTabelasDeMedidas(FIXTURE_SIZE_CHART_LIST_DOC)]);

    const r = await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);

    expect(r).toEqual({
      categoryId: CATEGORIA,
      tabelas: [
        { sizeChartId: 700024641, sizeChartName: 'tabela-700024641', legivel: true },
        { sizeChartId: 700024613, sizeChartName: 'tabela-700024613', legivel: true },
        { sizeChartId: 700024605, sizeChartName: 'tabela-700024605', legivel: true },
      ],
      totalCount: 3,
      truncado: false,
      removidas: 0,
      idsIlegiveis: 0,
    });
    expect(d.getSizeChartList).toHaveBeenCalledTimes(1);
    expect(d.getSizeChartDetail).toHaveBeenCalledTimes(3);
    // The route answers `{ leaf: true, …this }` — that body parses as the DTO.
    expect(listaTabelasMedidasDtoSchema.parse({ leaf: true, ...r })).toEqual({ leaf: true, ...r });
  });

  it('a página 1 NÃO leva a chave `cursor` — só categoryId e pageSize (M47)', async () => {
    const d = duplo([lerListaDeTabelasDeMedidas(FIXTURE_SIZE_CHART_LIST_DOC)]);
    await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);
    expect(d.getSizeChartList.mock.calls[0]?.[0]).toStrictEqual({
      categoryId: CATEGORIA,
      pageSize: SHOPEE_SIZE_CHART_LIST_MAX_PAGE_SIZE,
    });
  });

  it('cada detalhe é pedido com exatamente `{ sizeChartId }`', async () => {
    const d = duplo([lerListaDeTabelasDeMedidas(FIXTURE_SIZE_CHART_LIST_DOC)]);
    await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);
    expect(d.getSizeChartDetail.mock.calls.map((c) => c[0])).toStrictEqual([
      { sizeChartId: 700024641 },
      { sizeChartId: 700024613 },
      { sizeChartId: 700024605 },
    ]);
  });
});

describe('listarTabelasDaCategoria — o cursor', () => {
  it('RT4: o next_cursor da página 1 volta BYTE A BYTE na página 2 — brancos inclusive', async () => {
    const cursor = ' a+b/c= 1 ';
    const d = duplo([
      pagina({ size_chart_list: [{ size_chart_id: 1 }], total_count: 2, next_cursor: cursor }),
      pagina({ size_chart_list: [{ size_chart_id: 2 }], total_count: 2, next_cursor: '' }),
    ]);

    const r = await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);

    expect(d.getSizeChartList).toHaveBeenCalledTimes(2);
    expect(d.getSizeChartList.mock.calls[1]?.[0]).toStrictEqual({
      categoryId: CATEGORIA,
      pageSize: TAMANHO_DA_PAGINA_TABELAS,
      cursor,
    });
    expect(idsDasTabelas(r)).toEqual([1, 2]);
    expect(r.truncado).toBe(false);
  });

  it('um cursor em NÚMERO JSON volta como os seus dígitos (o leitor do pacote)', async () => {
    const d = duplo([
      pagina({ size_chart_list: [{ size_chart_id: 1 }], next_cursor: 1683255510 }),
      pagina({ size_chart_list: [], next_cursor: '' }),
    ]);
    await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);
    expect(d.getSizeChartList.mock.calls[1]?.[0]?.cursor).toBe('1683255510');
  });

  it('o teto: duas páginas que ainda dizem `seguinte` ⇒ exatamente 2 chamadas, truncado (M48)', async () => {
    const d = duplo([
      pagina({ size_chart_list: [{ size_chart_id: 1 }], total_count: 9, next_cursor: 'c1' }),
      pagina({ size_chart_list: [{ size_chart_id: 2 }], total_count: 9, next_cursor: 'c2' }),
    ]);

    const r = await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);

    expect(d.getSizeChartList).toHaveBeenCalledTimes(MAX_PAGINAS_TABELAS);
    expect(r.truncado).toBe(true);
    expect(idsDasTabelas(r)).toEqual([1, 2]);
    // The cap is not a non-advancing cursor — no warn.
    expect(spyWarn).not.toHaveBeenCalled();
  });

  it('um cursor que NÃO avança ⇒ para, truncado, UM aviso — sem o cursor no log (M49)', async () => {
    const d = duplo([
      pagina({ size_chart_list: [{ size_chart_id: 1 }], next_cursor: 'mesmo' }),
      pagina({ size_chart_list: [{ size_chart_id: 2 }], next_cursor: 'mesmo' }),
    ]);

    const r = await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);

    expect(r.truncado).toBe(true);
    expect(d.getSizeChartList).toHaveBeenCalledTimes(2);
    expect(spyWarn).toHaveBeenCalledTimes(1);
    expect(String(spyWarn.mock.calls[0]?.[0])).toContain('cursor não avançou');
    expect(JSON.stringify(spyWarn.mock.calls[0])).not.toContain('mesmo');
  });

  it('`next_cursor: ""` termina, mesmo com total_count MAIOR (o total nunca decide)', async () => {
    const d = duplo([
      pagina({ size_chart_list: [{ size_chart_id: 1 }], total_count: 50, next_cursor: '' }),
    ]);
    const r = await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);
    expect(r.truncado).toBe(false);
    expect(r.totalCount).toBe(50);
    expect(d.getSizeChartList).toHaveBeenCalledTimes(1);
  });

  // R2-F8: the "did not advance" test compares BYTES. A cursor that differs only
  // by an edge space IS a different cursor (register 250 — Shopee's text is
  // opaque), so a trimmed comparison would warn here, and would stop the walk
  // early the day the cap rises.
  it.each<[string, string]>([
    ['mesmo', 'mesmo '],
    [' mesmo', 'mesmo'],
  ])(
    'QUASE: %j e depois %j NÃO são o mesmo cursor — nenhum aviso de "não avançou"',
    async (c1, c2) => {
      const d = duplo([
        pagina({ size_chart_list: [{ size_chart_id: 1 }], next_cursor: c1 }),
        pagina({ size_chart_list: [{ size_chart_id: 2 }], next_cursor: c2 }),
      ]);

      const r = await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);

      expect(d.getSizeChartList).toHaveBeenCalledTimes(2);
      expect(d.getSizeChartList.mock.calls[1]?.[0]?.cursor).toBe(c1);
      // Truncated by the CAP, not by a non-advancing cursor.
      expect(r.truncado).toBe(true);
      expect(spyWarn).not.toHaveBeenCalled();
    },
  );

  it('um cursor que é só espaço NÃO é o fim — volta intacto', async () => {
    const d = duplo([
      pagina({ size_chart_list: [{ size_chart_id: 1 }], next_cursor: ' ' }),
      pagina({ size_chart_list: [], next_cursor: '' }),
    ]);
    const r = await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);
    expect(d.getSizeChartList.mock.calls[1]?.[0]?.cursor).toBe(' ');
    expect(r.truncado).toBe(false);
  });
});

describe('listarTabelasDaCategoria — `sem-cursor` não prova o fim (M50, registro 249)', () => {
  it.each<[string, Record<string, unknown>, boolean]>([
    [
      'cursor ausente, total atingido ⇒ completa',
      {
        size_chart_list: [{ size_chart_id: 1 }, { size_chart_id: 2 }, { size_chart_id: 3 }],
        total_count: 3,
      },
      false,
    ],
    [
      'cursor null, total atingido ⇒ completa',
      {
        size_chart_list: [{ size_chart_id: 1 }, { size_chart_id: 2 }, { size_chart_id: 3 }],
        total_count: 3,
        next_cursor: null,
      },
      false,
    ],
    [
      'QUASE: total uma unidade acima ⇒ truncado',
      {
        size_chart_list: [{ size_chart_id: 1 }, { size_chart_id: 2 }, { size_chart_id: 3 }],
        total_count: 4,
      },
      true,
    ],
    [
      'QUASE: total desconhecido ⇒ truncado',
      { size_chart_list: [{ size_chart_id: 1 }, { size_chart_id: 2 }, { size_chart_id: 3 }] },
      true,
    ],
    [
      'QUASE: 3 linhas mas 2 ids DISTINTOS contra total 3 ⇒ truncado',
      {
        size_chart_list: [{ size_chart_id: 1 }, { size_chart_id: 1 }, { size_chart_id: 2 }],
        total_count: 3,
      },
      true,
    ],
  ])('%s', async (_, response, truncado) => {
    const d = duplo([pagina(response)]);
    const r = await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);
    expect(r.truncado).toBe(truncado);
    expect(d.getSizeChartList).toHaveBeenCalledTimes(1);
  });

  it('o totalCount é o da PRIMEIRA página — e é ele que decide o sem-cursor da segunda', async () => {
    const d = duplo([
      pagina({ size_chart_list: [{ size_chart_id: 1 }], total_count: 2, next_cursor: 'c1' }),
      pagina({ size_chart_list: [{ size_chart_id: 2 }], total_count: 99 }),
    ]);
    const r = await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);
    expect(r.totalCount).toBe(2);
    expect(r.truncado).toBe(false);
  });
});

describe('listarTabelasDaCategoria — ids', () => {
  it('um id repetido entre páginas aparece UMA vez, na primeira posição; um detalhe por id (M51)', async () => {
    const d = duplo([
      pagina({ size_chart_list: [{ size_chart_id: 1 }, { size_chart_id: 2 }], next_cursor: 'c1' }),
      pagina({ size_chart_list: [{ size_chart_id: 2 }, { size_chart_id: 3 }], next_cursor: '' }),
    ]);

    const r = await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);

    expect(idsDasTabelas(r)).toEqual([1, 2, 3]);
    expect(d.getSizeChartDetail).toHaveBeenCalledTimes(3);
  });

  it('o MESMO número em texto e em número é um id só (a dobra do fio); ±1 são outros', async () => {
    const d = duplo([
      pagina({
        size_chart_list: [
          { size_chart_id: 700024641 },
          { size_chart_id: '700024641' },
          { size_chart_id: 700024640 },
          { size_chart_id: 700024642 },
        ],
        next_cursor: '',
      }),
    ]);
    const r = await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);
    expect(idsDasTabelas(r)).toEqual([700024641, 700024640, 700024642]);
  });

  it('linhas ilegíveis são CONTADAS em idsIlegiveis, somadas entre páginas, nunca listadas', async () => {
    const d = duplo([
      pagina({
        size_chart_list: [{ size_chart_id: 1 }, { size_chart_id: 'x' }, { size_chart_id: 0 }],
        next_cursor: 'c1',
      }),
      pagina({ size_chart_list: [{ size_chart_id: -1 }, { size_chart_id: 2 }], next_cursor: '' }),
    ]);

    const r = await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);

    expect(idsDasTabelas(r)).toEqual([1, 2]);
    expect(r.idsIlegiveis).toBe(3);
    expect(d.getSizeChartDetail.mock.calls.map((c) => c[0].sizeChartId)).toEqual([1, 2]);
  });

  it('um total_count ilegível vira null, sem custar a lista', async () => {
    const d = duplo([
      pagina({ size_chart_list: [{ size_chart_id: 1 }], total_count: 'muitos', next_cursor: '' }),
    ]);
    const r = await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);
    expect(r.totalCount).toBeNull();
    expect(idsDasTabelas(r)).toEqual([1]);
  });

  it.each<[string, Record<string, unknown>]>([
    ['size_chart_list vazia', { size_chart_list: [], total_count: 0, next_cursor: '' }],
    ['size_chart_list null', { size_chart_list: null, next_cursor: '' }],
  ])('%s ⇒ nenhuma tabela, nenhum detalhe', async (_, response) => {
    const d = duplo([pagina(response)]);
    const r = await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);
    expect(r.tabelas).toEqual([]);
    expect(r.truncado).toBe(false);
    expect(d.getSizeChartDetail).not.toHaveBeenCalled();
  });

  it('RT3 (metade das rotas): uma linha "700024641" em TEXTO vira o NÚMERO que a entrada do corpus aceita', async () => {
    const d = duplo([
      pagina({ size_chart_list: [{ size_chart_id: '700024641' }], next_cursor: '' }),
    ]);

    const r = await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);
    const linha = r.tabelas[0];

    expect(linha?.sizeChartId).toBe(700024641);
    expect(typeof linha?.sizeChartId).toBe('number');
    expect(d.getSizeChartDetail.mock.calls[0]?.[0]).toStrictEqual({ sizeChartId: 700024641 });
    expect(
      entradaTabelaShopeeSchema.parse({
        categoryId: CATEGORIA,
        size_chart_id: linha?.sizeChartId,
        name: 'Camisetas',
      }),
    ).toEqual({ categoryId: CATEGORIA, size_chart_id: 700024641, name: 'Camisetas' });
  });
});

describe('UMA tabela de valores atravessa os três leitores do id (pacote ⇔ guarda ⇔ corpus)', () => {
  // The list row reader, the detail guard and the stored entry's schema must agree:
  // an id Shopee LISTS must be DETAILABLE and STORABLE, and one any of them refuses
  // must be refused by all three.
  it.each<[unknown, number | null]>([
    [1, 1],
    [700024641, 700024641],
    ['700024641', 700024641],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    [2 ** 53, null],
    [0, null],
    [-1, null],
    [1.5, null],
    ['7e8', null],
  ])('%j ⇒ %j', (bruto, esperado) => {
    const linha = shopeeSizeChartListRowSchema.safeParse({ size_chart_id: bruto });
    const guardaAceita = (v: unknown): boolean => {
      try {
        assertSizeChartDetailParams({ sizeChartId: v as number });
        return true;
      } catch (err) {
        if (err instanceof ShopeeConfigError) return false;
        throw err;
      }
    };
    const corpusAceita = (v: unknown): boolean =>
      entradaTabelaShopeeSchema.shape.size_chart_id.safeParse(v).success;

    if (esperado === null) {
      expect(linha.success).toBe(false);
      // Nothing came out; the raw value is what the other two would have seen.
      expect(guardaAceita(bruto)).toBe(false);
      expect(corpusAceita(bruto)).toBe(false);
    } else {
      expect(linha.success).toBe(true);
      const saida = linha.data?.size_chart_id;
      expect(saida).toBe(esperado);
      expect(guardaAceita(saida)).toBe(true);
      expect(corpusAceita(saida)).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                                 the fan-out                                 */
/* -------------------------------------------------------------------------- */

describe('listarTabelasDaCategoria — o detalhe de cada id', () => {
  const tresIds = () =>
    pagina({
      size_chart_list: [{ size_chart_id: 11 }, { size_chart_id: 12 }, { size_chart_id: 13 }],
      next_cursor: '',
    });

  it('um id que a Shopee diz não existir (o erro da página) é REMOVIDO e contado; os outros ficam na ordem', async () => {
    const d = duplo([tresIds()], (id) =>
      id === 12 ? Promise.reject(recusaIdInexistente()) : Promise.resolve(detalhe(id)),
    );

    const r = await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);

    expect(idsDasTabelas(r)).toEqual([11, 13]);
    expect(r.removidas).toBe(1);
  });

  it('um detalhe ILEGÍVEL fica, legivel:false e sem nome, na sua posição; um aviso só com caminhos (M52)', async () => {
    const d = duplo([tresIds()], (id) =>
      id === 12
        ? Promise.reject(
            new ShopeeSchemaError('corpo ilegível', {
              campos: ['response.size_chart_table.column_list'],
              httpStatus: 200,
              path: SHOPEE_GET_SIZE_CHART_DETAIL_PATH,
            }),
          )
        : Promise.resolve(detalhe(id)),
    );

    const r = await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);

    expect(r.tabelas).toEqual([
      { sizeChartId: 11, sizeChartName: 'tabela-11', legivel: true },
      { sizeChartId: 12, sizeChartName: null, legivel: false },
      { sizeChartId: 13, sizeChartName: 'tabela-13', legivel: true },
    ]);
    expect(r.removidas).toBe(0);
    expect(spyWarn).toHaveBeenCalledTimes(1);
    expect(spyWarn.mock.calls[0]?.[1]).toEqual({
      sizeChartId: 12,
      campos: ['response.size_chart_table.column_list'],
    });
  });

  // R1-F3: a detail answering for ANOTHER template must not name the listed
  // one — the operator would pick 12 by 13's name, and only "Ver" would say so.
  it('um detalhe que ecoa OUTRO size_chart_id: a linha fica SEM o nome do outro, legivel:false, contada, um aviso com os dois ids', async () => {
    const d = duplo([tresIds()], (id) =>
      Promise.resolve(id === 12 ? detalhe(12, 'nome-da-13', 13) : detalhe(id)),
    );

    const r = await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);

    expect(r.tabelas).toEqual([
      { sizeChartId: 11, sizeChartName: 'tabela-11', legivel: true },
      { sizeChartId: 12, sizeChartName: null, legivel: false },
      { sizeChartId: 13, sizeChartName: 'tabela-13', legivel: true },
    ]);
    expect(r.removidas).toBe(0);
    expect(spyWarn).toHaveBeenCalledTimes(1);
    expect(String(spyWarn.mock.calls[0]?.[0])).toContain('OUTRA tabela');
    expect(spyWarn.mock.calls[0]?.[1]).toEqual({ sizeChartId: 12, recebido: 13 });
    expect(JSON.stringify([...spyWarn.mock.calls, ...spyInfo.mock.calls])).not.toContain(
      'nome-da-13',
    );
    expect(spyInfo.mock.calls[0]?.[1]).toMatchObject({ divergentes: 1, ilegiveis: 0 });
  });

  // The pair and the near-misses of the echo rule, at the list: EQUAL and ABSENT
  // name the row; ±1 does not.
  it.each<[string, number | null, boolean]>([
    ['eco IGUAL ao pedido ⇒ nomeada', 12, true],
    ['eco ausente (null) ⇒ nomeada — nada prova outra tabela', null, true],
    ['QUASE: eco = pedido + 1 ⇒ sem nome', 13, false],
    ['QUASE: eco = pedido − 1 ⇒ sem nome', 11, false],
  ])('%s', async (_, eco, legivel) => {
    const d = duplo([tresIds()], (id) =>
      Promise.resolve(id === 12 ? detalhe(12, 'nome-do-detalhe', eco) : detalhe(id)),
    );

    const r = await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);

    expect(r.tabelas[1]).toEqual({
      sizeChartId: 12,
      sizeChartName: legivel ? 'nome-do-detalhe' : null,
      legivel,
    });
  });

  it('um nome ausente no detalhe é null, e a linha continua legível', async () => {
    const d = duplo([tresIds()], (id) => Promise.resolve(detalhe(id, null)));
    const r = await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);
    expect(r.tabelas.map((t) => [t.sizeChartName, t.legivel])).toEqual([
      [null, true],
      [null, true],
      [null, true],
    ]);
  });

  it.each<[string, () => unknown]>([
    [
      'QUASE: "Category id is invalid" num detalhe (não é a resposta do detalhe)',
      () =>
        doEnvelope(
          'product.error_param',
          'Category id is invalid',
          SHOPEE_GET_SIZE_CHART_DETAIL_PATH,
        ),
    ],
    [
      'QUASE: a frase certa sob error_data',
      () =>
        doEnvelope(
          'product.error_data',
          'Size chart id not exist in this shop',
          SHOPEE_GET_SIZE_CHART_DETAIL_PATH,
        ),
    ],
    [
      'QUASE: a frase certa num erro de kind ≠ other (o kind vem PRIMEIRO)',
      () =>
        new ShopeeRateLimitError('limite', {
          code: 'product.error_param',
          kind: SHOPEE_ERROR_KIND.burst,
          httpStatus: 200,
          path: SHOPEE_GET_SIZE_CHART_DETAIL_PATH,
          providerMessage: 'Size chart id not exist in this shop',
        }),
    ],
    ['um limite de taxa', () => limiteDeTaxa(SHOPEE_GET_SIZE_CHART_DETAIL_PATH)],
    [
      'uma autorização morta',
      () => doEnvelope('error_shop_refresh_token', null, SHOPEE_GET_SIZE_CHART_DETAIL_PATH),
    ],
    ['uma falha de rede', () => new ShopeeNetworkError('caiu')],
    ['um erro estranho (regra 6)', () => new TypeError('bug')],
  ])('%s ⇒ ABORTA a lista e relança a MESMA instância', async (_, fazerErro) => {
    const erro = fazerErro();
    const d = duplo([tresIds()], (id) =>
      id === 12 ? Promise.reject(erro) : Promise.resolve(detalhe(id)),
    );

    await expect(listarTabelasDaCategoria({ client: d.client }, CATEGORIA)).rejects.toBe(erro);
    expect(spyInfo).not.toHaveBeenCalled();
  });

  it('uma autorização morta é ShopeeReauthRequiredError — nunca lida como tabela removida', async () => {
    const erro = doEnvelope('error_shop_refresh_token', null, SHOPEE_GET_SIZE_CHART_DETAIL_PATH);
    expect(erro).toBeInstanceOf(ShopeeReauthRequiredError);
    const d = duplo([tresIds()], () => Promise.reject(erro));
    await expect(listarTabelasDaCategoria({ client: d.client }, CATEGORIA)).rejects.toBe(erro);
  });

  it('uma falha na LISTA chega à rota intacta, sem nenhum detalhe pedido', async () => {
    const erro = limiteDeTaxa(SHOPEE_GET_SIZE_CHART_LIST_PATH);
    const d = duplo([erro]);
    await expect(listarTabelasDaCategoria({ client: d.client }, CATEGORIA)).rejects.toBe(erro);
    expect(d.getSizeChartDetail).not.toHaveBeenCalled();
  });

  it('UM console.info, só com contagens — nenhum nome de tabela', async () => {
    const d = duplo([tresIds()], (id) => Promise.resolve(detalhe(id, `segredo-${String(id)}`)));
    await listarTabelasDaCategoria({ client: d.client }, CATEGORIA);
    expect(spyInfo).toHaveBeenCalledTimes(1);
    const payload = spyInfo.mock.calls[0]?.[1];
    expect(payload).toEqual({
      categoryId: CATEGORIA,
      paginas: 1,
      ids: 3,
      tabelas: 3,
      truncado: false,
      removidas: 0,
      ilegiveis: 0,
      divergentes: 0,
      idsIlegiveis: 0,
    });
    expect(JSON.stringify(spyInfo.mock.calls)).not.toContain('segredo');
  });
});

/* -------------------------------------------------------------------------- */
/*                 the pool — width and abort, settled BY HAND                 */
/* -------------------------------------------------------------------------- */

/** Detail calls the test settles one by one, by id — so "in flight" is a number it reads. */
function detalhesNaMao() {
  const pendentes = new Map<
    number,
    { readonly resolver: () => void; readonly rejeitar: (e: unknown) => void }
  >();
  const iniciados: number[] = [];
  let emVoo = 0;
  let maximoEmVoo = 0;
  const detalhePara = (id: number): Promise<ShopeeSizeChartDetail> => {
    iniciados.push(id);
    emVoo += 1;
    maximoEmVoo = Math.max(maximoEmVoo, emVoo);
    return new Promise<ShopeeSizeChartDetail>((resolve, reject) => {
      pendentes.set(id, {
        resolver: () => {
          emVoo -= 1;
          resolve(detalhe(id));
        },
        rejeitar: (e) => {
          emVoo -= 1;
          reject(e);
        },
      });
    });
  };
  return {
    detalhePara,
    iniciados,
    emVoo: () => emVoo,
    maximoEmVoo: () => maximoEmVoo,
    pendentes: () => [...pendentes.keys()],
    liberar: (id: number, falha?: unknown) => {
      const p = pendentes.get(id);
      if (p === undefined) throw new Error(`nenhum detalhe pendente para ${String(id)}`);
      pendentes.delete(id);
      if (falha === undefined) p.resolver();
      else p.rejeitar(falha);
    },
  };
}

function paginaDeIds(ids: readonly number[]): ShopeeSizeChartList {
  return pagina({ size_chart_list: ids.map((id) => ({ size_chart_id: id })), next_cursor: '' });
}

describe('listarTabelasDaCategoria — a largura e o aborto', () => {
  it('nunca mais que 4 detalhes em voo; liberados FORA de ordem, a lista sai na ordem da Shopee (M54)', async () => {
    const ids = [21, 22, 23, 24, 25, 26, 27, 28, 29, 30];
    const ctl = detalhesNaMao();
    const d = duplo([paginaDeIds(ids)], ctl.detalhePara);

    const promessa = listarTabelasDaCategoria({ client: d.client }, CATEGORIA);
    await drenar();
    expect(ctl.emVoo()).toBe(LARGURA_DOS_DETALHES);

    // Release the NEWEST pending call each time — the reverse of start order.
    for (;;) {
      const pendentes = ctl.pendentes();
      const ultimo = pendentes[pendentes.length - 1];
      if (ultimo === undefined) break;
      ctl.liberar(ultimo);
      await drenar();
      expect(ctl.emVoo()).toBeLessThanOrEqual(LARGURA_DOS_DETALHES);
    }

    const r = await promessa;
    expect(ctl.maximoEmVoo()).toBe(LARGURA_DOS_DETALHES);
    expect(idsDasTabelas(r)).toEqual(ids);
    expect(ctl.iniciados).toEqual(ids);
  });

  it('um limite de taxa no 1º detalhe: NENHUM detalhe COMEÇA depois dele, e a lista falha com ele (M53)', async () => {
    const ids = [31, 32, 33, 34, 35, 36, 37, 38];
    const ctl = detalhesNaMao();
    const d = duplo([paginaDeIds(ids)], ctl.detalhePara);
    const limite = limiteDeTaxa(SHOPEE_GET_SIZE_CHART_DETAIL_PATH);

    const desfecho = listarTabelasDaCategoria({ client: d.client }, CATEGORIA).then(
      () => 'resolveu',
      (err: unknown) => err,
    );
    await drenar();
    expect(ctl.iniciados).toEqual([31, 32, 33, 34]);

    ctl.liberar(31, limite);
    await drenar();
    // The three already in flight finish; each sibling then pulls the next id and
    // must find the flag up.
    for (const id of [32, 33, 34]) {
      ctl.liberar(id);
      await drenar();
    }

    await expect(desfecho).resolves.toBe(limite);
    expect(ctl.iniciados).toEqual([31, 32, 33, 34]);
    expect(d.getSizeChartDetail).toHaveBeenCalledTimes(4);
  });
});

/* -------------------------------------------------------------------------- */
/*   RT4 — the REAL walk over the REAL package client; only `fetch` is fake    */
/* -------------------------------------------------------------------------- */

/** The signing keys every Shop-signed GET carries. */
const CHAVES_ASSINADAS = ['access_token', 'partner_id', 'shop_id', 'sign', 'timestamp'] as const;

/** Just enough of a committed body to derive a page or a detail from it, inline. */
const envelopeDaListaSchema = z
  .object({ response: z.object({ size_chart_list: z.array(z.unknown()) }).passthrough() })
  .passthrough();
const envelopeDoDetalheSchema = z.object({ response: z.object({}).passthrough() }).passthrough();

interface ChamadaHttp {
  readonly url: URL;
  readonly metodo: string | undefined;
  readonly corpo: unknown;
}

/**
 * A REAL `ShopeeClient` — the package's guards, signing, query builder,
 * envelope check and wire schemas — over a fake transport. List calls are
 * answered from `paginas` IN ORDER; each detail by `detalhePara(size_chart_id)`.
 */
function clienteReal(
  paginas: readonly unknown[],
  detalhePara: (sizeChartId: number) => unknown,
): { readonly client: ShopeeClient; readonly chamadas: ChamadaHttp[] } {
  const fila = [...paginas];
  const chamadas: ChamadaHttp[] = [];
  const transporte = vi.fn<typeof globalThis.fetch>((entrada, init) => {
    const url = new URL(
      typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url,
    );
    chamadas.push({ url, metodo: init?.method, corpo: init?.body });
    const corpo =
      url.pathname === SHOPEE_GET_SIZE_CHART_LIST_PATH
        ? fila.shift()
        : detalhePara(Number(url.searchParams.get('size_chart_id')));
    if (corpo === undefined) throw new Error(`o teste não previu ${url.pathname}`);
    return Promise.resolve(
      new Response(JSON.stringify(corpo), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  const client = createShopeeClient({
    partnerId: 1000001,
    partnerKey: 'chave-de-teste-nao-e-credencial',
    hosts: resolveShopeeHosts({ sandbox: true }),
    fetch: transporte,
    shopId: 987654,
    getAccessToken: () => Promise.resolve('access-inventado'),
  });
  return { client, chamadas };
}

const chavesDe = (c: ChamadaHttp) => [...c.url.searchParams.keys()].sort();

describe('RT4 — listarTabelasDaCategoria sobre o cliente REAL do pacote, com as fixtures commitadas', () => {
  it('as fixtures VERBATIM: um GET de lista sem cursor, um GET de detalhe por id — e o eco divergente da página nunca nomeia a linha', async () => {
    // Shopee's two doc samples show DIFFERENT charts (A.3): the detail echoes
    // 700024639, none of the list's ids — so, verbatim, every row is the R1-F3
    // case and must come back unnamed.
    const { client, chamadas } = clienteReal([lerFixture(FIXTURE_SIZE_CHART_LIST_DOC)], () =>
      lerFixture(FIXTURE_SIZE_CHART_DETAIL_DOC),
    );

    const r = await listarTabelasDaCategoria({ client }, CATEGORIA);

    expect(r).toEqual({
      categoryId: CATEGORIA,
      tabelas: [700024641, 700024613, 700024605].map((sizeChartId) => ({
        sizeChartId,
        sizeChartName: null,
        legivel: false,
      })),
      totalCount: 3,
      truncado: false,
      removidas: 0,
      idsIlegiveis: 0,
    });
    expect(chamadas).toHaveLength(4);
    for (const c of chamadas) {
      expect(c.metodo).toBe('GET');
      expect(c.corpo).toBeUndefined();
    }
    const [lista, ...detalhes] = chamadas;
    expect(lista?.url.pathname).toBe(SHOPEE_GET_SIZE_CHART_LIST_PATH);
    expect(lista && chavesDe(lista)).toEqual(
      [...CHAVES_ASSINADAS, 'category_id', 'page_size'].sort(),
    );
    expect(lista?.url.searchParams.get('category_id')).toBe(String(CATEGORIA));
    expect(lista?.url.searchParams.get('page_size')).toBe(String(TAMANHO_DA_PAGINA_TABELAS));
    expect(detalhes.map((c) => c.url.pathname)).toEqual(
      Array.from({ length: 3 }, () => SHOPEE_GET_SIZE_CHART_DETAIL_PATH),
    );
    for (const c of detalhes) {
      expect(chavesDe(c)).toEqual([...CHAVES_ASSINADAS, 'size_chart_id'].sort());
    }
    expect(detalhes.map((c) => c.url.searchParams.get('size_chart_id'))).toEqual([
      '700024641',
      '700024613',
      '700024605',
    ]);
    expect(spyWarn).toHaveBeenCalledTimes(3);
  });

  it('duas páginas derivadas da fixture: a página 2 leva o cursor BYTE A BYTE pela query; um detalhe que ecoa o pedido é nomeado', async () => {
    const CURSOR = ' a+b/c= 1 ';
    const fixtura = envelopeDaListaSchema.parse(lerFixture(FIXTURE_SIZE_CHART_LIST_DOC));
    const ids = fixtura.response.size_chart_list;
    const pagina1 = {
      ...fixtura,
      response: { ...fixtura.response, size_chart_list: ids.slice(0, 2), next_cursor: CURSOR },
    };
    const pagina2 = {
      ...fixtura,
      response: { ...fixtura.response, size_chart_list: ids.slice(2), next_cursor: '' },
    };
    const detalheDoc = envelopeDoDetalheSchema.parse(lerFixture(FIXTURE_SIZE_CHART_DETAIL_DOC));
    // The committed detail body under the REQUESTED id — its echo then agrees.
    const { client, chamadas } = clienteReal([pagina1, pagina2], (sizeChartId) => ({
      ...detalheDoc,
      response: { ...detalheDoc.response, size_chart_id: sizeChartId },
    }));

    const r = await listarTabelasDaCategoria({ client }, CATEGORIA);

    const listas = chamadas.filter((c) => c.url.pathname === SHOPEE_GET_SIZE_CHART_LIST_PATH);
    expect(listas).toHaveLength(2);
    expect(listas[0] && chavesDe(listas[0])).toEqual(
      [...CHAVES_ASSINADAS, 'category_id', 'page_size'].sort(),
    );
    expect(listas[1] && chavesDe(listas[1])).toEqual(
      [...CHAVES_ASSINADAS, 'category_id', 'cursor', 'page_size'].sort(),
    );
    expect(listas[1]?.url.searchParams.get('cursor')).toBe(CURSOR);
    expect(r.tabelas).toEqual(
      [700024641, 700024613, 700024605].map((sizeChartId) => ({
        sizeChartId,
        sizeChartName: 'testtestt',
        legivel: true,
      })),
    );
    expect(r.truncado).toBe(false);
    expect(r.totalCount).toBe(3);
    expect(spyWarn).not.toHaveBeenCalled();
  });
});
