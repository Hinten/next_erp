/**
 * `GET /api/marketplace/shopee/tabela-medidas/lista` (#1526, step 18;
 * reconcile §2.5). The taxonomy context, the tree cache, the leaf gate,
 * `listarTabelasDaCategoria` (the walk + the fan-out) and the classifier all run
 * REAL over a stub client whose pages are the PACKAGE-PARSED list doc sample (or
 * hand-made pages parsed by the same package schema). The walk's own edge cases
 * — the abort flag, the in-flight width, `sem-cursor` — are
 * `listarTabelasMedidas.test.ts`'s; what is pinned here is the ROUTE's: the PERM
 * bit, the query ladder, the three-valued leaf gate (ZERO list calls off a
 * leaf), the 200 built by name and parsed with the DTO schema, the two 404s, the
 * `kind === other` gate, the passthrough of every other error, and
 * `Cache-Control: no-store` on every answer.
 *
 * Mutants killed here: M44 (the catch without the `kind === other` gate), M46
 * (the list's sentence under `error_data` read as a refusal — must stay 502),
 * M47 (page 1 carries a `cursor` key — route half), M48 (a third list call),
 * M51 (an id repeated across pages listed twice — route half), M55 (a non-leaf
 * category calls `get_size_chart_list`), M56 (`no-store` missing on an error).
 *
 * ⚠️ Fixture and Shopee doc-sample ids only. Nothing reaches a network or a
 * real Firestore.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { z } from 'zod';
import { PERM } from '@delfrance/auth';
import { READ_CACHE_DISABLED_ENV, __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_GET_SIZE_CHART_DETAIL_PATH,
  SHOPEE_GET_SIZE_CHART_LIST_PATH,
  SHOPEE_SIZE_CHART_LIST_MAX_PAGE_SIZE,
  SHOPEE_SURFACE,
  ShopeeNetworkError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  shopeeErrorFromEnvelope,
  shopeeSizeChartListPayloadSchema,
  type GetSizeChartDetailParams,
  type GetSizeChartListParams,
  type ShopeeApiError,
  type ShopeeSizeChartDetail,
  type ShopeeSizeChartList,
} from '@delfrance/integrations-shopee';
import {
  INTEGRACAO_TIPO,
  listaTabelasMedidasDtoSchema as listaCompartilhadaSchema,
} from '@delfrance/schemas';

import { ShopeeContaNotConfiguredError } from '@/lib/shopee/core/shopee';
import {
  FIXTURE_SIZE_CHART_DETAIL_DOC,
  FIXTURE_SIZE_CHART_DETAIL_DOC_ID_INEXISTENTE,
  FIXTURE_SIZE_CHART_LIST_DOC,
  FIXTURE_SIZE_CHART_LIST_DOC_CATEGORIA_INVALIDA,
  lerDetalheDeTabelaDeMedidas,
  lerFixture,
  lerListaDeTabelasDeMedidas,
} from '@/lib/shopee/fixtures/wireCorpus';
import { listaTabelasMedidasDtoSchema } from '@/lib/shopee/tabelaMedidas/dto';
import { __setShopeeTaxonomiaClockForTests } from '@/lib/shopee/taxonomia/cache';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  getCategory: vi.fn(),
  getSizeChartList: vi.fn(),
  getSizeChartDetail: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  // `{}` has no writer at all: a Firestore write from this route would throw.
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => ({}),
}));

vi.mock('@/lib/shopee/core/shopee', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/core/shopee')>();
  return { ...actual, loadShopeeContext: h.loadCtx };
});

const { GET } = await import('./route');

/* -------------------------------------------------------------------------- */

const CONTA = 'int-1';
const RAIZ = 100_000;
const MEIO = 100_100;
/** Shopee's own size-chart doc-sample category — the LEAF of this tree. */
const FOLHA = 400_055;
const FRASE_CATEGORIA = 'Category id is invalid';
const FRASE_INEXISTENTE = 'Size chart id not exist in this shop';

const AUTORIZADO = { authorization: 'Bearer t' };
const URL_BASE = 'http://localhost:3009/api/marketplace/shopee/tabela-medidas/lista';

const LISTA_DOC: ShopeeSizeChartList = lerListaDeTabelasDeMedidas(FIXTURE_SIZE_CHART_LIST_DOC);
const DETALHE_DOC: ShopeeSizeChartDetail = lerDetalheDeTabelaDeMedidas(
  FIXTURE_SIZE_CHART_DETAIL_DOC,
);

