/**
 * `GET /api/marketplace/shopee/reclamacao/estado` (#1525, step 17; reconcile
 * §2.8). `lerEstadoDevolucaoShopee` and the projection run REAL over a typed stub
 * client — their own suites own the estado's content; what is pinned here is the
 * ROUTE's: the PERM bit, the query ladder, `Cache-Control: no-store` on every
 * answer, the 404 and 502 mappings, the passthrough of every other error
 * WITHOUT Shopee's sentence (`semFraseDaShopee`, review R3-2), and zero
 * Firestore traffic.
 *
 * Mutants killed here: M109 (read/write PERM bits swapped — this route's half),
 * and D1-E-R13 (the `kind === other` test dropped), which the old passthrough
 * left EQUIVALENT: now a dead grant would answer the 502 instead of the 409.
 *
 * ⚠️ Fixture ids only. Nothing here reaches a network or a real Firestore.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { PERM } from '@delfrance/auth';
import {
  SHOPEE_GET_AVAILABLE_SOLUTIONS_PATH,
  SHOPEE_GET_RETURN_DETAIL_PATH,
  SHOPEE_ERROR_KIND,
  SHOPEE_SURFACE,
  ShopeeApiError as ShopeeApiErrorClasse,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  shopeeErrorFromEnvelope,
  shopeeReturnAvailableSolutionsSchema,
  shopeeReturnDetailSchema,
  type OfferReturnParams,
  type ShopeeAlvoDeDevolucao,
  type ShopeeApiError,
  type ShopeeClient,
  type ShopeeReturnAvailableSolutionsEnvelope,
  type ShopeeReturnDetailEnvelope,
} from '@delfrance/integrations-shopee';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import { ShopeeContaNotConfiguredError, type ShopeeContext } from '@/lib/shopee/core/shopee';
import type { DevolucaoResolveDeps } from '@/lib/shopee/devolucoes/acoesDevolucao';
import { projetarEstadoDevolucao } from '@/lib/shopee/devolucoes/estadoDevolucao';
import {
  FRASE_RECUSA_DEVOLUCAO,
  MOTIVO_RECUSA_DEVOLUCAO,
} from '@/lib/shopee/devolucoes/recusaDevolucao';
import { semFraseDaShopee } from '@/lib/shopee/devolucoes/respostaReclamacao';
import { MARCADOR_NAO_TOKEN } from '@/lib/shopee/devolucoes/tokenParaLog';
import { makePedidoIdShopee } from '@/lib/shopee/pedidos/orderIds';
import { FakeDb, asDb } from '@/lib/shopee/testing/fakeDb';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  db: { atual: null as unknown },
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db.atual,
  getAdminApp: () => {
    throw new Error('o app admin REAL não pode ser usado por este teste');
  },
  tryGetAdminBucket: () => null,
}));

// Where a client (and a token read) would start.
vi.mock('@/lib/shopee/core/shopee', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/core/shopee')>();
  return { ...actual, loadShopeeContext: h.loadCtx };
});

const {
  GET,
  CODIGO_FALHA_SHOPEE,
  CODIGO_INEXISTENTE,
  CODIGO_QUERY_INVALIDA,
  MSG_INTEGRACAO_ID_INVALIDO,
  MSG_RETURN_SN_INVALIDO,
  msgFalhaNaLeitura,
} = await import('./route');

/* -------------------------------------------------------------------------- */
/*  Identidades de teste — nenhuma delas é real.                               */
/* -------------------------------------------------------------------------- */

const CONTA = 'int-1';
const SHOP = 987654;
const ORDER_SN = '260910KJBHUJDM';
/** ALPHANUMERIC on purpose — a digits-only id would hide the one shape a digits guard breaks. */
const RETURN_SN = '260910ABCDE0001';
const UPDATE_S = 1_789_042_568;
const FRASE_DA_SHOPEE = 'Return record could not be located for this shop';

function envDetalhe(campos: Record<string, unknown> = {}): ShopeeReturnDetailEnvelope {
  return shopeeReturnDetailSchema.parse({
    error: '-',
    message: null,
    request_id: 'req-detalhe',
    response: {
      return_sn: RETURN_SN,
      order_sn: ORDER_SN,
      status: 'REQUESTED',
      update_time: UPDATE_S,
      return_refund_request_type: 0,
      validation_type: 'seller_validation',
      return_refund_type: 'RRBOC',
      refund_amount: 10.5,
      currency: 'BRL',
      return_seller_due_date: UPDATE_S + 86_400,
      negotiation: {
        negotiation_status: 'PENDING_RESPOND',
        latest_solution: 'REFUND',
        latest_offer_amount: 7.25,
      },
      ...campos,
    },
  });
}

