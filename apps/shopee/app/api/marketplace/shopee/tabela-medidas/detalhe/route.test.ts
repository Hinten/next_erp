/**
 * `GET /api/marketplace/shopee/tabela-medidas/detalhe` (#1526, step 18;
 * reconcile §2.5). `lerTabelaDeMedidasShopee`, the classifier and the
 * projector run REAL over a stub client whose answers are the PACKAGE-PARSED
 * doc samples in `__wire__` — their own suites own the projection's content;
 * what is pinned here is the ROUTE's: the PERM bit, the query ladder, the
 * 200 body (parsed with the ONE schema `apps/web` also parses it with), the
 * 404 with OUR sentence, the `kind === other` gate, the passthrough of every
 * other error, and `Cache-Control: no-store` on every answer.
 *
 * ⚠️ Shopee's two doc samples are DIFFERENT charts: the detail sample echoes
 * `700024639`, which is none of the list sample's ids. A clean 3×3 with
 * `problemas: []` therefore needs the request to name `700024639`; a list id
 * yields exactly one `id-divergente` (pinned below, never papered over).
 *
 * Mutants killed here: M44 (the catch without the `kind === other` gate), M45
 * (a stale id answered 502), M46 (the stale sentence under `error_data` read as
 * stale — must stay 502), M56 (`no-store` missing on an error answer), M57 (the
 * id reader accepting `0`, `1e5`, `' 7'`, `9007199254740993` — route half).
 *
 * ⚠️ Fixture and Shopee doc-sample ids only. Nothing reaches a network or a
 * real Firestore.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { z } from 'zod';
import { PERM } from '@delfrance/auth';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_GET_SIZE_CHART_DETAIL_PATH,
  SHOPEE_SURFACE,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  shopeeErrorFromEnvelope,
  type GetSizeChartDetailParams,
  type ShopeeApiError,
  type ShopeeSizeChartDetail,
} from '@delfrance/integrations-shopee';
import {
  INTEGRACAO_TIPO,
  PROBLEMA_TABELA_SHOPEE,
  projetarTabelaShopee,
  tabelaShopeeProjetadaSchema,
} from '@delfrance/schemas';

import { ShopeeContaNotConfiguredError } from '@/lib/shopee/core/shopee';
import {
  FIXTURE_SIZE_CHART_DETAIL_DOC,
  FIXTURE_SIZE_CHART_DETAIL_DOC_ID_INEXISTENTE,
  FIXTURE_SIZE_CHART_LIST_DOC_CATEGORIA_INVALIDA,
  lerDetalheDeTabelaDeMedidas,
  lerFixture,
} from '@/lib/shopee/fixtures/wireCorpus';
import { detalheTabelaMedidasDtoSchema } from '@/lib/shopee/tabelaMedidas/dto';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
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
/** The detail doc sample's OWN echo — the only id that projects with zero problemas. */
const ID_DO_SAMPLE = 700_024_639;
/** A list-sample id: same chart body, a DIFFERENT echo. */
const ID_DA_LISTA = 700_024_641;
const FRASE_INEXISTENTE = 'Size chart id not exist in this shop';
const FRASE_CATEGORIA = 'Category id is invalid';
const PATH = SHOPEE_GET_SIZE_CHART_DETAIL_PATH;

const AUTORIZADO = { authorization: 'Bearer t' };
const URL_BASE = 'http://localhost:3009/api/marketplace/shopee/tabela-medidas/detalhe';

const DETALHE_DOC: ShopeeSizeChartDetail = lerDetalheDeTabelaDeMedidas(
  FIXTURE_SIZE_CHART_DETAIL_DOC,
);

const corpoDeErroSchema = z.object({ error: z.string(), message: z.string() });

/** One of the pages' printed error examples, through the transport's own constructor. */
function erroDaFixture(file: string): ShopeeApiError {
  const corpo = corpoDeErroSchema.parse(lerFixture(file));
  return recusa(corpo.error, corpo.message);
}

function recusa(error: string, message: string | null): ShopeeApiError {
  return shopeeErrorFromEnvelope(
    { error, message, request_id: 'req-teste', warning: null },
    { path: PATH, httpStatus: 200, surface: SHOPEE_SURFACE.business },
  );
}

function autorizar(permissions: string): void {
  h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions });
}

function contexto(): void {
  h.loadCtx.mockResolvedValue({
    integracaoId: CONTA,
    conta: { tipo: INTEGRACAO_TIPO.shopee, ativo: true, shop_id: 987654 },
    createShopClient: () => ({ getSizeChartDetail: h.getSizeChartDetail }),
  });
}

