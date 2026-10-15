/**
 * `POST /api/marketplace/shopee/reclamacao/acao` (#1525, step 17; reconcile §2.8,
 * R-13/R-14/R-15). The domain half — `devolucoes/acoesDevolucao.ts` and THE gate
 * in `estadoDevolucao.ts` — runs REAL here, over a typed stub client; its own
 * suites own the gate. What is pinned here is the ROUTE's alone: the PERM bit,
 * every body rung, the error mapping, the post-action refresh and its
 * containment, the zero-write promise, and round trip RT-7 (the action → the
 * synthetic code 29 → the importer reflects it).
 *
 * Mutants killed here: M107 (a failed post-action enqueue 5xx's a done action),
 * M108 (an extra body key accepted), M109 (read/write PERM bits swapped — this
 * route's half), M110 (`codigoShopee` segment-stripped), M111 (an unclassified
 * refusal answers 409), plus the route halves of M103, M104, M106 and M112.
 *
 * ⚠️ Fixture ids only — the alphanumeric return_sn of the reconcile. Nothing
 * here reaches a network or a real Firestore.
 */
import { AppErrorCode } from 'firebase-admin/app';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { PERM } from '@delfrance/auth';
import { MissingRegionError } from '@delfrance/core/region';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { integracaoCollection, pedidoCollection } from '@delfrance/data/admin/collections';
import {
  SHOPEE_GET_RETURN_DETAIL_PATH,
  SHOPEE_RETURN_CONFIRM_PATH,
  SHOPEE_SURFACE,
  ShopeeNetworkError,
  shopeeErrorFromEnvelope,
  shopeeReturnAvailableSolutionsSchema,
  shopeeReturnDetailSchema,
  shopeeReturnWriteSchema,
  type OfferReturnParams,
  type ShopeeAlvoDeDevolucao,
  type ShopeeApiError,
  type ShopeeClient,
  type ShopeeReturnAvailableSolutionsEnvelope,
  type ShopeeReturnDetailEnvelope,
  type ShopeeReturnWriteResponse,
} from '@delfrance/integrations-shopee';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import { ShopeeContaNotConfiguredError, type ShopeeContext } from '@/lib/shopee/core/shopee';
import { ShopeeContaSemShopIdError } from '@/lib/shopee/core/tokenStore';
import type { DevolucaoResolveDeps } from '@/lib/shopee/devolucoes/acoesDevolucao';
import { acoesDisponiveisDe, avaliarAcoesDevolucao } from '@/lib/shopee/devolucoes/estadoDevolucao';
import { idIncidenteDevolucaoShopee } from '@/lib/shopee/devolucoes/idsDevolucao';
import { importarDevolucaoShopee } from '@/lib/shopee/devolucoes/importarDevolucao';
import {
  FRASE_RECUSA_DEVOLUCAO,
  MOTIVO_RECUSA_DEVOLUCAO,
} from '@/lib/shopee/devolucoes/recusaDevolucao';
import {
  processNotificationPayload,
  shopeeNotificationTaskSchema,
  type ShopeeNotificationPayload,
} from '@/lib/shopee/notificacoes/notificacao';
import {
  carimboDoDiaUtcMs,
  notificacaoSinteticaDeDevolucao,
} from '@/lib/shopee/notificacoes/notificacaoSintetica';
import { makePedidoIdShopee } from '@/lib/shopee/pedidos/orderIds';
import { MSG_BODY_INVALIDO } from '@/lib/shopee/produtos/corpoImportacao';
import {
  ShopeeTasksDisabledError,
  ShopeeTasksTransientError,
  type ShopeeTaskScheduler,
} from '@/lib/shopee/shopeeTasks';
import { FakeDb, asDb, grpc, increment, type DocData } from '@/lib/shopee/testing/fakeDb';
import {
  CORPO_DA_RESPOSTA_DO_TASKS,
  falhaDeConfiguracaoDoFunctions,
  falhaDoApp,
  falhaDoFunctions,
  rejeicaoDoTransporte,
} from '@/lib/shopee/testing/falhaDeEnfileiramento';

type ModuloTasks = typeof import('@/lib/shopee/shopeeTasks');

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  criarAgendador: vi.fn(),
  real: { criarAgendador: null as (() => ShopeeTaskScheduler) | null },
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

// The scheduler defaults to a RECORDER; the valve case swaps in the REAL one.
vi.mock('@/lib/shopee/shopeeTasks', async (importActual) => {
  const actual = await importActual<ModuloTasks>();
  h.real.criarAgendador = actual.createShopeeTaskScheduler;
  return { ...actual, createShopeeTaskScheduler: h.criarAgendador };
});

const {
  POST,
  CODIGO_ACAO_RECUSADA,
  CODIGO_BODY_INVALIDO,
  CODIGO_FALHA_SHOPEE,
  CODIGO_INEXISTENTE,
  CODIGO_RECUSADA_PELA_SHOPEE,
  MSG_ACAO_INVALIDA,
  MSG_CAMPO_NAO_ACEITO,
  MSG_INTEGRACAO_ID_INVALIDO,
  MSG_PEDIDO_ID_INVALIDO,
  MSG_RETURN_SN_INVALIDO,
  MSG_SOLUCAO_EXIBIDA_INVALIDA,
  MSG_SOLUCAO_INVALIDA,
  MSG_VALOR_EXIBIDO_INVALIDO,
  MSG_VALOR_REEMBOLSO_INVALIDO,
} = await import('./route');

/* -------------------------------------------------------------------------- */
/*  Identidades de teste — nenhuma delas é real.                               */
/* -------------------------------------------------------------------------- */

const CONTA = 'int-1';
const SHOP = 987654;
const ORDER_SN = '260910KJBHUJDM';
/** ALPHANUMERIC on purpose — a digits-only id would hide the one shape a digits guard breaks. */
const RETURN_SN = '260910ABCDE0001';
const PEDIDO_ID = makePedidoIdShopee(CONTA, ORDER_SN);
const UPDATE_S = 1_789_042_568;
/** Deliberately NOT a day boundary, so the raw click and the day stamp differ. */
const NOW_MS = 1_789_000_123_456;
/** A Shopee sentence: it must reach neither a body nor a log line. */
const FRASE_DA_SHOPEE = 'Invalid return status for this seller operation';

/* -------------------------------------------------------------------------- */
/*  Wire envelopes — parsed by the PACKAGE's own schemas, never hand-typed.    */
/* -------------------------------------------------------------------------- */

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