function envSolucoes(): ShopeeReturnAvailableSolutionsEnvelope {
  return shopeeReturnAvailableSolutionsSchema.parse({
    error: ' ',
    request_id: 'req-sol',
    response: {
      return_sn: RETURN_SN,
      offer_return_refund: { eligibility: true, refund_amount_adjustable: false },
      offer_refund: {
        eligibility: true,
        refund_amount_adjustable: true,
        min_refund_amount: 5,
        max_refund_amount: 10.5,
      },
    },
  });
}

function recusa(
  error: string,
  message: string | null,
  path: string,
  retryAfterSeconds: number | null = null,
): ShopeeApiError {
  return shopeeErrorFromEnvelope(
    { error, message, request_id: 'req-recusa', warning: 'aviso-da-shopee' },
    { path, httpStatus: 200, surface: SHOPEE_SURFACE.business, retryAfterSeconds },
  );
}

type Resposta<T> = T | Error;

interface Roteiro {
  readonly detalhe?: Resposta<ShopeeReturnDetailEnvelope>;
  readonly solucoes?: Resposta<ShopeeReturnAvailableSolutionsEnvelope>;
}

let ops: string[] = [];

function responderCom<T>(r: Resposta<T>): T {
  if (r instanceof Error) throw r;
  return r;
}

/** A FULL Pick of the five ops; a write here is a failure of the test, not a stub. */
function contexto(roteiro: Roteiro = {}): void {
  const escrever = (op: string) => () => {
    ops.push(op);
    return Promise.reject(new Error(`o estado nunca escreve na Shopee (${op})`));
  };
  const client: DevolucaoResolveDeps['client'] = {
    getReturnDetail: async (_p: ShopeeAlvoDeDevolucao) => {
      ops.push('getReturnDetail');
      return responderCom(roteiro.detalhe ?? envDetalhe());
    },
    getReturnAvailableSolutions: async (_p: ShopeeAlvoDeDevolucao) => {
      ops.push('getReturnAvailableSolutions');
      return responderCom(roteiro.solucoes ?? envSolucoes());
    },
    confirmReturn: escrever('confirmReturn'),
    offerReturn: (_p: OfferReturnParams) => escrever('offerReturn')(),
    acceptReturnOffer: escrever('acceptReturnOffer'),
  };
  h.loadCtx.mockResolvedValue({
    integracaoId: CONTA,
    conta: { tipo: INTEGRACAO_TIPO.shopee, ativo: true, shop_id: SHOP },
    createShopClient: () => client as unknown as ShopeeClient,
  } as unknown as ShopeeContext);
}

function perms(...bits: bigint[]): string {
  return bits.reduce((a, b) => a | b, 0n).toString();
}

function autorizar(permissions: string): void {
  h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions });
}

const AUTORIZADO = { authorization: 'Bearer t' };
const URL_BASE = 'http://localhost:3009/api/marketplace/shopee/reclamacao/estado';

function url(query: string): string {
  return `${URL_BASE}?${query}`;
}

const QUERY = `integracaoId=${CONTA}&returnSn=${RETURN_SN}`;

async function responder(query = QUERY, headers: Record<string, string> = AUTORIZADO) {
  const res = await GET(new Request(url(query), { method: 'GET', headers }));
  return {
    status: res.status,
    cache: res.headers.get('Cache-Control'),
    body: (await res.json()) as Record<string, unknown>,
  };
}

let db: FakeDb;
let info: MockInstance;
let warn: MockInstance;
let erro: MockInstance;

function logs(): string {
  return JSON.stringify([...info.mock.calls, ...warn.mock.calls, ...erro.mock.calls]);
}