function categoria(category_id: number, parent_category_id: number, has_children: boolean) {
  return {
    category_id,
    parent_category_id,
    has_children,
    original_category_name: `orig-${String(category_id)}`,
    display_category_name: `cat-${String(category_id)}`,
  };
}

const ARVORE = [
  categoria(RAIZ, 0, true),
  categoria(MEIO, RAIZ, true),
  categoria(FOLHA, MEIO, false),
];

/** A page through the PACKAGE's own payload schema — never a hand-typed shape. */
function pagina(ids: readonly number[], next_cursor: string, total_count: number | null) {
  return shopeeSizeChartListPayloadSchema.parse({
    size_chart_list: ids.map((size_chart_id) => ({ size_chart_id })),
    total_count,
    next_cursor,
  });
}

const nomeDe = (id: number) => `Tabela ${String(id)}`;

/** Per-id overrides of the detail answer; absent ⇒ the doc sample under that id. */
let detalhes: Map<number, Error>;

const corpoDeErroSchema = z.object({ error: z.string(), message: z.string() });

function erroDaFixture(file: string, path: string): ShopeeApiError {
  const corpo = corpoDeErroSchema.parse(lerFixture(file));
  return recusa(corpo.error, corpo.message, path);
}

function recusa(error: string, message: string | null, path: string): ShopeeApiError {
  return shopeeErrorFromEnvelope(
    { error, message, request_id: 'req-teste', warning: null },
    { path, httpStatus: 200, surface: SHOPEE_SURFACE.business },
  );
}

function autorizar(permissions: string): void {
  h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions });
}

function ctxDouble() {
  return {
    integracaoId: CONTA,
    conta: { tipo: INTEGRACAO_TIPO.shopee, shop_id: 987654, main_account_id: null },
    config: {
      partnerId: 1000001,
      partnerKey: 'chave-de-teste-nao-e-credencial',
      variationsPath: null,
    },
    readCredential: vi.fn(),
    getAccessToken: vi.fn(),
    createShopClient: () => ({
      getCategory: h.getCategory,
      getSizeChartList: h.getSizeChartList,
      getSizeChartDetail: h.getSizeChartDetail,
    }),
    exchangeAndPersist: vi.fn(),
  };
}

function url(query: Record<string, string>): string {
  const u = new URL(URL_BASE);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}

const QUERY = { integracaoId: CONTA, categoryId: String(FOLHA) };

async function responder(
  query: Record<string, string> = QUERY,
  headers: Record<string, string> = AUTORIZADO,
) {
  const res = await GET(new Request(url(query), { method: 'GET', headers }));
  return {
    status: res.status,
    cache: res.headers.get('Cache-Control'),
    body: (await res.json()) as Record<string, unknown>,
  };
}

/** The list call arguments, in call order. */
function chamadasDaLista(): GetSizeChartListParams[] {
  return h.getSizeChartList.mock.calls.map((c) => c[0] as GetSizeChartListParams);
}

let info: MockInstance;
let warn: MockInstance;
let erro: MockInstance;

function logs(): string {
  return JSON.stringify([...info.mock.calls, ...warn.mock.calls, ...erro.mock.calls]);
}