function envEscrita(): ShopeeReturnWriteResponse {
  return shopeeReturnWriteSchema.parse({
    error: ' ',
    request_id: 'req-escrita',
    response: { return_sn: RETURN_SN },
  });
}

/** Shopee's refusal, built by the package's OWN envelope reader (so the kind is real). */
function recusa(
  error: string,
  message: string | null = FRASE_DA_SHOPEE,
  path = SHOPEE_RETURN_CONFIRM_PATH,
): ShopeeApiError {
  return shopeeErrorFromEnvelope(
    { error, message, request_id: null, warning: null },
    { path, httpStatus: 200, surface: SHOPEE_SURFACE.business },
  );
}

/* -------------------------------------------------------------------------- */
/*  The stub client — a FULL Pick of the five ops, typed, never partial.       */
/* -------------------------------------------------------------------------- */

type Resposta<T> = T | Error;

interface Roteiro {
  readonly detalhe?: Resposta<ShopeeReturnDetailEnvelope>;
  readonly solucoes?: Resposta<ShopeeReturnAvailableSolutionsEnvelope>;
  readonly escrita?: Resposta<ShopeeReturnWriteResponse>;
}

interface Chamada {
  readonly op: string;
  readonly args: unknown;
}

function responderCom<T>(r: Resposta<T>): T {
  if (r instanceof Error) throw r;
  return r;
}

let chamadas: Chamada[] = [];
const ops = (): string[] => chamadas.map((c) => c.op);

function clienteDe(roteiro: Roteiro): DevolucaoResolveDeps['client'] {
  const anotar = (op: string, args: unknown) => chamadas.push({ op, args });
  return {
    getReturnDetail: async (p: ShopeeAlvoDeDevolucao) => {
      anotar('getReturnDetail', p);
      return responderCom(roteiro.detalhe ?? envDetalhe());
    },
    getReturnAvailableSolutions: async (p: ShopeeAlvoDeDevolucao) => {
      anotar('getReturnAvailableSolutions', p);
      return responderCom(roteiro.solucoes ?? envSolucoes());
    },
    confirmReturn: async (p: ShopeeAlvoDeDevolucao) => {
      anotar('confirmReturn', p);
      return responderCom(roteiro.escrita ?? envEscrita());
    },
    offerReturn: async (p: OfferReturnParams) => {
      anotar('offerReturn', p);
      return responderCom(roteiro.escrita ?? envEscrita());
    },
    acceptReturnOffer: async (p: ShopeeAlvoDeDevolucao) => {
      anotar('acceptReturnOffer', p);
      return responderCom(roteiro.escrita ?? envEscrita());
    },
  };
}

/** The conta context the route builds its client from — the stub behind it. */
function contexto(roteiro: Roteiro = {}, shopId: number | null = SHOP): void {
  const client = clienteDe(roteiro);
  h.loadCtx.mockResolvedValue({
    integracaoId: CONTA,
    conta: { tipo: INTEGRACAO_TIPO.shopee, ativo: true, shop_id: shopId },
    createShopClient: () => client as unknown as ShopeeClient,
  } as unknown as ShopeeContext);
}

/* -------------------------------------------------------------------------- */
/*  The request                                                                */
/* -------------------------------------------------------------------------- */

function perms(...bits: bigint[]): string {
  return bits.reduce((a, b) => a | b, 0n).toString();
}

function autorizar(permissions: string): void {
  h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions });
}

const AUTORIZADO = { authorization: 'Bearer t' };