beforeEach(() => {
  ops = [];
  db = new FakeDb();
  h.db.atual = asDb(db);
  h.verifyIdToken.mockReset();
  h.loadCtx.mockReset();
  autorizar(perms(PERM.incidenteResolucao.read));
  contexto();
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  erro = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */

describe('auth — PERM.incidenteResolucao.read', () => {
  it('sem Bearer ⇒ 401 (e no-store também)', async () => {
    const { status, cache } = await responder(QUERY, {});
    expect(status).toBe(401);
    expect(cache).toBe('no-store');
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('M109: só incidenteResolucao.WRITE ⇒ 403 — os bits são independentes', async () => {
    autorizar(perms(PERM.incidenteResolucao.write));
    const { status } = await responder();
    expect(status).toBe(403);
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('pedido.read sem o bit dedicado ⇒ 403', async () => {
    autorizar(perms(PERM.pedido.read));
    expect((await responder()).status).toBe(403);
  });

  it('M109 (par): só incidenteResolucao.READ ⇒ 200', async () => {
    expect((await responder()).status).toBe(200);
  });
});

describe('a query — 400 SHOPEE_RECLAMACAO_QUERY_INVALIDA antes de carregar a conta', () => {
  it.each<[string, string, string]>([
    ['sem integracaoId', `returnSn=${RETURN_SN}`, MSG_INTEGRACAO_ID_INVALIDO],
    ['integracaoId vazio', `integracaoId=&returnSn=${RETURN_SN}`, MSG_INTEGRACAO_ID_INVALIDO],
    [
      'integracaoId com "/"',
      `integracaoId=int-1%2Fx&returnSn=${RETURN_SN}`,
      MSG_INTEGRACAO_ID_INVALIDO,
    ],
    ['integracaoId ".."', `integracaoId=..&returnSn=${RETURN_SN}`, MSG_INTEGRACAO_ID_INVALIDO],
    // naoDocId(' ') is false; the module refuses a blank id with a RangeError (500).
    [
      'integracaoId só espaços',
      `integracaoId=%20%20&returnSn=${RETURN_SN}`,
      MSG_INTEGRACAO_ID_INVALIDO,
    ],
    [
      'integracaoId repetido',
      `integracaoId=${CONTA}&integracaoId=int-2&returnSn=${RETURN_SN}`,
      MSG_INTEGRACAO_ID_INVALIDO,
    ],
    ['sem returnSn', `integracaoId=${CONTA}`, MSG_RETURN_SN_INVALIDO],
    ['returnSn vazio', `integracaoId=${CONTA}&returnSn=`, MSG_RETURN_SN_INVALIDO],
    [
      'returnSn com espaço (sem trim)',
      `integracaoId=${CONTA}&returnSn=%20${RETURN_SN}`,
      MSG_RETURN_SN_INVALIDO,
    ],
    ['returnSn com hífen', `integracaoId=${CONTA}&returnSn=260910-ABCDE`, MSG_RETURN_SN_INVALIDO],
    [
      'returnSn com 65 caracteres',
      `integracaoId=${CONTA}&returnSn=A${'1'.repeat(64)}`,
      MSG_RETURN_SN_INVALIDO,
    ],
    ['returnSn repetido', `${QUERY}&returnSn=2609100000000002`, MSG_RETURN_SN_INVALIDO],
  ])('%s', async (_titulo, query, mensagem) => {
    const { status, body, cache } = await responder(query);
    expect(status).toBe(400);
    expect(body).toEqual({ error: mensagem, code: CODIGO_QUERY_INVALIDA });
    expect(cache).toBe('no-store');
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(String(body['error'])).not.toContain(RETURN_SN);
  });

  it('par/quase: 64 caracteres passam; um return_sn só de dígitos passa também', async () => {
    for (const sn of [`A${'1'.repeat(63)}`, '2609100000000001']) {
      contexto({ detalhe: envDetalhe({ return_sn: sn }) });
      expect((await responder(`integracaoId=${CONTA}&returnSn=${sn}`)).status).toBe(200);
    }
  });
});

describe('200 — o estado VIVO, sem cache e sem Firestore', () => {
  it('o corpo É a projeção da leitura viva, com no-store', async () => {
    const { status, body, cache } = await responder();
    expect(status).toBe(200);
    expect(cache).toBe('no-store');
    expect(body).toEqual(
      JSON.parse(
        JSON.stringify(
          projetarEstadoDevolucao({
            integracaoId: CONTA,
            detalhe: envDetalhe().response,
            solucoes: envSolucoes().response,
          }),
        ),
      ),
    );
    expect(body['pedidoId']).toBe(makePedidoIdShopee(CONTA, ORDER_SN));
    expect(ops).toEqual(['getReturnDetail', 'getReturnAvailableSolutions']);
  });

  it('as chaves do corpo são EXATAMENTE as do contrato §2.8 (o gêmeo é wire.ts do web)', async () => {
    const { body } = await responder();
    expect(Object.keys(body).sort()).toEqual(
      [
        'returnSn',
        'orderSn',
        'pedidoId',
        'status',
        'terminal',
        'solucao',
        'motivo',
        'motivoReavaliado',
        'valorReembolso',
        'valorAntesDesconto',
        'moeda',
        'tipoRequisicao',
        'tipoValidacao',
        'negociacao',
        'prova',
        'compensacao',
        'prazos',
        'solucoes',
        'acoesDisponiveis',
        'motivoSemAcao',
        'pendenciasForaDoErp',
      ].sort(),
    );
  });

  it('uma devolução encerrada não paga a leitura das soluções', async () => {
    contexto({ detalhe: envDetalhe({ status: 'CLOSED' }) });
    const { status, body } = await responder();
    expect(status).toBe(200);
    expect(body['terminal']).toBe(true);
    expect(body['acoesDisponiveis']).toEqual([]);
    expect(ops).toEqual(['getReturnDetail']);
  });

  it('ZERO leituras e escritas no Firestore — e nenhuma escrita na Shopee', async () => {
    await responder();
    expect(db.writes).toEqual([]);
    expect(db.opLog).toEqual([]);
    expect(ops).not.toContain('confirmReturn');
  });

  it('a recusa "sem oferta possível" da leitura lateral ⇒ 200 com soluções vazias', async () => {
    contexto({
      solucoes: recusa(
        'error_data',
        'Type of return does not allow seller to offer refund',
        SHOPEE_GET_AVAILABLE_SOLUTIONS_PATH,
      ),
    });
    const { status, body } = await responder();
    expect(status).toBe(200);
    expect(body['solucoes']).toEqual([]);
  });
});

describe('os erros', () => {
  it('a devolução não existe ⇒ 404 INEXISTENTE com a NOSSA frase, no-store, e um log de ids', async () => {
    contexto({
      detalhe: recusa('error_data', "Return doesn't exist", SHOPEE_GET_RETURN_DETAIL_PATH),
    });
    const { status, body, cache } = await responder();
    expect(status).toBe(404);
    expect(cache).toBe('no-store');
    expect(body).toEqual({
      error: FRASE_RECUSA_DEVOLUCAO[MOTIVO_RECUSA_DEVOLUCAO.devolucaoInexistente],
      code: CODIGO_INEXISTENTE,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({
      integracaoId: CONTA,
      returnSn: RETURN_SN,
      codigo: 'error_data',
    });
  });

  it('"the return detail is not available" também é inexistente; a frase da Shopee não vai a corpo nem log', async () => {
    contexto({
      detalhe: recusa(
        'error_data',
        `${FRASE_DA_SHOPEE} — The return detail is not available.`,
        SHOPEE_GET_RETURN_DETAIL_PATH,
      ),
    });
    const { status, body } = await responder();
    expect(status).toBe(404);
    expect(JSON.stringify(body)).not.toContain(FRASE_DA_SHOPEE);
    expect(logs()).not.toContain(FRASE_DA_SHOPEE);
  });

  it('R3-2: error_param ⇒ 502 FALHA_SHOPEE com a NOSSA frase — nunca a da Shopee, nem no corpo nem no log', async () => {
    const frase = 'Return SN or ID is invalid.';
    contexto({ detalhe: recusa('error_param', frase, SHOPEE_GET_RETURN_DETAIL_PATH) });
    const { status, body, cache } = await responder();
    expect(status).toBe(502);
    expect(cache).toBe('no-store');
    expect(body).toEqual({
      error: msgFalhaNaLeitura('error_param'),
      code: CODIGO_FALHA_SHOPEE,
      codigoShopee: 'error_param',
    });
    expect(body['error']).toBe('A Shopee recusou a leitura da devolução (código error_param).');
    expect(JSON.stringify(body)).not.toContain(frase);
    expect(logs()).not.toContain(frase);
    // ONE line, ids + the classifier's motivo + the code — the mapper never ran.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(erro).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[1]).toEqual({
      integracaoId: CONTA,
      returnSn: RETURN_SN,
      motivo: MOTIVO_RECUSA_DEVOLUCAO.parametroInvalido,
      codigo: 'error_param',
    });
  });

  it.each<[string, string, string | null]>([
    ['um código desconhecido', 'error_novo_x', 'error_novo_x'],
    [
      'um código com módulo vai VERBATIM (sem o corte do classificador)',
      'returns.error_novo',
      'returns.error_novo',
    ],
    ['espaços e TAB nas pontas saem', '  error_novo_x\t', 'error_novo_x'],
    ['um código com 7 dígitos NÃO é ecoado (codigoSeguro)', 'error_1234567', null],
  ])('502 FALHA_SHOPEE: %s', async (_t, codigo, esperado) => {
    contexto({ detalhe: recusa(codigo, FRASE_DA_SHOPEE, SHOPEE_GET_RETURN_DETAIL_PATH) });
    const { status, body } = await responder();
    expect(status).toBe(502);
    expect(body).toEqual({
      error: msgFalhaNaLeitura(esperado),
      code: CODIGO_FALHA_SHOPEE,
      codigoShopee: esperado,
    });
    expect(JSON.stringify(body)).not.toContain(FRASE_DA_SHOPEE);
    expect(logs()).not.toContain(FRASE_DA_SHOPEE);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ motivo: null, codigo: esperado });
  });

  it('QUASE-IGUAL: 6 dígitos ainda são um código; a frase sem código diz "não informado"', () => {
    expect(msgFalhaNaLeitura('error_123456')).toBe(
      'A Shopee recusou a leitura da devolução (código error_123456).',
    );
    expect(msgFalhaNaLeitura(null)).toBe(
      'A Shopee recusou a leitura da devolução (código não informado).',
    );
  });

  it('error_data com uma frase que a tabela não conhece ⇒ 502, nunca 404', async () => {
    contexto({
      detalhe: recusa('error_data', 'Query shop info failed.', SHOPEE_GET_RETURN_DETAIL_PATH),
    });
    const { status, body } = await responder();
    expect(status).toBe(502);
    expect(body['code']).toBe(CODIGO_FALHA_SHOPEE);
    expect(body['codigoShopee']).toBe('error_data');
  });

  it.each<[string, () => Error, number, string]>([
    [
      'autorização morta',
      () => recusa('shop_access_expired', FRASE_DA_SHOPEE, SHOPEE_GET_RETURN_DETAIL_PATH),
      409,
      'SHOPEE_REAUTH_REQUIRED',
    ],
    [
      'um transitório (error_server) com a frase de inexistência NÃO vira 404',
      () =>
        recusa('error_server', `${FRASE_DA_SHOPEE} doesn't exist`, SHOPEE_GET_RETURN_DETAIL_PATH),
      502,
      'SHOPEE_HTTP_ERROR',
    ],
    [
      'limite de taxa (burst)',
      () => recusa('error_rate_limit', FRASE_DA_SHOPEE, SHOPEE_GET_RETURN_DETAIL_PATH, 7),
      502,
      'SHOPEE_HTTP_ERROR',
    ],
    [
      'cota diária',
      () => recusa('error_limit', FRASE_DA_SHOPEE, SHOPEE_GET_RETURN_DETAIL_PATH),
      502,
      'SHOPEE_HTTP_ERROR',
    ],
  ])(
    'R3-2: %s ⇒ o status e o código do mapeador, SEM a frase da Shopee (corpo e log)',
    async (_t, falha, status, code) => {
      contexto({ detalhe: falha() });
      const res = await responder();
      expect(res.status).toBe(status);
      expect(res.body['code']).toBe(code);
      expect(res.cache).toBe('no-store');
      expect(JSON.stringify(res.body)).not.toContain(FRASE_DA_SHOPEE);
      expect(logs()).not.toContain(FRASE_DA_SHOPEE);
      // The mapper DID run (its `[shopee/api]` line), on the sentence-free twin.
      expect(logs()).toContain('[shopee/api]');
    },
  );

  it('a rede ⇒ shopeeErrorResponse inalterado (a mensagem é nossa), com no-store', async () => {
    contexto({ detalhe: new ShopeeNetworkError('rede caiu') });
    const res = await responder();
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'rede caiu', code: 'SHOPEE_NETWORK_ERROR' });
    expect(res.cache).toBe('no-store');
  });

  it('a conta inexistente ⇒ 404 do mapeador, nenhuma chamada', async () => {
    h.loadCtx.mockRejectedValue(
      new ShopeeContaNotConfiguredError('Integração int-1 não encontrada.'),
    );
    const { status, body } = await responder();
    expect(status).toBe(404);
    expect(body['code']).not.toBe(CODIGO_INEXISTENTE);
    expect(ops).toEqual([]);
  });

  it('um erro que não é da Shopee (TypeError) é relançado (regra 6)', async () => {
    contexto({ detalhe: new TypeError('bug') });
    await expect(GET(new Request(url(QUERY), { headers: AUTORIZADO }))).rejects.toThrow(TypeError);
  });
});

describe('semFraseDaShopee — o mesmo erro, sem a frase da Shopee', () => {
  const PATH = SHOPEE_GET_RETURN_DETAIL_PATH;

  it('a mensagem do PACOTE carrega a frase — é por isso que o gêmeo existe', () => {
    const original = recusa('error_server', FRASE_DA_SHOPEE, PATH);
    expect(original.message).toContain(FRASE_DA_SHOPEE);
    expect(original.providerMessage).toBe(FRASE_DA_SHOPEE);
  });

  it.each<[string, () => ShopeeApiError, new (...a: never[]) => ShopeeApiError]>([
    [
      're-auth',
      () => recusa('shop_access_expired', FRASE_DA_SHOPEE, PATH),
      ShopeeReauthRequiredError,
    ],
    [
      'limite (burst)',
      () => recusa('error_rate_limit', FRASE_DA_SHOPEE, PATH, 7),
      ShopeeRateLimitError,
    ],
    ['cota diária', () => recusa('error_limit', FRASE_DA_SHOPEE, PATH), ShopeeRateLimitError],
    ['transitório', () => recusa('error_server', FRASE_DA_SHOPEE, PATH), ShopeeApiErrorClasse],
  ])(
    '%s: a MESMA classe e o mesmo kind/status/path; nada da Shopee além do código',
    (_t, criar, classe) => {
      const original = criar();
      const gemeo = semFraseDaShopee(original);
      expect(gemeo).toBeInstanceOf(classe);
      expect(gemeo.name).toBe(original.name);
      expect(gemeo.kind).toBe(original.kind);
      expect(gemeo.httpStatus).toBe(original.httpStatus);
      expect(gemeo.path).toBe(original.path);
      expect(gemeo.code).toBe(original.code);
      expect(gemeo.message).toBe(`Shopee ${PATH} respondeu ${original.code} (HTTP 200).`);
      expect(gemeo.providerMessage).toBeNull();
      expect(gemeo.warning).toBeNull();
      expect(gemeo.requestId).toBeNull();
      expect(JSON.stringify({ ...gemeo, message: gemeo.message })).not.toContain(FRASE_DA_SHOPEE);
    },
  );

  it('QUASE-IGUAL: um rate limit leva o retryAfterSeconds; a classe base NÃO vira subclasse', () => {
    const limite = semFraseDaShopee(recusa('error_rate_limit', FRASE_DA_SHOPEE, PATH, 7));
    expect(limite).toBeInstanceOf(ShopeeRateLimitError);
    expect((limite as ShopeeRateLimitError).retryAfterSeconds).toBe(7);
    expect(limite.kind).toBe(SHOPEE_ERROR_KIND.burst);

    const base = semFraseDaShopee(recusa('error_server', FRASE_DA_SHOPEE, PATH));
    expect(base).not.toBeInstanceOf(ShopeeRateLimitError);
    expect(base).not.toBeInstanceOf(ShopeeReauthRequiredError);
  });

  it('o código passa por codigoSeguro: PAR aparado; QUASE-IGUAL 7 dígitos ⇒ o marcador, nunca o valor', () => {
    expect(semFraseDaShopee(recusa(' error_server\t', FRASE_DA_SHOPEE, PATH)).code).toBe(
      'error_server',
    );
    const seteDigitos = semFraseDaShopee(recusa('error_1234567', null, PATH));
    expect(seteDigitos.code).toBe(MARCADOR_NAO_TOKEN);
    expect(seteDigitos.message).not.toContain('1234567');
    expect(semFraseDaShopee(recusa('error_123456', null, PATH)).code).toBe('error_123456');
  });

  it('um erro que NÃO é de envelope segue sem gêmeo: a mensagem já é nossa', async () => {
    contexto({
      detalhe: new ShopeeHttpError('Shopee respondeu HTTP 403 sem um corpo JSON.', {
        httpStatus: 403,
        path: PATH,
      }),
    });
    const res = await responder();
    expect(res.status).toBe(502);
    expect(res.body['error']).toBe('Shopee respondeu HTTP 403 sem um corpo JSON.');
  });
});