function url(query: Record<string, string>): string {
  const u = new URL(URL_BASE);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}

const QUERY = { integracaoId: CONTA, sizeChartId: String(ID_DO_SAMPLE) };

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

let info: MockInstance;
let warn: MockInstance;
let erro: MockInstance;

function logs(): string {
  return JSON.stringify([...info.mock.calls, ...warn.mock.calls, ...erro.mock.calls]);
}

beforeEach(() => {
  h.verifyIdToken.mockReset();
  h.loadCtx.mockReset();
  h.getSizeChartDetail.mockReset();
  autorizar(PERM.integracao.read.toString());
  contexto();
  h.getSizeChartDetail.mockResolvedValue(DETALHE_DOC);
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  erro = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */

describe('auth — PERM.integracao.read', () => {
  it('sem Bearer ⇒ 401, sem conta carregada', async () => {
    const { status } = await responder(QUERY, {});
    expect(status).toBe(401);
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
    const { status, body } = await responder({ sizeChartId: String(ID_DO_SAMPLE) });
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'integracaoId é obrigatório.' });
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('sem sizeChartId ⇒ 400 com o nome do parâmetro', async () => {
    const { status, body } = await responder({ integracaoId: CONTA });
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'sizeChartId é obrigatório.' });
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  // M57, a metade da rota: cada valor seria um id VÁLIDO de outra tabela (ou o
  // sentinela de desanexar) para um leitor frouxo — e nenhum chega à conta.
  it.each([
    ['abc', 'sizeChartId deve conter apenas dígitos.'],
    ['0', 'sizeChartId deve ser um inteiro positivo.'],
    ['1e5', 'sizeChartId deve conter apenas dígitos.'],
    [' 7', 'sizeChartId deve conter apenas dígitos.'],
    [' 700024639', 'sizeChartId deve conter apenas dígitos.'],
    ['9007199254740993', 'sizeChartId deve ser um inteiro positivo.'],
  ])('sizeChartId=%j ⇒ 400 sem tocar a Shopee', async (raw, mensagem) => {
    const { status, body } = await responder({ integracaoId: CONTA, sizeChartId: raw });
    expect(status).toBe(400);
    expect(body).toEqual({ error: mensagem });
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(h.getSizeChartDetail).not.toHaveBeenCalled();
  });

  it('uma conta de outro tipo ⇒ 404', async () => {
    h.loadCtx.mockRejectedValue(new ShopeeContaNotConfiguredError('não é do tipo Shopee'));
    expect((await responder()).status).toBe(404);
    expect(h.getSizeChartDetail).not.toHaveBeenCalled();
  });
});

describe('200 — a tabela projetada, passada INTEIRA sob uma chave', () => {
  it('o sample da página pedido pelo PRÓPRIO id: 3×3, zero problemas, o DTO parseia', async () => {
    const { status, body } = await responder();

    expect(status).toBe(200);
    expect(Object.keys(body)).toEqual(['tabela']);
    expect(h.getSizeChartDetail).toHaveBeenCalledTimes(1);
    expect(h.getSizeChartDetail).toHaveBeenCalledWith({
      sizeChartId: ID_DO_SAMPLE,
    } satisfies GetSizeChartDetailParams);

    // O round trip inteiro: corpo do fio → schema do pacote → projetor → JSON →
    // o schema que o apps/web também usa. Uma cópia do projetor na rota (ou no
    // web) não passaria pela igualdade com a saída do projetor REAL.
    const { tabela } = detalheTabelaMedidasDtoSchema.parse(body);
    expect(tabela).toEqual(projetarTabelaShopee(ID_DO_SAMPLE, DETALHE_DOC));
    expect(tabelaShopeeProjetadaSchema.parse(body['tabela'])).toEqual(tabela);
    expect(tabela.sizeChartId).toBe(ID_DO_SAMPLE);
    expect(tabela.sizeChartName).toBe('testtestt');
    expect(tabela.colunas).toHaveLength(3);
    expect(tabela.linhas).toHaveLength(3);
    for (const linha of tabela.linhas ?? []) expect(linha).toHaveLength(3);
    expect(tabela.problemas).toEqual([]);
  });

  it('QUASE-IGUAL: um id da LISTA sobre o mesmo corpo ⇒ o id PEDIDO e exatamente um id-divergente', async () => {
    const { status, body } = await responder({
      integracaoId: CONTA,
      sizeChartId: String(ID_DA_LISTA),
    });

    expect(status).toBe(200);
    const { tabela } = detalheTabelaMedidasDtoSchema.parse(body);
    expect(tabela.sizeChartId).toBe(ID_DA_LISTA); // nunca o eco
    expect(tabela.problemas).toEqual([
      {
        codigo: PROBLEMA_TABELA_SHOPEE.idDivergente,
        coluna: null,
        linha: null,
        inputType: null,
        comprimentos: null,
        pedido: ID_DA_LISTA,
        recebido: ID_DO_SAMPLE,
      },
    ]);
    // A divergência é DADO dentro do 200, não erro — a grade ainda renderiza.
    expect(tabela.linhas).toHaveLength(3);
  });
});

describe('a tabela que não existe mais — 404 com a NOSSA frase', () => {
  it('M45: o exemplo de erro da própria página ⇒ 404 SHOPEE_TABELA_MEDIDAS_INEXISTENTE', async () => {
    h.getSizeChartDetail.mockRejectedValue(
      erroDaFixture(FIXTURE_SIZE_CHART_DETAIL_DOC_ID_INEXISTENTE),
    );
    const { status, cache, body } = await responder({
      integracaoId: CONTA,
      sizeChartId: String(ID_DA_LISTA),
    });

    expect(status).toBe(404);
    expect(cache).toBe('no-store');
    expect(body).toEqual({
      error: `A tabela de medidas ${String(ID_DA_LISTA)} não existe mais nesta loja da Shopee — escolha outra.`,
      code: 'SHOPEE_TABELA_MEDIDAS_INEXISTENTE',
      sizeChartId: ID_DA_LISTA,
    });
    // A frase da Shopee não chega ao corpo nem a um log.
    expect(JSON.stringify(body)).not.toContain(FRASE_INEXISTENTE);
    expect(logs()).not.toContain(FRASE_INEXISTENTE);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({
      integracaoId: CONTA,
      id: ID_DA_LISTA,
      motivo: 'tabela-inexistente',
      codigo: 'product.error_param',
    });
  });

  it('PAR: a mesma frase com outra caixa, ponto final e o prefixo do envelope ⇒ o mesmo 404', async () => {
    h.getSizeChartDetail.mockRejectedValue(
      recusa('error_param', 'Wrong parameters, detail: size chart id not exist in this shop.'),
    );
    const { status, body } = await responder();
    expect(status).toBe(404);
    expect(body['code']).toBe('SHOPEE_TABELA_MEDIDAS_INEXISTENTE');
  });

  it('M46 QUASE-IGUAL: a MESMA frase sob product.error_data ⇒ 502, não 404', async () => {
    h.getSizeChartDetail.mockRejectedValue(recusa('product.error_data', FRASE_INEXISTENTE));
    const { status, cache, body } = await responder();
    expect(status).toBe(502);
    expect(cache).toBe('no-store');
    expect(body).toMatchObject({
      code: 'SHOPEE_HTTP_ERROR',
      shopeeCode: 'product.error_data',
      kind: SHOPEE_ERROR_KIND.other,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('"Category id is invalid" é a resposta da LISTA, não desta rota ⇒ 502', async () => {
    h.getSizeChartDetail.mockRejectedValue(
      erroDaFixture(FIXTURE_SIZE_CHART_LIST_DOC_CATEGORIA_INVALIDA),
    );
    const { status, body } = await responder();
    expect(status).toBe(502);
    expect(body).toMatchObject({ code: 'SHOPEE_HTTP_ERROR', shopeeCode: 'product.error_param' });
    expect(body['code']).not.toBe('SHOPEE_TABELA_MEDIDAS_CATEGORIA_INVALIDA');
  });

  it('o código genérico com a frase genérica ⇒ 502 (o código sozinho não decide)', async () => {
    h.getSizeChartDetail.mockRejectedValue(recusa('product.error_param', 'parameter invalid'));
    expect((await responder()).status).toBe(502);
  });
});

describe('M44 — só o kind `other` é lido como recusa', () => {
  // Nenhum transporte constrói estes dois (error_param classifica como
  // `other`); eles existem para FIXAR a trava: sem o `kind === other`, a frase
  // decidiria e uma conta morta pediria "escolha outra" em vez de "reconecte".
  it('uma re-auth que carregasse a frase continua 409 SHOPEE_REAUTH_REQUIRED', async () => {
    h.getSizeChartDetail.mockRejectedValue(
      new ShopeeReauthRequiredError('Shopee respondeu product.error_param (HTTP 200)', {
        code: 'product.error_param',
        kind: SHOPEE_ERROR_KIND.reauth,
        httpStatus: 200,
        path: PATH,
        providerMessage: FRASE_INEXISTENTE,
      }),
    );
    const { status, cache, body } = await responder();
    expect(status).toBe(409);
    expect(cache).toBe('no-store');
    expect(body['code']).toBe('SHOPEE_REAUTH_REQUIRED');
  });

  it('um rate limit que carregasse a frase continua 502 com o kind', async () => {
    h.getSizeChartDetail.mockRejectedValue(
      new ShopeeRateLimitError('Shopee respondeu product.error_param (HTTP 200)', {
        code: 'product.error_param',
        kind: SHOPEE_ERROR_KIND.burst,
        httpStatus: 200,
        path: PATH,
        providerMessage: FRASE_INEXISTENTE,
      }),
    );
    const { status, body } = await responder();
    expect(status).toBe(502);
    expect(body).toMatchObject({ code: 'SHOPEE_HTTP_ERROR', kind: SHOPEE_ERROR_KIND.burst });
  });

  it('uma re-auth de verdade (shop_access_expired) ⇒ 409', async () => {
    h.getSizeChartDetail.mockRejectedValue(recusa('shop_access_expired', 'expired'));
    expect((await responder()).status).toBe(409);
  });
});

describe('os outros erros seguem o mapeador, sem retry', () => {
  it.each([
    ['burst', 'error_rate_limit', SHOPEE_ERROR_KIND.burst],
    ['cota diária', 'error_limit', SHOPEE_ERROR_KIND.daily],
  ])('rate limit (%s) ⇒ 502 SHOPEE_HTTP_ERROR + kind, UMA chamada', async (_t, code, kind) => {
    h.getSizeChartDetail.mockRejectedValue(recusa(code, 'too many'));
    const { status, cache, body } = await responder();
    expect(status).toBe(502);
    expect(cache).toBe('no-store');
    expect(body).toMatchObject({ code: 'SHOPEE_HTTP_ERROR', kind });
    expect(h.getSizeChartDetail).toHaveBeenCalledTimes(1);
  });

  it('um corpo fora do schema ⇒ 502 SHOPEE_BAD_RESPONSE', async () => {
    h.getSizeChartDetail.mockRejectedValue(
      new ShopeeSchemaError('Resposta inesperada da Shopee.', {
        campos: ['response.size_chart_table'],
        httpStatus: 200,
        path: PATH,
      }),
    );
    const { status, cache, body } = await responder();
    expect(status).toBe(502);
    expect(cache).toBe('no-store');
    expect(body['code']).toBe('SHOPEE_BAD_RESPONSE');
  });

  it('uma falha de rede ⇒ 503', async () => {
    h.getSizeChartDetail.mockRejectedValue(new ShopeeNetworkError('fetch falhou'));
    const { status, cache } = await responder();
    expect(status).toBe(503);
    expect(cache).toBe('no-store');
  });

  it('um erro que não é da Shopee sobe (regra 6)', async () => {
    h.getSizeChartDetail.mockRejectedValue(new TypeError('bug nosso'));
    await expect(GET(new Request(url(QUERY), { headers: AUTORIZADO }))).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});

describe('M56 — Cache-Control: no-store em TODA resposta', () => {
  it.each<[string, () => void, Record<string, string>, Record<string, string>, number]>([
    ['401', () => undefined, QUERY, {}, 401],
    ['403', () => autorizar('0'), QUERY, AUTORIZADO, 403],
    ['400', () => undefined, { integracaoId: CONTA, sizeChartId: '0' }, AUTORIZADO, 400],
    [
      '404 conta',
      () => h.loadCtx.mockRejectedValue(new ShopeeContaNotConfiguredError('outro tipo')),
      QUERY,
      AUTORIZADO,
      404,
    ],
    ['200', () => undefined, QUERY, AUTORIZADO, 200],
    [
      '404 inexistente',
      () =>
        h.getSizeChartDetail.mockRejectedValue(recusa('product.error_param', FRASE_INEXISTENTE)),
      QUERY,
      AUTORIZADO,
      404,
    ],
    [
      '502 recusa que não é desta rota',
      () => h.getSizeChartDetail.mockRejectedValue(recusa('product.error_param', FRASE_CATEGORIA)),
      QUERY,
      AUTORIZADO,
      502,
    ],
    [
      '409 re-auth',
      () => h.getSizeChartDetail.mockRejectedValue(recusa('shop_access_expired', 'expired')),
      QUERY,
      AUTORIZADO,
      409,
    ],
    [
      '503 rede',
      () => h.getSizeChartDetail.mockRejectedValue(new ShopeeNetworkError('fetch falhou')),
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