function req(corpo: unknown, headers: Record<string, string> = AUTORIZADO): Request {
  return new Request('http://localhost:3009/api/marketplace/shopee/reclamacao/acao', {
    method: 'POST',
    headers,
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

async function responder(corpo: unknown, headers?: Record<string, string>) {
  const res = await POST(req(corpo, headers));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const BASE = { integracaoId: CONTA, pedidoId: PEDIDO_ID, returnSn: RETURN_SN };

const CONFIRMAR = { ...BASE, acao: 'confirmar', valorExibidoMinor: 1050 };
const OFERTAR = { ...BASE, acao: 'ofertar', solucao: 'REFUND', valorReembolsoMinor: 800 };
const ACEITAR = {
  ...BASE,
  acao: 'aceitar-oferta',
  valorExibidoMinor: 725,
  solucaoExibida: 'REFUND',
};

/* -------------------------------------------------------------------------- */
/*  Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

let db: FakeDb;
let enfileirados: ShopeeNotificationPayload[];
let info: MockInstance;
let warn: MockInstance;
let erro: MockInstance;

/** Every console line this request wrote, serialised — what a log reader would see. */
function logs(): string {
  return JSON.stringify([...info.mock.calls, ...warn.mock.calls, ...erro.mock.calls]);
}

function agendadorQueFalha(err: unknown): void {
  h.criarAgendador.mockImplementation(() => ({
    enqueue: () => Promise.reject(err),
  }));
}

/**
 * The REAL scheduler's rejection when its TRANSPORT throws `err`: through
 * `rejeicaoDoTransporte`, the same classifier production runs (#1759), so a
 * transient failure reaches the route NAMED and a deploy-shaped one RAW.
 */
function transporteQueFalha(err: Error): void {
  h.criarAgendador.mockImplementation(() => ({
    enqueue: () => rejeicaoDoTransporte(err),
  }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  __resetAllReadCaches();
  chamadas = [];
  enfileirados = [];
  db = new FakeDb();
  h.db.atual = asDb(db);
  h.verifyIdToken.mockReset();
  h.loadCtx.mockReset();
  h.criarAgendador.mockReset();
  h.criarAgendador.mockImplementation(() => ({
    enqueue: (p: ShopeeNotificationPayload) => {
      enfileirados.push(p);
      return Promise.resolve();
    },
  }));
  autorizar(perms(PERM.incidenteResolucao.write));
  contexto();
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  erro = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*  Auth                                                                       */
/* -------------------------------------------------------------------------- */

describe('auth — PERM.incidenteResolucao.write', () => {
  it('sem Bearer ⇒ 401, e nenhuma conta é carregada', async () => {
    const { status } = await responder(CONFIRMAR, {});
    expect(status).toBe(401);
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('M109: só incidenteResolucao.READ ⇒ 403 — o bit de leitura não executa ação', async () => {
    autorizar(perms(PERM.incidenteResolucao.read));
    const { status } = await responder(CONFIRMAR);
    expect(status).toBe(403);
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(ops()).toEqual([]);
  });

  it('pedido.write e frete.write sem o bit dedicado ⇒ 403 (o dinheiro não anda com o pedido)', async () => {
    autorizar(perms(PERM.pedido.write, PERM.frete.write));
    expect((await responder(CONFIRMAR)).status).toBe(403);
  });

  it('M109 (par): só incidenteResolucao.WRITE ⇒ executa', async () => {
    autorizar(perms(PERM.incidenteResolucao.write));
    expect((await responder(CONFIRMAR)).status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/*  The body ladder                                                            */
/* -------------------------------------------------------------------------- */

const fora = (campo: string, acao: string) => `${campo} não é aceito com a ação "${acao}".`;

const RETURN_SN_64 = `A${'1'.repeat(63)}`;

describe('o corpo — 400 SHOPEE_RECLAMACAO_BODY_INVALIDO antes de carregar a conta', () => {
  it.each<[string, unknown, string]>([
    ['JSON inválido', '{"integracaoId":', MSG_BODY_INVALIDO],
    ['null', null, MSG_BODY_INVALIDO],
    ['um array', [CONFIRMAR], MSG_BODY_INVALIDO],
    ['um escalar', 42, MSG_BODY_INVALIDO],
    ['integracaoId ausente', { ...CONFIRMAR, integracaoId: undefined }, MSG_INTEGRACAO_ID_INVALIDO],
    ['integracaoId com "/"', { ...CONFIRMAR, integracaoId: 'int-1/x' }, MSG_INTEGRACAO_ID_INVALIDO],
    ['integracaoId ".."', { ...CONFIRMAR, integracaoId: '..' }, MSG_INTEGRACAO_ID_INVALIDO],
    ['integracaoId número', { ...CONFIRMAR, integracaoId: 1 }, MSG_INTEGRACAO_ID_INVALIDO],
    ['pedidoId ausente', { ...CONFIRMAR, pedidoId: undefined }, MSG_PEDIDO_ID_INVALIDO],
    ['pedidoId com "/"', { ...CONFIRMAR, pedidoId: `${PEDIDO_ID}/x` }, MSG_PEDIDO_ID_INVALIDO],
    // naoDocId(' ') is false; the module refuses a blank id with a RangeError (500).
    ['integracaoId só espaços', { ...CONFIRMAR, integracaoId: '  ' }, MSG_INTEGRACAO_ID_INVALIDO],
    ['pedidoId só espaços', { ...CONFIRMAR, pedidoId: ' ' }, MSG_PEDIDO_ID_INVALIDO],
    ['pedidoId vazio', { ...CONFIRMAR, pedidoId: '' }, MSG_PEDIDO_ID_INVALIDO],
    ['returnSn ausente', { ...CONFIRMAR, returnSn: undefined }, MSG_RETURN_SN_INVALIDO],
    ['returnSn NÚMERO', { ...CONFIRMAR, returnSn: 2609100000000001 }, MSG_RETURN_SN_INVALIDO],
    ['returnSn vazio', { ...CONFIRMAR, returnSn: '' }, MSG_RETURN_SN_INVALIDO],
    [
      'returnSn com espaço à esquerda (sem trim)',
      { ...CONFIRMAR, returnSn: ` ${RETURN_SN}` },
      MSG_RETURN_SN_INVALIDO,
    ],
    [
      'returnSn com espaço à direita (sem trim)',
      { ...CONFIRMAR, returnSn: `${RETURN_SN} ` },
      MSG_RETURN_SN_INVALIDO,
    ],
    ['returnSn com hífen', { ...CONFIRMAR, returnSn: '260910-ABCDE' }, MSG_RETURN_SN_INVALIDO],
    [
      'returnSn com 65 caracteres',
      { ...CONFIRMAR, returnSn: `${RETURN_SN_64}1` },
      MSG_RETURN_SN_INVALIDO,
    ],
    ['acao ausente', { ...CONFIRMAR, acao: undefined }, MSG_ACAO_INVALIDA],
    ['acao em maiúsculas', { ...CONFIRMAR, acao: 'CONFIRMAR' }, MSG_ACAO_INVALIDA],
    ['acao adiada (dispute)', { ...CONFIRMAR, acao: 'dispute' }, MSG_ACAO_INVALIDA],
    ['acao com sublinhado', { ...ACEITAR, acao: 'aceitar_oferta' }, MSG_ACAO_INVALIDA],
    // confirmar
    ['confirmar sem valorExibidoMinor', { ...BASE, acao: 'confirmar' }, MSG_VALOR_EXIBIDO_INVALIDO],
    ['confirmar eco negativo', { ...CONFIRMAR, valorExibidoMinor: -1 }, MSG_VALOR_EXIBIDO_INVALIDO],
    [
      'confirmar eco em reais',
      { ...CONFIRMAR, valorExibidoMinor: 10.5 },
      MSG_VALOR_EXIBIDO_INVALIDO,
    ],
    [
      'confirmar eco texto',
      { ...CONFIRMAR, valorExibidoMinor: '1050' },
      MSG_VALOR_EXIBIDO_INVALIDO,
    ],
    [
      'M112: confirmar + solucao',
      { ...CONFIRMAR, solucao: 'REFUND' },
      fora('solucao', 'confirmar'),
    ],
    [
      'confirmar + solucao null (a CHAVE é proibida)',
      { ...CONFIRMAR, solucao: null },
      fora('solucao', 'confirmar'),
    ],
    [
      'confirmar + valorReembolsoMinor',
      { ...CONFIRMAR, valorReembolsoMinor: 800 },
      fora('valorReembolsoMinor', 'confirmar'),
    ],
    [
      'confirmar + solucaoExibida null',
      { ...CONFIRMAR, solucaoExibida: null },
      fora('solucaoExibida', 'confirmar'),
    ],
    // ofertar
    ['ofertar sem solucao', { ...BASE, acao: 'ofertar' }, MSG_SOLUCAO_INVALIDA],
    ['ofertar solucao minúscula', { ...OFERTAR, solucao: 'refund' }, MSG_SOLUCAO_INVALIDA],
    [
      'ofertar solucao numérica (o código do push)',
      { ...OFERTAR, solucao: 1 },
      MSG_SOLUCAO_INVALIDA,
    ],
    ['ofertar solucao null', { ...OFERTAR, solucao: null }, MSG_SOLUCAO_INVALIDA],
    ['ofertar valor 0', { ...OFERTAR, valorReembolsoMinor: 0 }, MSG_VALOR_REEMBOLSO_INVALIDO],
    [
      'ofertar valor negativo',
      { ...OFERTAR, valorReembolsoMinor: -800 },
      MSG_VALOR_REEMBOLSO_INVALIDO,
    ],
    [
      'ofertar valor em reais',
      { ...OFERTAR, valorReembolsoMinor: 8.5 },
      MSG_VALOR_REEMBOLSO_INVALIDO,
    ],
    [
      'ofertar valor texto',
      { ...OFERTAR, valorReembolsoMinor: '800' },
      MSG_VALOR_REEMBOLSO_INVALIDO,
    ],
    [
      'ofertar valor null (ausente é SEM chave)',
      { ...OFERTAR, valorReembolsoMinor: null },
      MSG_VALOR_REEMBOLSO_INVALIDO,
    ],
    [
      'ofertar valor acima de 2^53',
      { ...OFERTAR, valorReembolsoMinor: 2 ** 53 },
      MSG_VALOR_REEMBOLSO_INVALIDO,
    ],
    [
      'ofertar valor que não sobrevive à volta em reais',
      { ...OFERTAR, valorReembolsoMinor: 3518445092000345 },
      MSG_VALOR_REEMBOLSO_INVALIDO,
    ],
    [
      'ofertar + valorExibidoMinor null',
      { ...OFERTAR, valorExibidoMinor: null },
      fora('valorExibidoMinor', 'ofertar'),
    ],
    [
      'ofertar + solucaoExibida',
      { ...OFERTAR, solucaoExibida: 'REFUND' },
      fora('solucaoExibida', 'ofertar'),
    ],
    // aceitar-oferta
    [
      'aceitar sem valorExibidoMinor',
      { ...BASE, acao: 'aceitar-oferta', solucaoExibida: 'REFUND' },
      MSG_VALOR_EXIBIDO_INVALIDO,
    ],
    [
      'aceitar sem solucaoExibida',
      { ...BASE, acao: 'aceitar-oferta', valorExibidoMinor: 725 },
      MSG_SOLUCAO_EXIBIDA_INVALIDA,
    ],
    [
      'aceitar solucaoExibida minúscula',
      { ...ACEITAR, solucaoExibida: 'refund' },
      MSG_SOLUCAO_EXIBIDA_INVALIDA,
    ],
    ['aceitar + solucao', { ...ACEITAR, solucao: 'REFUND' }, fora('solucao', 'aceitar-oferta')],
    [
      'aceitar + valorReembolsoMinor',
      { ...ACEITAR, valorReembolsoMinor: 725 },
      fora('valorReembolsoMinor', 'aceitar-oferta'),
    ],
    // M108 — strict
    ['M108: uma chave a mais', { ...CONFIRMAR, extra: 1 }, MSG_CAMPO_NAO_ACEITO],
    [
      'M108: a grafia em reais (valorReembolso)',
      { ...OFERTAR, valorReembolso: 8 },
      MSG_CAMPO_NAO_ACEITO,
    ],
    ['M108: um contador', { ...ACEITAR, tentativas: 2 }, MSG_CAMPO_NAO_ACEITO],
  ])('%s', async (_titulo, corpo, mensagem) => {
    const { status, body } = await responder(corpo);
    expect(status).toBe(400);
    expect(body).toEqual({ error: mensagem, code: CODIGO_BODY_INVALIDO });
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(ops()).toEqual([]);
    expect(enfileirados).toEqual([]);
  });

  it('M108: um "__proto__" do JSON é uma chave PRÓPRIA e também é recusado', async () => {
    const texto = JSON.stringify(CONFIRMAR).replace(/}$/, ',"__proto__":{"x":1}}');
    const { status, body } = await responder(texto);
    expect(status).toBe(400);
    expect(body['error']).toBe(MSG_CAMPO_NAO_ACEITO);
  });

  it('nenhuma frase de 400 ecoa um valor do corpo (o return_sn identifica a devolução)', async () => {
    for (const corpo of [
      { ...CONFIRMAR, returnSn: `${RETURN_SN}-x` },
      { ...CONFIRMAR, solucao: RETURN_SN },
      { ...OFERTAR, valorReembolsoMinor: RETURN_SN },
      { ...CONFIRMAR, [RETURN_SN]: 1 },
    ]) {
      const { status, body } = await responder(corpo);
      expect(status).toBe(400);
      expect(String(body['error'])).not.toContain(RETURN_SN);
    }
  });

  it('par/quase: 64 caracteres alfanuméricos passam, 65 não (o predicado compartilhado)', async () => {
    contexto({
      detalhe: recusa('error_data', "Return doesn't exist", SHOPEE_GET_RETURN_DETAIL_PATH),
    });
    const passou = await responder({ ...CONFIRMAR, returnSn: RETURN_SN_64 });
    expect(passou.status).toBe(404);
    expect(chamadas[0]?.args).toEqual({ returnSn: RETURN_SN_64 });
  });
});

/* -------------------------------------------------------------------------- */
/*  Every valid shape reaches the write                                        */
/* -------------------------------------------------------------------------- */

describe('toda forma VÁLIDA chega à escrita — a escada é ao menos tão estrita quanto o módulo', () => {
  it.each<[string, Record<string, unknown>, Roteiro, string, unknown]>([
    ['confirmar, eco 1050 = 10,50 vivo', CONFIRMAR, {}, 'confirmReturn', { returnSn: RETURN_SN }],
    [
      'confirmar, eco 0 = reembolso 0 vivo',
      { ...CONFIRMAR, valorExibidoMinor: 0 },
      { detalhe: envDetalhe({ refund_amount: 0 }) },
      'confirmReturn',
      { returnSn: RETURN_SN },
    ],
    [
      'ofertar REFUND com 800 centavos ⇒ 8 reais',
      OFERTAR,
      {},
      'offerReturn',
      { returnSn: RETURN_SN, proposedSolution: 'REFUND', proposedAdjustedRefundAmount: 8 },
    ],
    [
      'ofertar REFUND no piso (500 ⇒ 5)',
      { ...OFERTAR, valorReembolsoMinor: 500 },
      {},
      'offerReturn',
      { returnSn: RETURN_SN, proposedSolution: 'REFUND', proposedAdjustedRefundAmount: 5 },
    ],
    [
      'ofertar RETURN_REFUND SEM valor ⇒ nenhuma chave de valor',
      { ...BASE, acao: 'ofertar', solucao: 'RETURN_REFUND' },
      {},
      'offerReturn',
      { returnSn: RETURN_SN, proposedSolution: 'RETURN_REFUND' },
    ],
    ['aceitar, eco 725 + REFUND', ACEITAR, {}, 'acceptReturnOffer', { returnSn: RETURN_SN }],
    [
      'aceitar, eco null + solução null = proposta viva sem valor nem solução',
      { ...ACEITAR, valorExibidoMinor: null, solucaoExibida: null },
      {
        detalhe: envDetalhe({
          negotiation: {
            negotiation_status: 'PENDING_RESPOND',
            latest_solution: null,
            latest_offer_amount: null,
          },
        }),
      },
      'acceptReturnOffer',
      { returnSn: RETURN_SN },
    ],
  ])('%s', async (_titulo, corpo, roteiro, op, args) => {
    contexto(roteiro);
    const { status } = await responder(corpo);
    expect(status).toBe(200);
    const escritas = chamadas.filter((c) =>
      ['confirmReturn', 'offerReturn', 'acceptReturnOffer'].includes(c.op),
    );
    expect(escritas).toEqual([{ op, args }]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Success                                                                    */
/* -------------------------------------------------------------------------- */

describe('sucesso — a ação, UMA atualização enfileirada e nada no Firestore', () => {
  it('confirmar ⇒ 200 montado por nome, a leitura viva ANTES da escrita, e o code 29 sintético', async () => {
    const { status, body } = await responder(CONFIRMAR);

    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      acao: 'confirmar',
      returnSn: RETURN_SN,
      atualizacao: 'enfileirada',
    });
    expect(ops()).toEqual(['getReturnDetail', 'confirmReturn']);
    expect(enfileirados).toEqual([
      notificacaoSinteticaDeDevolucao({
        shopId: SHOP,
        orderSn: ORDER_SN,
        returnSn: RETURN_SN,
        nowMs: NOW_MS,
        origem: 'acao-vendedor',
      }),
    ]);
  });

  it('o carimbo do code 29 é o CLIQUE em ms cru — nunca o dia truncado do poller', async () => {
    await responder(CONFIRMAR);
    const [payload] = enfileirados;
    expect(payload?.code).toBe(29);
    expect(payload?.timestamp).toBe(NOW_MS);
    expect(payload?.timestamp).not.toBe(carimboDoDiaUtcMs(NOW_MS));
    expect(payload?.data).toEqual({
      order_sn: ORDER_SN,
      return_sn: RETURN_SN,
      origem: 'acao-vendedor',
    });
  });

  it('dois cliques no mesmo dia ⇒ dois ponteiros distintos (o relógio é lido por requisição)', async () => {
    await responder(CONFIRMAR);
    vi.setSystemTime(NOW_MS + 1);
    await responder(CONFIRMAR);
    expect(enfileirados.map((p) => p.timestamp)).toEqual([NOW_MS, NOW_MS + 1]);
  });

  it('M106 (rota): ZERO escritas e ZERO leituras no Firestore — o importador é o único escritor', async () => {
    await responder(CONFIRMAR);
    expect(db.writes).toEqual([]);
    expect(db.opLog).toEqual([]);
  });

  it('ofertar ⇒ detalhe, soluções, offer — e o valor cruza UMA vez, em reais', async () => {
    const { status, body } = await responder(OFERTAR);
    expect(status).toBe(200);
    expect(body['acao']).toBe('ofertar');
    expect(ops()).toEqual(['getReturnDetail', 'getReturnAvailableSolutions', 'offerReturn']);
    expect(chamadas[2]?.args).toEqual({
      returnSn: RETURN_SN,
      proposedSolution: 'REFUND',
      proposedAdjustedRefundAmount: 8,
    });
    expect(enfileirados).toHaveLength(1);
  });

  it('aceitar-oferta ⇒ detalhe, accept_offer', async () => {
    const { status, body } = await responder(ACEITAR);
    expect(status).toBe(200);
    expect(body['acao']).toBe('aceitar-oferta');
    expect(ops()).toEqual(['getReturnDetail', 'acceptReturnOffer']);
    expect(enfileirados).toHaveLength(1);
  });

  it('o log da ação leva ids, a ação e o erroEnvelope da ESCRITA (registro 231) — nenhum valor, nenhuma frase', async () => {
    await responder(OFERTAR);
    const linhas = info.mock.calls.filter((c) => String(c[0]).includes('ação executada'));
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.[1]).toEqual({
      integracaoId: CONTA,
      pedidoId: PEDIDO_ID,
      returnSn: RETURN_SN,
      acao: 'ofertar',
      erroEnvelope: ' ',
    });
    expect(logs()).not.toContain('800');
  });
});

/* -------------------------------------------------------------------------- */
/*  M107 — the post-action enqueue never 5xx's a done action                   */
/* -------------------------------------------------------------------------- */

describe('M107 — a atualização pós-ação nunca derruba uma ação FEITA', () => {
  // `transporte`: the failure goes through the REAL classifier (#1759), so it
  // reaches the route in its production shape. `agendador`: thrown by the
  // scheduler itself (the valve), or a shape the REST transport never produces
  // (a gRPC code), so it is rejected as is.
  it.each<[string, () => Error, 'agendador' | 'transporte', string, 'warn' | 'error']>([
    [
      'a válvula (ShopeeTasksDisabledError)',
      () => new ShopeeTasksDisabledError(),
      'agendador',
      'ShopeeTasksDisabledError',
      'warn',
    ],
    [
      'um erro gRPC (UNAVAILABLE)',
      () => grpc(14, 'unavailable ?token=abc'),
      'agendador',
      'Error',
      'error',
    ],
    [
      'a região ausente (SHOPEE_TASKS_REGION em branco até o passo 22)',
      () => new MissingRegionError('sem região ?token=abc', ['SHOPEE_TASKS_REGION']),
      'transporte',
      'MissingRegionError',
      'error',
    ],
    [
      'um 503/429 do Cloud Tasks (ShopeeTasksTransientError)',
      () => falhaDoFunctions('unknown-error'),
      'transporte',
      'ShopeeTasksTransientError functions/unknown-error HTTP 503',
      'error',
    ],
    [
      'o socket caiu (ShopeeTasksTransientError, app/network-error)',
      () => falhaDoApp(AppErrorCode.NETWORK_ERROR),
      'transporte',
      'ShopeeTasksTransientError app/network-error',
      'error',
    ],
    // ⚠️ DEPLOY-shaped: the real classifier hands these back RAW, and the route
    // still contains them — the decision in `ehFalhaDeEnfileiramento`'s
    // docblock (a 500 after a done refund invites the second click).
    [
      'falta o IAM do enfileirador (functions/permission-denied)',
      () => falhaDoFunctions('permission-denied', 403),
      'transporte',
      'FirebaseFunctionsError functions/permission-denied',
      'error',
    ],
    [
      'a fila ainda não implantada (functions/not-found)',
      () => falhaDoFunctions('not-found', 404),
      'transporte',
      'FirebaseFunctionsError functions/not-found',
      'error',
    ],
    [
      'o SDK sem projeto (functions/unknown-error SEM resposta)',
      () => falhaDeConfiguracaoDoFunctions('projeto'),
      'transporte',
      'FirebaseFunctionsError functions/unknown-error',
      'error',
    ],
    [
      'a credencial inválida (app/invalid-credential)',
      () => falhaDoApp(AppErrorCode.INVALID_CREDENTIAL),
      'transporte',
      'FirebaseAppError app/invalid-credential',
      'error',
    ],
  ])(
    '%s ⇒ 200 nao-enfileirada, a escrita aconteceu, UMA linha nomeia a CLASSE',
    async (_t, falha, via, rotulo, nivel) => {
      const lancado = falha();
      if (via === 'transporte') transporteQueFalha(lancado);
      else agendadorQueFalha(lancado);
      const { status, body } = await responder(CONFIRMAR);

      expect(status).toBe(200);
      expect(body).toEqual({
        ok: true,
        acao: 'confirmar',
        returnSn: RETURN_SN,
        atualizacao: 'nao-enfileirada',
      });
      expect(ops()).toEqual(['getReturnDetail', 'confirmReturn']);
      const [usado, calado] = nivel === 'warn' ? [warn, erro] : [erro, warn];
      expect(usado.mock.calls).toEqual([
        [
          `[shopee/devolucao] atualização pós-ação não enfileirada`,
          { integracaoId: CONTA, returnSn: RETURN_SN, acao: 'confirmar', falha: rotulo },
        ],
      ]);
      expect(calado).not.toHaveBeenCalled();
      expect(logs()).not.toContain('token=abc');
      expect(logs()).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
    },
  );

  it('ÂNCORA: pelo classificador REAL, um 503 chega NOMEADO e um 403 chega CRU — a tabela cobre as duas formas', async () => {
    await expect(rejeicaoDoTransporte(falhaDoFunctions('unknown-error'))).rejects.toBeInstanceOf(
      ShopeeTasksTransientError,
    );
    const cru = falhaDoFunctions('permission-denied', 403);
    await expect(rejeicaoDoTransporte(cru)).rejects.toBe(cru);
  });

  it('a válvula REAL (SHOPEE_TASKS_DISABLED=1) ⇒ nao-enfileirada, num warn — e não num error', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '1');
    h.criarAgendador.mockImplementation(() => h.real.criarAgendador!());
    const { status, body } = await responder(CONFIRMAR);
    expect(status).toBe(200);
    expect(body['atualizacao']).toBe('nao-enfileirada');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(erro).not.toHaveBeenCalled();
  });

  it('um BUG no enfileiramento (TypeError) é relançado (regra 6) — depois da escrita e do log da ação', async () => {
    agendadorQueFalha(new TypeError('bug'));
    await expect(POST(req(CONFIRMAR))).rejects.toThrow(TypeError);
    expect(ops()).toEqual(['getReturnDetail', 'confirmReturn']);
    expect(info.mock.calls.some((c) => String(c[0]).includes('ação executada'))).toBe(true);
  });

  it('⛔ QUASE-FALHA: um Error comum com o código de um transitório é relançado — a contenção é por CLASSE, não pela forma', async () => {
    const lancado = Object.assign(new Error('503'), { code: 'functions/unknown-error' });
    transporteQueFalha(lancado);
    await expect(POST(req(CONFIRMAR))).rejects.toBe(lancado);
    expect(ops()).toEqual(['getReturnDetail', 'confirmReturn']);
  });
});

/* -------------------------------------------------------------------------- */
/*  Our gate — 409 ACAO_RECUSADA                                               */
/* -------------------------------------------------------------------------- */

describe('o nosso portão — 409 SHOPEE_RECLAMACAO_ACAO_RECUSADA, sem escrita e sem enfileirar', () => {
  it('M104 (rota): pedidoId de OUTRO pedido ⇒ pedido-divergente', async () => {
    const outro = makePedidoIdShopee(CONTA, '260910KJBHUJDN');
    const { status, body } = await responder({ ...CONFIRMAR, pedidoId: outro });
    expect(status).toBe(409);
    expect(body).toEqual({
      error: FRASE_RECUSA_DEVOLUCAO[MOTIVO_RECUSA_DEVOLUCAO.pedidoDivergente],
      code: CODIGO_ACAO_RECUSADA,
      motivo: MOTIVO_RECUSA_DEVOLUCAO.pedidoDivergente,
      acoesDisponiveis: acoesDisponiveisDe(avaliarAcoesDevolucao(envDetalhe().response, null)),
    });
    expect(ops()).toEqual(['getReturnDetail']);
    expect(enfileirados).toEqual([]);
  });

  it('M103 (rota): o eco 1049 contra 10,50 vivo ⇒ valor-mudou; e a lista NÃO traz ofertar', async () => {
    const { status, body } = await responder({ ...CONFIRMAR, valorExibidoMinor: 1049 });
    expect(status).toBe(409);
    expect(body['motivo']).toBe(MOTIVO_RECUSA_DEVOLUCAO.valorMudou);
    expect(body['acoesDisponiveis']).toEqual(['confirmar', 'aceitar-oferta']);
    expect(body['acoesDisponiveis']).not.toContain('ofertar');
    expect(enfileirados).toEqual([]);
  });

  it('a proposta mudou entre a tela e o clique ⇒ proposta-mudou', async () => {
    const { status, body } = await responder({ ...ACEITAR, solucaoExibida: 'RETURN_REFUND' });
    expect(status).toBe(409);
    expect(body['motivo']).toBe(MOTIVO_RECUSA_DEVOLUCAO.propostaMudou);
    expect(ops()).toEqual(['getReturnDetail']);
  });

  it('devolução ENCERRADA ⇒ devolucao-encerrada, lista vazia', async () => {
    contexto({ detalhe: envDetalhe({ status: 'CLOSED' }) });
    const { status, body } = await responder(CONFIRMAR);
    expect(status).toBe(409);
    expect(body['motivo']).toBe(MOTIVO_RECUSA_DEVOLUCAO.devolucaoEncerrada);
    expect(body['acoesDisponiveis']).toEqual([]);
  });

  it('o log da recusa leva o motivo e os ids — nunca a frase', async () => {
    await responder({ ...CONFIRMAR, valorExibidoMinor: 1049 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({
      integracaoId: CONTA,
      pedidoId: PEDIDO_ID,
      returnSn: RETURN_SN,
      acao: 'confirmar',
      motivo: MOTIVO_RECUSA_DEVOLUCAO.valorMudou,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Shopee's refusals — our sentence, the verbatim code                        */
/* -------------------------------------------------------------------------- */

describe('as recusas da Shopee — 404/409/502 com a NOSSA frase e o código verbatim', () => {
  it('uma recusa conhecida na escrita ⇒ 409 RECUSADA_PELA_SHOPEE, motivo + código, sem enfileirar', async () => {
    contexto({ escrita: recusa('error_return_status') });
    const { status, body } = await responder(CONFIRMAR);
    expect(status).toBe(409);
    expect(body).toEqual({
      error: FRASE_RECUSA_DEVOLUCAO[MOTIVO_RECUSA_DEVOLUCAO.statusNaoPermite],
      code: CODIGO_RECUSADA_PELA_SHOPEE,
      motivo: MOTIVO_RECUSA_DEVOLUCAO.statusNaoPermite,
      codigoShopee: 'error_return_status',
    });
    expect(enfileirados).toEqual([]);
  });

  it('M110: um código com módulo é CLASSIFICADO pela dobra, mas devolvido VERBATIM', async () => {
    contexto({ escrita: recusa('returns.error_return_status') });
    const { status, body } = await responder(CONFIRMAR);
    expect(status).toBe(409);
    expect(body['motivo']).toBe(MOTIVO_RECUSA_DEVOLUCAO.statusNaoPermite);
    expect(body['codigoShopee']).toBe('returns.error_return_status');
  });

  it('M110 (par): espaços e TAB nas pontas saem; nada mais é dobrado', async () => {
    contexto({ escrita: recusa('  error_param\t') });
    const { status, body } = await responder(OFERTAR);
    expect(status).toBe(409);
    expect(body['motivo']).toBe(MOTIVO_RECUSA_DEVOLUCAO.parametroInvalido);
    expect(body['codigoShopee']).toBe('error_param');
  });

  it('M111: uma recusa DESCONHECIDA ⇒ 502 FALHA_SHOPEE (nunca um 409 com remédio)', async () => {
    contexto({ escrita: recusa('error_unknown_x') });
    const { status, body } = await responder(CONFIRMAR);
    expect(status).toBe(502);
    expect(body).toEqual({
      error: 'A Shopee recusou a ação (código error_unknown_x).',
      code: CODIGO_FALHA_SHOPEE,
      codigoShopee: 'error_unknown_x',
    });
  });

  it('M110 (quase): um código desconhecido com módulo vai VERBATIM no 502', async () => {
    contexto({ escrita: recusa('returns.error_novo') });
    const { status, body } = await responder(CONFIRMAR);
    expect(status).toBe(502);
    expect(body['codigoShopee']).toBe('returns.error_novo');
  });

  it('error_data com uma frase que a tabela não conhece ⇒ 502', async () => {
    contexto({ escrita: recusa('error_data', 'Something else happened') });
    expect((await responder(CONFIRMAR)).status).toBe(502);
  });

  it('a devolução não existe na leitura viva ⇒ 404 INEXISTENTE, nenhuma escrita', async () => {
    contexto({
      detalhe: recusa('error_data', "Return doesn't exist", SHOPEE_GET_RETURN_DETAIL_PATH),
    });
    const { status, body } = await responder(CONFIRMAR);
    expect(status).toBe(404);
    expect(body).toEqual({
      error: FRASE_RECUSA_DEVOLUCAO[MOTIVO_RECUSA_DEVOLUCAO.devolucaoInexistente],
      code: CODIGO_INEXISTENTE,
    });
    expect(ops()).toEqual(['getReturnDetail']);
    expect(enfileirados).toEqual([]);
  });

  it('um código com 7 dígitos não é ecoado (codigoSeguro); com 6, é', async () => {
    contexto({ escrita: recusa('error_1234567') });
    const sete = await responder(CONFIRMAR);
    expect(sete.status).toBe(502);
    expect(sete.body['codigoShopee']).toBeNull();
    expect(sete.body['error']).toBe('A Shopee recusou a ação (código não informado).');

    contexto({ escrita: recusa('error_123456') });
    const seis = await responder(CONFIRMAR);
    expect(seis.body['codigoShopee']).toBe('error_123456');
  });

  it('a frase da Shopee não chega ao corpo nem a log algum', async () => {
    for (const code of ['error_return_status', 'error_unknown_x']) {
      contexto({ escrita: recusa(code) });
      const { body } = await responder(CONFIRMAR);
      expect(JSON.stringify(body)).not.toContain(FRASE_DA_SHOPEE);
    }
    expect(logs()).not.toContain(FRASE_DA_SHOPEE);
  });

  it.each<[string, () => Error, number, string]>([
    [
      'autorização morta (reauth)',
      () => recusa('shop_access_expired'),
      409,
      'SHOPEE_REAUTH_REQUIRED',
    ],
    ['limite de taxa (burst)', () => recusa('error_rate_limit'), 502, 'SHOPEE_HTTP_ERROR'],
    ['cota diária (daily)', () => recusa('error_limit'), 502, 'SHOPEE_HTTP_ERROR'],
    [
      'transitório da Shopee (error_server)',
      () => recusa('error_server'),
      502,
      'SHOPEE_HTTP_ERROR',
    ],
    ['a rede', () => new ShopeeNetworkError('rede caiu'), 503, 'SHOPEE_NETWORK_ERROR'],
  ])('%s ⇒ shopeeErrorResponse, nunca o mapa de recusas', async (_t, falha, status, code) => {
    contexto({ escrita: falha() });
    const res = await responder(CONFIRMAR);
    expect(res.status).toBe(status);
    expect(res.body['code']).toBe(code);
    expect(enfileirados).toEqual([]);
    // R3-2: the package wrote Shopee's sentence into the error's `message`; the
    // mapper logs and returns `message` — so the route hands it the twin.
    expect(JSON.stringify(res.body)).not.toContain(FRASE_DA_SHOPEE);
    expect(logs()).not.toContain(FRASE_DA_SHOPEE);
    expect(logs()).toContain('[shopee/api]');
  });

  it('R3-2: o corpo do mapeador diz SÓ o caminho, o código e o HTTP — o gêmeo, nunca a frase', async () => {
    contexto({ escrita: recusa('shop_access_expired') });
    const reauth = await responder(CONFIRMAR);
    expect(reauth.status).toBe(409);
    expect(reauth.body).toEqual({
      error: `Shopee ${SHOPEE_RETURN_CONFIRM_PATH} respondeu shop_access_expired (HTTP 200).`,
      code: 'SHOPEE_REAUTH_REQUIRED',
      shopeeCode: 'shop_access_expired',
    });
  });

  it('a conta inexistente ⇒ 404 do mapeador (não o 404 de devolução), nenhuma chamada', async () => {
    h.loadCtx.mockRejectedValue(
      new ShopeeContaNotConfiguredError('Integração int-1 não encontrada.'),
    );
    const { status, body } = await responder(CONFIRMAR);
    expect(status).toBe(404);
    expect(body['code']).not.toBe(CODIGO_INEXISTENTE);
    expect(ops()).toEqual([]);
  });

  it('conta sem shop_id ⇒ 409 SHOPEE_CONTA_SEM_SHOP_ID antes de qualquer chamada', async () => {
    h.loadCtx.mockResolvedValue({
      conta: { shop_id: null },
      createShopClient: () => {
        throw new ShopeeContaSemShopIdError('sem shop_id');
      },
    } as unknown as ShopeeContext);
    const { status, body } = await responder(CONFIRMAR);
    expect(status).toBe(409);
    expect(body['code']).toBe('SHOPEE_CONTA_SEM_SHOP_ID');
    expect(ops()).toEqual([]);
  });

  it('invariante: um cliente construído para uma conta sem shop_id ⇒ throw ANTES da Shopee', async () => {
    contexto({}, null);
    await expect(POST(req(CONFIRMAR))).rejects.toThrow(/invariante/);
    expect(ops()).toEqual([]);
  });

  it('um erro que não é da Shopee (TypeError) é relançado (regra 6)', async () => {
    contexto({ detalhe: new TypeError('bug') });
    await expect(POST(req(CONFIRMAR))).rejects.toThrow(TypeError);
  });
});

/* -------------------------------------------------------------------------- */
/*  RT-7 — the action → the synthetic code 29 → the importer reflects it       */
/* -------------------------------------------------------------------------- */

describe('RT-7 — a ação → o code 29 sintético → o importador reflete; a rota não escreveu nada', () => {
  const INCIDENTE_PATH = `pedidos/${PEDIDO_ID}/incidentes/${idIncidenteDevolucaoShopee(RETURN_SN)}`;

  function semeado(): void {
    db.seed(integracaoCollection.docPath({}, CONTA), {
      tipo: INTEGRACAO_TIPO.shopee,
      ativo: true,
      nome: 'Loja Sandbox',
      shop_id: SHOP,
    } satisfies DocData);
    db.seed(pedidoCollection.docPath({}, PEDIDO_ID), { numero: ORDER_SN });
  }

  function importadorCom(detalhe: ShopeeReturnDetailEnvelope) {
    return (
      alvoDb: Parameters<typeof importarDevolucaoShopee>[0],
      alvo: Parameters<typeof importarDevolucaoShopee>[1],
    ) =>
      importarDevolucaoShopee(alvoDb, alvo, {
        clientFor: () =>
          Promise.resolve({
            getReturnDetail: () => Promise.resolve(detalhe),
          } as Pick<ShopeeClient, 'getReturnDetail'>),
        scheduler: { enqueue: () => Promise.resolve() },
        aviso: { increment, nowMs: NOW_MS },
      });
  }

  it('confirmar ⇒ o importador passa o incidente de REQUESTED para ACCEPTED (revisão 2)', async () => {
    semeado();
    // 1. The return as the push first imported it.
    const antes = await importadorCom(envDetalhe())(asDb(db), {
      integracaoId: CONTA,
      shopId: SHOP,
      orderSn: ORDER_SN,
      returnSn: RETURN_SN,
      nowMs: NOW_MS,
      origem: 'push',
      diario: null,
    });
    expect(antes.acao).toBe('criado');
    const escritasAntesDaRota = db.writes.length;

    // 2. The action — the route writes NOTHING.
    const { status, body } = await responder(CONFIRMAR);
    expect(status).toBe(200);
    expect(body['atualizacao']).toBe('enfileirada');
    expect(db.writes).toHaveLength(escritasAntesDaRota);

    // 3. The enqueued pointer, through the queue's JSON hop, into the real pipeline.
    expect(enfileirados).toHaveLength(1);
    const naFila = shopeeNotificationTaskSchema.parse(JSON.parse(JSON.stringify(enfileirados[0])));
    const depois = envDetalhe({ status: 'ACCEPTED', update_time: UPDATE_S + 60 });
    const saida = await processNotificationPayload(asDb(db), naFila, {
      partnerClient: () => {
        throw new Error('o code 29 não usa o cliente de parceiro');
      },
      increment,
      nowMs: () => NOW_MS + 5_000,
      importarDevolucao: importadorCom(depois),
    });

    expect(saida).toMatchObject({
      kind: 'devolucao',
      acaoDevolucao: 'atualizado',
      returnSn: RETURN_SN,
      pedidoId: PEDIDO_ID,
      statusDevolucao: 'ACCEPTED',
    });
    const incidente = db.store[INCIDENTE_PATH]?.data ?? {};
    const bloco = incidente['devolucaoShopee'] as Record<string, unknown>;
    expect(bloco['status']).toBe('ACCEPTED');
    expect(bloco['revisao']).toBe(2);
  });
});