beforeEach(() => {
  h.verifyIdToken.mockReset();
  h.loadCtx.mockReset();
  h.getCategory.mockReset();
  h.getSizeChartList.mockReset();
  h.getSizeChartDetail.mockReset();
  __resetAllReadCaches();
  __setShopeeTaxonomiaClockForTests();
  vi.stubEnv(READ_CACHE_DISABLED_ENV, '');
  detalhes = new Map();
  autorizar(PERM.integracao.read.toString());
  h.loadCtx.mockResolvedValue(ctxDouble());
  h.getCategory.mockResolvedValue({ category_list: ARVORE });
  h.getSizeChartList.mockResolvedValue(LISTA_DOC);
  h.getSizeChartDetail.mockImplementation((p: GetSizeChartDetailParams) => {
    const falha = detalhes.get(p.sizeChartId);
    if (falha !== undefined) return Promise.reject(falha);
    return Promise.resolve({
      ...DETALHE_DOC,
      size_chart_id: p.sizeChartId,
      size_chart_name: nomeDe(p.sizeChartId),
    } satisfies ShopeeSizeChartDetail);
  });
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  erro = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  __resetAllReadCaches();
  __setShopeeTaxonomiaClockForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */

describe('auth — PERM.integracao.read', () => {
  it('sem Bearer ⇒ 401, sem conta carregada', async () => {
    expect((await responder(QUERY, {})).status).toBe(401);
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('sem nenhum bit ⇒ 403', async () => {
    autorizar('0');
    expect((await responder()).status).toBe(403);
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('QUASE-IGUAL: só integracao.WRITE ⇒ 403 — os bits são independentes', async () => {
    autorizar(PERM.integracao.write.toString());
    expect((await responder()).status).toBe(403);
    expect(h.loadCtx).not.toHaveBeenCalled();
  });
});

describe('a escada da query', () => {
  it('sem integracaoId ⇒ 400', async () => {
    const { status, body } = await responder({ categoryId: String(FOLHA) });
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'integracaoId é obrigatório.' });
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('sem categoryId ⇒ 400', async () => {
    const { status, body } = await responder({ integracaoId: CONTA });
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'categoryId é obrigatório.' });
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it.each([
    [' 400055', 'categoryId deve conter apenas dígitos.'], // não aparado
    ['1e5', 'categoryId deve conter apenas dígitos.'],
    ['0', 'categoryId deve ser um inteiro positivo.'],
  ])('categoryId=%j ⇒ 400 sem tocar a Shopee', async (raw, mensagem) => {
    const { status, body } = await responder({ integracaoId: CONTA, categoryId: raw });
    expect(status).toBe(400);
    expect(body).toEqual({ error: mensagem });
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(h.getSizeChartList).not.toHaveBeenCalled();
  });

  it('uma conta de outro tipo ⇒ 404', async () => {
    h.loadCtx.mockRejectedValue(new ShopeeContaNotConfiguredError('não é do tipo Shopee'));
    expect((await responder()).status).toBe(404);
    expect(h.getSizeChartList).not.toHaveBeenCalled();
  });
});

describe('a trava de folha (três valores)', () => {
  it('um id fora da árvore ⇒ 404 SHOPEE_CATEGORIA_DESCONHECIDA, o corpo do variacoes', async () => {
    const { status, body } = await responder({ integracaoId: CONTA, categoryId: '999999' });
    expect(status).toBe(404);
    expect(body).toEqual({
      error: 'Categoria 999999 não existe na árvore desta conta.',
      code: 'SHOPEE_CATEGORIA_DESCONHECIDA',
    });
    expect(h.getSizeChartList).not.toHaveBeenCalled();
  });

  it('M55: uma categoria do MEIO ⇒ 200 leaf:false com ZERO chamadas de lista e de detalhe', async () => {
    const { status, body } = await responder({ integracaoId: CONTA, categoryId: String(MEIO) });

    expect(status).toBe(200);
    expect(listaTabelasMedidasDtoSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      leaf: false,
      categoryId: MEIO,
      tabelas: [],
      totalCount: null,
      truncado: false,
      removidas: 0,
      idsIlegiveis: 0,
    });
    expect(h.getSizeChartList).not.toHaveBeenCalled();
    expect(h.getSizeChartDetail).not.toHaveBeenCalled();
    // O que a trava consulta é a árvore — uma leitura, cacheada por conta.
    expect(h.getCategory).toHaveBeenCalledTimes(1);
  });

  it('a raiz também não é folha — QUASE-IGUAL do caso acima no outro extremo', async () => {
    const { body } = await responder({ integracaoId: CONTA, categoryId: String(RAIZ) });
    expect(body).toMatchObject({ leaf: false, categoryId: RAIZ, tabelas: [] });
    expect(h.getSizeChartList).not.toHaveBeenCalled();
  });
});

describe('200 numa folha — a página do sample, os nomes do fan-out', () => {
  it('ids na ordem da Shopee, nomes do detalhe, corpo montado POR NOME e parseado pelo DTO', async () => {
    const { status, cache, body } = await responder();

    expect(status).toBe(200);
    expect(cache).toBe('no-store');
    expect(listaTabelasMedidasDtoSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      leaf: true,
      categoryId: FOLHA,
      tabelas: [700_024_641, 700_024_613, 700_024_605].map((sizeChartId) => ({
        sizeChartId,
        sizeChartName: nomeDe(sizeChartId),
        legivel: true,
      })),
      totalCount: 3,
      truncado: false,
      removidas: 0,
      idsIlegiveis: 0,
    });
  });

  // R1-F2 / R2-F14: the envelope is declared ONCE, in @delfrance/schemas, and
  // apps/web parses with that very object — so the route's REAL 200 parsing
  // here IS the browser's parse, not a twin's.
  it('o 200 real (folha e não-folha) é parseado pelo schema COMPARTILHADO de @delfrance/schemas — o mesmo objeto que o browser usa', async () => {
    expect(listaTabelasMedidasDtoSchema).toBe(listaCompartilhadaSchema);

    const folha = await responder();
    const naoFolha = await responder({ integracaoId: CONTA, categoryId: String(MEIO) });

    expect(listaCompartilhadaSchema.parse(folha.body)).toEqual(folha.body);
    expect(listaCompartilhadaSchema.parse(naoFolha.body)).toEqual(naoFolha.body);
    expect(Object.keys(folha.body).sort()).toEqual(
      Object.keys(listaCompartilhadaSchema.shape).sort(),
    );
  });

  it('M47: a página 1 vai com categoryId + pageSize e SEM a chave cursor; um detalhe por id', async () => {
    await responder();

    const chamadas = chamadasDaLista();
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toEqual({
      categoryId: FOLHA,
      pageSize: SHOPEE_SIZE_CHART_LIST_MAX_PAGE_SIZE,
    });
    expect(Object.keys(chamadas[0] ?? {}).sort()).toEqual(['categoryId', 'pageSize']);
    expect(h.getSizeChartDetail.mock.calls.map((c) => c[0] as GetSizeChartDetailParams)).toEqual(
      expect.arrayContaining([
        { sizeChartId: 700_024_641 },
        { sizeChartId: 700_024_613 },
        { sizeChartId: 700_024_605 },
      ]),
    );
    expect(h.getSizeChartDetail).toHaveBeenCalledTimes(3);
  });

  it('M51 + RT4: duas páginas — o cursor volta BYTE A BYTE e um id repetido aparece uma vez', async () => {
    const CURSOR = ' a+b/c= 1 '; // borda em branco: nunca aparado
    h.getSizeChartList
      .mockResolvedValueOnce(pagina([700_024_641, 700_024_613], CURSOR, 4))
      .mockResolvedValueOnce(pagina([700_024_613, 700_024_605, 700_024_597], '', 99));

    const { status, body } = await responder();

    expect(status).toBe(200);
    const chamadas = chamadasDaLista();
    expect(chamadas).toHaveLength(2);
    expect(chamadas[1]).toEqual({
      categoryId: FOLHA,
      pageSize: SHOPEE_SIZE_CHART_LIST_MAX_PAGE_SIZE,
      cursor: CURSOR,
    });
    expect(chamadas[1]?.cursor).toBe(CURSOR);
    const dto = listaTabelasMedidasDtoSchema.parse(body);
    expect(dto.tabelas.map((t) => t.sizeChartId)).toEqual([
      700_024_641, 700_024_613, 700_024_605, 700_024_597,
    ]);
    // O total da PRIMEIRA página — diagnóstico, nunca a condição de parada.
    expect(dto.totalCount).toBe(4);
    expect(dto.truncado).toBe(false);
    expect(h.getSizeChartDetail).toHaveBeenCalledTimes(4);
  });

  it('M48: duas páginas ainda com cursor ⇒ truncado, e NUNCA uma terceira chamada', async () => {
    h.getSizeChartList
      .mockResolvedValueOnce(pagina([700_024_641], 'c1', null))
      .mockResolvedValueOnce(pagina([700_024_613], 'c2', null))
      .mockResolvedValueOnce(pagina([700_024_605], '', null));

    const { body } = await responder();

    expect(h.getSizeChartList).toHaveBeenCalledTimes(2);
    expect(listaTabelasMedidasDtoSchema.parse(body)).toMatchObject({
      truncado: true,
      tabelas: [
        { sizeChartId: 700_024_641, legivel: true },
        { sizeChartId: 700_024_613, legivel: true },
      ],
    });
  });

  it('um detalhe "não existe mais" sai da lista e conta em removidas; os vizinhos ficam', async () => {
    detalhes.set(
      700_024_613,
      erroDaFixture(
        FIXTURE_SIZE_CHART_DETAIL_DOC_ID_INEXISTENTE,
        SHOPEE_GET_SIZE_CHART_DETAIL_PATH,
      ),
    );
    const { status, body } = await responder();

    expect(status).toBe(200);
    const dto = listaTabelasMedidasDtoSchema.parse(body);
    expect(dto.tabelas.map((t) => t.sizeChartId)).toEqual([700_024_641, 700_024_605]);
    expect(dto.removidas).toBe(1);
    expect(logs()).not.toContain(FRASE_INEXISTENTE);
  });

  it('um detalhe fora do schema vira linha legivel:false — ainda escolhível pelo id', async () => {
    detalhes.set(
      700_024_613,
      new ShopeeSchemaError('Resposta inesperada da Shopee.', {
        campos: ['response.size_chart_table'],
        httpStatus: 200,
        path: SHOPEE_GET_SIZE_CHART_DETAIL_PATH,
      }),
    );
    const { status, body } = await responder();

    expect(status).toBe(200);
    expect(listaTabelasMedidasDtoSchema.parse(body).tabelas).toEqual([
      { sizeChartId: 700_024_641, sizeChartName: nomeDe(700_024_641), legivel: true },
      { sizeChartId: 700_024_613, sizeChartName: null, legivel: false },
      { sizeChartId: 700_024_605, sizeChartName: nomeDe(700_024_605), legivel: true },
    ]);
  });

  it('um rate limit num detalhe derruba a leitura: 502 SHOPEE_HTTP_ERROR + kind, sem retry', async () => {
    detalhes.set(
      700_024_613,
      recusa('error_rate_limit', 'too many', SHOPEE_GET_SIZE_CHART_DETAIL_PATH),
    );
    const { status, cache, body } = await responder();

    expect(status).toBe(502);
    expect(cache).toBe('no-store');
    expect(body).toMatchObject({ code: 'SHOPEE_HTTP_ERROR', kind: SHOPEE_ERROR_KIND.burst });
    expect(
      h.getSizeChartDetail.mock.calls.filter(
        (c) => (c[0] as GetSizeChartDetailParams).sizeChartId === 700_024_613,
      ),
    ).toHaveLength(1);
  });
});

describe('a categoria que a Shopee recusa — 404 com a NOSSA frase', () => {
  it('o exemplo de erro da própria página ⇒ 404 SHOPEE_TABELA_MEDIDAS_CATEGORIA_INVALIDA', async () => {
    h.getSizeChartList.mockRejectedValue(
      erroDaFixture(
        FIXTURE_SIZE_CHART_LIST_DOC_CATEGORIA_INVALIDA,
        SHOPEE_GET_SIZE_CHART_LIST_PATH,
      ),
    );
    const { status, cache, body } = await responder();

    expect(status).toBe(404);
    expect(cache).toBe('no-store');
    expect(body).toEqual({
      error: `A Shopee não aceita a categoria ${String(FOLHA)} para tabelas de medidas nesta loja — escolha outra categoria.`,
      code: 'SHOPEE_TABELA_MEDIDAS_CATEGORIA_INVALIDA',
      categoryId: FOLHA,
    });
    // DISTINTO do 404 da nossa árvore: aqui a árvore conhece a folha.
    expect(body['code']).not.toBe('SHOPEE_CATEGORIA_DESCONHECIDA');
    expect(h.getSizeChartDetail).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain(FRASE_CATEGORIA);
    expect(logs()).not.toContain(FRASE_CATEGORIA);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({
      integracaoId: CONTA,
      id: FOLHA,
      motivo: 'categoria-invalida',
      codigo: 'product.error_param',
    });
  });

  it('M46 QUASE-IGUAL: a MESMA frase sob product.error_data ⇒ 502, não 404', async () => {
    h.getSizeChartList.mockRejectedValue(
      recusa('product.error_data', FRASE_CATEGORIA, SHOPEE_GET_SIZE_CHART_LIST_PATH),
    );
    const { status, cache, body } = await responder();
    expect(status).toBe(502);
    expect(cache).toBe('no-store');
    expect(body).toMatchObject({ code: 'SHOPEE_HTTP_ERROR', shopeeCode: 'product.error_data' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('"Size chart id not exist" na LISTA não é a resposta desta rota ⇒ 502', async () => {
    h.getSizeChartList.mockRejectedValue(
      recusa('product.error_param', FRASE_INEXISTENTE, SHOPEE_GET_SIZE_CHART_LIST_PATH),
    );
    const { status, body } = await responder();
    expect(status).toBe(502);
    expect(body['code']).toBe('SHOPEE_HTTP_ERROR');
  });
});

describe('M44 — só o kind `other` é lido como recusa', () => {
  // Nenhum transporte constrói este (error_param classifica como `other`); ele
  // existe para FIXAR a trava: sem `kind === other`, a frase decidiria e uma
  // conta morta responderia "categoria recusada" em vez de "reconecte".
  it('uma re-auth que carregasse a frase da categoria continua 409', async () => {
    h.getSizeChartList.mockRejectedValue(
      new ShopeeReauthRequiredError('Shopee respondeu product.error_param (HTTP 200)', {
        code: 'product.error_param',
        kind: SHOPEE_ERROR_KIND.reauth,
        httpStatus: 200,
        path: SHOPEE_GET_SIZE_CHART_LIST_PATH,
        providerMessage: FRASE_CATEGORIA,
      }),
    );
    const { status, cache, body } = await responder();
    expect(status).toBe(409);
    expect(cache).toBe('no-store');
    expect(body['code']).toBe('SHOPEE_REAUTH_REQUIRED');
  });
});

describe('os outros erros seguem o mapeador', () => {
  it.each([
    ['burst', 'error_rate_limit', SHOPEE_ERROR_KIND.burst],
    ['cota diária', 'error_limit', SHOPEE_ERROR_KIND.daily],
  ])(
    'rate limit (%s) na lista ⇒ 502 SHOPEE_HTTP_ERROR + kind, UMA chamada',
    async (_t, code, kind) => {
      h.getSizeChartList.mockRejectedValue(
        recusa(code, 'too many', SHOPEE_GET_SIZE_CHART_LIST_PATH),
      );
      const { status, body } = await responder();
      expect(status).toBe(502);
      expect(body).toMatchObject({ code: 'SHOPEE_HTTP_ERROR', kind });
      expect(h.getSizeChartList).toHaveBeenCalledTimes(1);
      expect(h.getSizeChartDetail).not.toHaveBeenCalled();
    },
  );

  it('uma re-auth de verdade ⇒ 409', async () => {
    h.getSizeChartList.mockRejectedValue(
      recusa('shop_access_expired', 'expired', SHOPEE_GET_SIZE_CHART_LIST_PATH),
    );
    expect((await responder()).status).toBe(409);
  });

  it('uma falha de rede ⇒ 503', async () => {
    h.getSizeChartList.mockRejectedValue(new ShopeeNetworkError('fetch falhou'));
    expect((await responder()).status).toBe(503);
  });

  it('um erro que não é da Shopee sobe (regra 6)', async () => {
    h.getSizeChartList.mockRejectedValue(new TypeError('bug nosso'));
    await expect(GET(new Request(url(QUERY), { headers: AUTORIZADO }))).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});

describe('M56 — Cache-Control: no-store em TODA resposta', () => {
  const LISTA = SHOPEE_GET_SIZE_CHART_LIST_PATH;
  it.each<[string, () => void, Record<string, string>, Record<string, string>, number]>([
    ['401', () => undefined, QUERY, {}, 401],
    ['403', () => autorizar('0'), QUERY, AUTORIZADO, 403],
    ['400', () => undefined, { integracaoId: CONTA }, AUTORIZADO, 400],
    [
      '404 conta',
      () => h.loadCtx.mockRejectedValue(new ShopeeContaNotConfiguredError('outro tipo')),
      QUERY,
      AUTORIZADO,
      404,
    ],
    [
      '404 desconhecida',
      () => undefined,
      { integracaoId: CONTA, categoryId: '999999' },
      AUTORIZADO,
      404,
    ],
    [
      '200 não-folha',
      () => undefined,
      { integracaoId: CONTA, categoryId: String(MEIO) },
      AUTORIZADO,
      200,
    ],
    ['200 folha', () => undefined, QUERY, AUTORIZADO, 200],
    [
      '404 categoria inválida',
      () =>
        h.getSizeChartList.mockRejectedValue(recusa('product.error_param', FRASE_CATEGORIA, LISTA)),
      QUERY,
      AUTORIZADO,
      404,
    ],
    [
      '502 recusa que não é desta rota',
      () =>
        h.getSizeChartList.mockRejectedValue(
          recusa('product.error_param', FRASE_INEXISTENTE, LISTA),
        ),
      QUERY,
      AUTORIZADO,
      502,
    ],
    [
      '409 re-auth',
      () => h.getSizeChartList.mockRejectedValue(recusa('shop_access_expired', 'expired', LISTA)),
      QUERY,
      AUTORIZADO,
      409,
    ],
    [
      '503 rede',
      () => h.getSizeChartList.mockRejectedValue(new ShopeeNetworkError('fetch falhou')),
      QUERY,
      AUTORIZADO,
      503,
    ],
  ])('%s', async (_t, preparar, query, headers, esperado) => {
    preparar();
    const { status, cache } = await responder(query, headers);
    expect(status).toBe(esperado);
    expect(cache).toBe('no-store');
  });
});
