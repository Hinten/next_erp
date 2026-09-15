/**
 * The stuck-reservation sweep (step 8, #1516), driven end to end over the
 * SHARED `FakeDb` and the REAL `escreverAviso` / `resolverAviso`.
 *
 * ⚠️ This file may name the transaction API; the production module may not.
 * `firestore-transaction-inventory`'s PATHSPECS exclude `*.test.ts`, which is
 * what lets the raw-text guard below spell the word instead of assembling it
 * from fragments.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  deriveRequiredIndex,
  indexSatisfies,
  type RequiredIndex,
} from '@delfrance/config-eslint/rules/lib/required-index.js';
import { millisToMicros } from '@delfrance/core/datetime';
import {
  avisoCollection,
  integracaoCollection,
  pagamentoCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import { ESTADO_PEDIDO, INTEGRACAO_TIPO, STATUS_PAGAMENTO, TIPO_AVISO } from '@delfrance/schemas';
import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  type GetOrderDetailParams,
  type ShopeeClient,
  type ShopeeOrderDetail,
  type ShopeeOrderDetailRow,
} from '@delfrance/integrations-shopee';

import { chaveReservaTravada } from '../avisos/reservaTravada';
import { dedupKeyOf, type ShopeeNotificationPayload } from '../notificacoes/notificacao';
import { notificacaoSinteticaDePedido } from '../notificacoes/notificacaoSintetica';
import { ShopeeTasksDisabledError, type ShopeeTaskScheduler } from '../shopeeTasks';
import { type DocData, FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import { makePedidoIdShopee } from './orderIds';
import { DIA_US, VEREDITO_RESERVA_TRAVADA } from './reservaTravadaMapping';
import {
  CAMPOS_OPCIONAIS_RESERVA_TRAVADA,
  ESTADOS_RESERVA_TRAVADA_SHOPEE,
  LOTE_ORDER_DETAIL,
  MAX_CANDIDATOS,
  MAX_PAGINAS,
  MOTIVO_CONTA_ABORTADA,
  MOTIVO_FLAG_DESLIGADA,
  MOTIVO_SEM_SHOP_ID,
  PAGE_LIMIT,
  RECONCILIACAO_PAGINA,
  RESERVA_TRAVADA_DRY_RUN_ENV,
  RESERVA_TRAVADA_FLAG_ENV,
  RESERVA_TRAVADA_MAX_IDADE_ENV,
  runReservaTravadaSweep,
  type CandidatoObservado,
  type ReservaTravadaSweepResult,
} from './reservaTravadaSweep';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented values only. No real partner id, key, shop or buyer.   */
/* -------------------------------------------------------------------------- */

const AGORA_MS = 1_760_000_000_000;
const AGORA_US = millisToMicros(AGORA_MS);
const DIA_MS = 24 * 60 * 60 * 1000;

const INT_A = 'int-1';
const INT_B = 'int-2';
const SHOP_A = 987654;
const SHOP_B = 987655;
const SN_A = '260910KJBHUJDM';

const INTEGRACAO_PATH = integracaoCollection.resolvePath({});
const PEDIDO_PATH = pedidoCollection.resolvePath({});
const AVISO_PATH = avisoCollection.resolvePath({});

/** The buyer fields a `.passthrough()` row can carry — none is ever requested. */
const ENDERECO_FALSO = 'Rua Inventada 123, Bairro Inexistente';
const CPF_FALSO = '00000000191';
const BUYER_ID_FALSO = 4242424242;

function contaDoc(over: DocData = {}): DocData {
  return { tipo: INTEGRACAO_TIPO.shopee, ativo: true, nome: 'Loja BR', shop_id: SHOP_A, ...over };
}

interface SeedPedido {
  readonly integracaoId?: string;
  readonly orderSn?: string;
  readonly diasAtras?: number;
  readonly over?: DocData;
  /** Seed the document at an id the digest does NOT produce. */
  readonly idAlheio?: string;
}

/** Seed one step-5-shaped pedido and answer its document id. */
function semearPedido(db: FakeDb, p: SeedPedido = {}): string {
  const integracaoId = p.integracaoId ?? INT_A;
  const orderSn = p.orderSn ?? SN_A;
  const diasAtras = p.diasAtras ?? 30;
  const stampUs = AGORA_US - diasAtras * DIA_US;
  const id = p.idAlheio ?? makePedidoIdShopee(integracaoId, orderSn);
  db.seed(`${PEDIDO_PATH}/${id}`, {
    ehSaida: true,
    estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    numero: orderSn,
    timestamp: stampUs,
    integracaoPedidoOuterRef: `documents/integracao/${integracaoId}`,
    lastMarketplaceUpdate: stampUs,
    hasUserInteraction: null,
    marketplace: { tipo: 'shopee', status: 'UNPAID', statusEm: stampUs },
    ...p.over,
  });
  return id;
}

/** One `get_order_detail` row. Only the four fields the sweep reads matter. */
function linha(
  orderSn: string,
  orderStatus: string,
  over: Partial<ShopeeOrderDetailRow> = {},
): ShopeeOrderDetailRow {
  return {
    order_sn: orderSn,
    order_status: orderStatus,
    pay_time: null,
    pending_terms: null,
    cancel_by: null,
    cancel_reason: null,
    ...over,
  } as ShopeeOrderDetailRow;
}

/** A row carrying every buyer field a `.passthrough()` response could smuggle. */
function linhaComPii(orderSn: string, orderStatus: string): ShopeeOrderDetailRow {
  return linha(orderSn, orderStatus, {
    recipient_address: { full_address: ENDERECO_FALSO },
    buyer_cpf_id: CPF_FALSO,
    buyer_user_id: BUYER_ID_FALSO,
  } as Partial<ShopeeOrderDetailRow>);
}

function apiError(code: string): ShopeeApiError {
  return new ShopeeApiError(`shopee recusou: ${code}`, {
    code,
    kind: SHOPEE_ERROR_KIND.other,
    httpStatus: 200,
    path: '/api/v2/order/get_order_detail',
  });
}

function rateLimit(kind: 'burst' | 'daily'): ShopeeRateLimitError {
  return new ShopeeRateLimitError('shopee limitou', {
    code: kind === 'burst' ? 'error_rate_limit' : 'error_limit',
    kind,
    httpStatus: 200,
    path: '/api/v2/order/get_order_detail',
  });
}

function reauth(): ShopeeReauthRequiredError {
  return new ShopeeReauthRequiredError('autorização morta', {
    code: 'error_auth',
    kind: SHOPEE_ERROR_KIND.reauth,
    httpStatus: 200,
    path: '/api/v2/order/get_order_detail',
  });
}

type DetailMock = Mock<(p: GetOrderDetailParams) => Promise<ShopeeOrderDetail>>;
type EnqueueMock = Mock<(p: ShopeeNotificationPayload) => Promise<void>>;

interface Cenario {
  db: FakeDb;
  getOrderDetail: DetailMock;
  clientPor: Map<string, ShopeeClient>;
  enqueue: EnqueueMock;
  avisos: string[];
}

function cenario(): Cenario {
  const db = new FakeDb();
  db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
  return {
    db,
    getOrderDetail: vi.fn(),
    clientPor: new Map<string, ShopeeClient>(),
    enqueue: vi.fn(() => Promise.resolve()),
    avisos: [],
  };
}

/**
 * A client that answers from a table of rows, honouring the batch semantics the
 * sandbox probe measured: an unknown `order_sn` is simply OMITTED, unless every
 * `order_sn` of the call is unknown.
 */
function clienteTabela(
  rows: ReadonlyMap<string, ShopeeOrderDetailRow>,
  opts: { embaralhar?: boolean; erroEmLote?: Error } = {},
): DetailMock {
  return vi.fn((p: GetOrderDetailParams) => {
    if (opts.erroEmLote !== undefined && p.orderSnList.length > 1) {
      return Promise.reject(opts.erroEmLote);
    }
    const encontrados = p.orderSnList
      .map((sn) => rows.get(sn))
      .filter((r): r is ShopeeOrderDetailRow => r !== undefined);
    if (encontrados.length === 0) return Promise.reject(apiError('error_not_found'));
    const order_list = opts.embaralhar === true ? [...encontrados].reverse() : encontrados;
    return Promise.resolve({ order_list } as ShopeeOrderDetail);
  });
}

interface RodarOver {
  readonly nowMs?: number;
  readonly apenasIntegracoes?: readonly string[];
  readonly forcarDryRun?: boolean;
  readonly ignorarFlagMestra?: boolean;
  readonly semLogger?: boolean;
  /** The wave-4 observation seam. Absent ⇒ the tick behaves exactly as before. */
  readonly onCandidato?: (c: CandidatoObservado) => void;
}

function rodar(c: Cenario, over: RodarOver = {}): Promise<ReservaTravadaSweepResult> {
  const scheduler: ShopeeTaskScheduler = { enqueue: c.enqueue };
  return runReservaTravadaSweep(asDb(c.db), {
    scheduler,
    nowMs: over.nowMs ?? AGORA_MS,
    increment,
    ...(over.semLogger === true ? {} : { logger: { warn: () => {} } }),
    clientFor: (_db, integracaoId) =>
      Promise.resolve(
        c.clientPor.get(integracaoId) ??
          ({ getOrderDetail: c.getOrderDetail } as unknown as ShopeeClient),
      ),
    ...(over.apenasIntegracoes === undefined ? {} : { apenasIntegracoes: over.apenasIntegracoes }),
    ...(over.forcarDryRun === undefined ? {} : { forcarDryRun: over.forcarDryRun }),
    ...(over.ignorarFlagMestra === undefined ? {} : { ignorarFlagMestra: over.ignorarFlagMestra }),
    ...(over.onCandidato === undefined ? {} : { onCandidato: over.onCandidato }),
  });
}

/** The params of `getOrderDetail` call `n`, or a loud failure. */
function chamada(c: Cenario, n: number): GetOrderDetailParams {
  const p = c.getOrderDetail.mock.calls[n]?.[0];
  if (p === undefined) throw new Error(`getOrderDetail não foi chamado ${String(n + 1)} vez(es)`);
  return p;
}

/** The payload of enqueue call `n`, or a loud failure. */
function enfileirado(c: Cenario, n: number): ShopeeNotificationPayload {
  const p = c.enqueue.mock.calls[n]?.[0];
  if (p === undefined) throw new Error(`enqueue não foi chamado ${String(n + 1)} vez(es)`);
  return p;
}

/** Σ over the verdict map — the invariant every fixture must satisfy. */
function somaVeredictos(r: ReservaTravadaSweepResult): number {
  return Object.values(r.veredictos).reduce((a, b) => a + b, 0);
}

function esperarInvariante(r: ReservaTravadaSweepResult): void {
  expect(somaVeredictos(r)).toBe(r.candidatos);
}

beforeEach(() => {
  process.env[RESERVA_TRAVADA_FLAG_ENV] = '1';
  delete process.env[RESERVA_TRAVADA_DRY_RUN_ENV];
  delete process.env[RESERVA_TRAVADA_MAX_IDADE_ENV];
  delete process.env.SHOPEE_TASKS_DISABLED;
});

afterEach(() => {
  delete process.env[RESERVA_TRAVADA_FLAG_ENV];
  delete process.env[RESERVA_TRAVADA_DRY_RUN_ENV];
  delete process.env[RESERVA_TRAVADA_MAX_IDADE_ENV];
  delete process.env.SHOPEE_TASKS_DISABLED;
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*  1 — the flags                                                             */
/* -------------------------------------------------------------------------- */

describe('runReservaTravadaSweep — as flags', () => {
  it('flag desligada ⇒ ZERO leituras: opLog vazio, nenhuma chamada Shopee, nenhum enfileiramento', async () => {
    const c = cenario();
    semearPedido(c.db);
    delete process.env[RESERVA_TRAVADA_FLAG_ENV];

    const r = await rodar(c);

    expect(r.enabled).toBe(false);
    expect(r.motivo).toBe(MOTIVO_FLAG_DESLIGADA);
    expect(c.db.opLog).toEqual([]);
    expect(c.db.consultasCompletas).toEqual([]);
    expect(c.getOrderDetail).not.toHaveBeenCalled();
    expect(c.enqueue).not.toHaveBeenCalled();
    esperarInvariante(r);
  });

  it.each(['0', 'true', 'yes', ''])('o valor %o mantém a varredura desligada', async (valor) => {
    const c = cenario();
    semearPedido(c.db);
    process.env[RESERVA_TRAVADA_FLAG_ENV] = valor;

    const r = await rodar(c);

    expect(r.enabled).toBe(false);
    expect(c.db.opLog).toEqual([]);
  });

  it('⚠️ com a flag mestra desligada o resultado reporta o dryRun HONESTO', async () => {
    const c = cenario();
    delete process.env[RESERVA_TRAVADA_FLAG_ENV];
    process.env[RESERVA_TRAVADA_DRY_RUN_ENV] = '1';

    const r = await rodar(c);

    // A operadora que ligou o ensaio e esqueceu a flag mestra lê a verdade.
    expect(r).toMatchObject({ enabled: false, dryRun: true, motivo: MOTIVO_FLAG_DESLIGADA });
    // E todos os braços do mapa continuam presentes, zerados.
    expect(Object.keys(r.veredictos)).toHaveLength(11);
    expect(somaVeredictos(r)).toBe(0);
  });

  it('ignorarFlagMestra SEM dry run LANÇA ShopeeConfigError', async () => {
    const c = cenario();
    delete process.env[RESERVA_TRAVADA_FLAG_ENV];

    await expect(rodar(c, { ignorarFlagMestra: true })).rejects.toBeInstanceOf(ShopeeConfigError);
    expect(c.db.opLog).toEqual([]);
  });

  it('ignorarFlagMestra COM dry run roda com a flag mestra desligada e não grava nada', async () => {
    const c = cenario();
    semearPedido(c.db);
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'UNPAID')]]));
    delete process.env[RESERVA_TRAVADA_FLAG_ENV];

    const r = await rodar(c, { ignorarFlagMestra: true, forcarDryRun: true });

    expect(r.enabled).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.candidatos).toBe(1);
    expect(r.veredictos['ainda-nao-pago']).toBe(1);
    expect(c.db.writes).toEqual([]);
    esperarInvariante(r);
  });
});

/* -------------------------------------------------------------------------- */
/*  2 — the candidate query and the paging                                    */
/* -------------------------------------------------------------------------- */

describe('runReservaTravadaSweep — a consulta de candidatos', () => {
  it('monta ehSaida + estado(in) + timestamp(<) e ordena timestamp desc', async () => {
    const c = cenario();
    semearPedido(c.db);
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'UNPAID')]]));

    const r = await rodar(c);

    const consulta = c.db.consultasCompletas.find((q) => q.fonte === PEDIDO_PATH);
    expect(consulta).toBeDefined();
    expect(consulta!.clausulas).toEqual([
      ['ehSaida', '==', true],
      ['estado', 'in', [ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento]],
      ['timestamp', '<', r.cutoffUs],
    ]);
    expect(consulta!.ordens).toEqual([['timestamp', 'desc']]);
    expect(consulta!.limite).toBe(PAGE_LIMIT);
    expect(consulta!.apos).toBeNull();
  });

  it('examina só o estado de reserva que a escada do passo 5 escreve', () => {
    // Um `in` de UM elemento, não um `==`: o composto declarado é
    // (ehSaida, estado, timestamp DESC) e o formato errado não lança na
    // Enterprise — ele varre tudo e cobra a varredura.
    expect(ESTADOS_RESERVA_TRAVADA_SHOPEE).toEqual([
      ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    ]);
    for (const outro of [
      ESTADO_PEDIDO.escolhendoFormaDePagamento,
      ESTADO_PEDIDO.emAnalise,
      ESTADO_PEDIDO.emProcessamento,
      ESTADO_PEDIDO.pago,
    ]) {
      expect(ESTADOS_RESERVA_TRAVADA_SHOPEE).not.toContain(outro);
    }
  });

  it('pagina com startAfter até MAX_PAGINAS e marca truncado', async () => {
    const c = cenario();
    // 2 400 linhas que não são nossas: baratas (reprovam na porteira 1a) e
    // exatamente a população que coloniza a janela sem cursor.
    for (let i = 0; i < 2400; i += 1) {
      c.db.seed(`${PEDIDO_PATH}/alheio-${String(i).padStart(4, '0')}`, {
        ehSaida: true,
        estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
        timestamp: AGORA_US - (30 * DIA_US + i),
      });
    }

    const r = await rodar(c);

    expect(r.paginas).toBe(MAX_PAGINAS);
    expect(r.examinados).toBe(MAX_PAGINAS * PAGE_LIMIT);
    expect(r.truncado).toBe(true);
    expect(r.naoMarketplace).toBe(MAX_PAGINAS * PAGE_LIMIT);
    expect(r.candidatos).toBe(0);
    esperarInvariante(r);

    // O cursor é o ÚLTIMO documento da página anterior — um snapshot, não um
    // valor: dois pedidos criados no mesmo segundo compartilham um timestamp.
    const paginas = c.db.consultasCompletas.filter((q) => q.fonte === PEDIDO_PATH);
    expect(paginas).toHaveLength(MAX_PAGINAS);
    expect(paginas[0]!.apos).toBeNull();
    for (let i = 1; i < paginas.length; i += 1) {
      expect(paginas[i]!.apos).toBe(`alheio-${String(i * PAGE_LIMIT - 1).padStart(4, '0')}`);
    }
  });

  it('uma página drenada (menos de PAGE_LIMIT) NÃO marca truncado', async () => {
    const c = cenario();
    semearPedido(c.db);
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'UNPAID')]]));

    const r = await rodar(c);

    expect(r.paginas).toBe(1);
    expect(r.examinados).toBe(1);
    expect(r.truncado).toBe(false);
  });

  it('para em MAX_CANDIDATOS com a página cheia e marca truncado', async () => {
    const c = cenario();
    const sns: string[] = [];
    for (let i = 0; i < 260; i += 1) {
      const sn = `2609SN${String(i).padStart(4, '0')}`;
      sns.push(sn);
      semearPedido(c.db, { orderSn: sn, diasAtras: 30 + i / 1000 });
    }
    c.getOrderDetail = clienteTabela(new Map(sns.map((sn) => [sn, linha(sn, 'UNPAID')])));

    const r = await rodar(c, { forcarDryRun: true });

    expect(r.paginas).toBe(1);
    expect(r.candidatos).toBe(MAX_CANDIDATOS);
    expect(r.truncado).toBe(true);
    // 200 candidatos ⇒ 4 lotes de 50.
    expect(c.getOrderDetail).toHaveBeenCalledTimes(Math.ceil(MAX_CANDIDATOS / LOTE_ORDER_DETAIL));
    esperarInvariante(r);
  });

  it('⚠️ um pedido legado com timestamp em MILISSEGUNDOS é candidato, e a idade sai honesta', async () => {
    const c = cenario();
    // O corpus migrado guarda ms. ~1.7e12 satisfaz qualquer corte em µs por
    // construção, e ordena por ÚLTIMO no DESC — que é por que a paginação existe.
    const msLegado = AGORA_MS - 400 * DIA_MS;
    semearPedido(c.db, { over: { timestamp: msLegado, lastMarketplaceUpdate: msLegado } });
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'UNPAID')]]));

    const r = await rodar(c);

    expect(r.candidatos).toBe(1);
    expect(r.veredictos['ainda-nao-pago']).toBe(1);
    // A idade chega ao aviso pelo `coerceToMicros`, não por uma leitura estrita
    // que responderia 1970 (≈ 20 000 dias).
    const aviso = c.db.store[`${AVISO_PATH}/${chaveReservaTravada(INT_A, semearId())}`];
    expect(aviso).toBeDefined();
    const situacao = (aviso!.data.params as Record<string, unknown>).situacao as string;
    expect(situacao).toContain('400 dia');
    // 1970 lido como µs daria ~20 000 dias; é essa a leitura estrita evitada.
    expect(situacao).not.toContain('20');
    esperarInvariante(r);
  });

  it('um pedido recente nunca é candidato', async () => {
    const c = cenario();
    semearPedido(c.db, { diasAtras: 1 });

    const r = await rodar(c);

    expect(r.examinados).toBe(0);
    expect(r.candidatos).toBe(0);
    expect(c.getOrderDetail).not.toHaveBeenCalled();
  });

  it('SHOPEE_PEDIDO_TRAVADO_MAX_IDADE_D move o corte', async () => {
    const c = cenario();
    semearPedido(c.db, { diasAtras: 10 });
    process.env[RESERVA_TRAVADA_MAX_IDADE_ENV] = '30';

    const r = await rodar(c);

    expect(r.maxIdadeDias).toBe(30);
    expect(r.candidatos).toBe(0);
  });
});

/** The document id of the default fixture — handy where the seed is implicit. */
function semearId(): string {
  return makePedidoIdShopee(INT_A, SN_A);
}

/* -------------------------------------------------------------------------- */
/*  3 — the gates                                                             */
/* -------------------------------------------------------------------------- */

describe('runReservaTravadaSweep — as porteiras', () => {
  it('NUNCA toca num pedido que o importador Shopee não criou', async () => {
    const c = cenario();
    // A prova é o digest `sha256("<contaId>-<orderSn>")`, recomputado do próprio
    // documento. Um id alheio reprova, mesmo com o outerRef certo.
    semearPedido(c.db, { idAlheio: 'pedido-de-outra-origem', over: { marketplace: null } });

    const r = await rodar(c);

    expect(r.naoMarketplace).toBe(1);
    expect(r.adotado).toBe(0);
    expect(r.candidatos).toBe(0);
    expect(c.getOrderDetail).not.toHaveBeenCalled();
    esperarInvariante(r);
  });

  it('um pedido com marketplace.tipo shopee e id alheio conta ADOTADO, não naoMarketplace', async () => {
    const c = cenario();
    semearPedido(c.db, { idAlheio: 'pedido-adotado' });

    const r = await rodar(c);

    // Não é backlog: é artefato de migração ou bug de pré-imagem, e a linha do
    // log o separa por isso.
    expect(r.adotado).toBe(1);
    expect(r.naoMarketplace).toBe(0);
    expect(r.candidatos).toBe(0);
  });

  it('sem lastMarketplaceUpdate ⇒ naoMarketplace; em MILISSEGUNDOS ⇒ candidato', async () => {
    const semWatermark = cenario();
    semearPedido(semWatermark.db, { over: { lastMarketplaceUpdate: null } });
    const r1 = await rodar(semWatermark);
    expect(r1.naoMarketplace).toBe(1);
    expect(r1.candidatos).toBe(0);
    expect(semWatermark.getOrderDetail).not.toHaveBeenCalled();

    const comMs = cenario();
    semearPedido(comMs.db, { over: { lastMarketplaceUpdate: AGORA_MS - 30 * DIA_MS } });
    comMs.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'UNPAID')]]));
    const r2 = await rodar(comMs);
    expect(r2.naoMarketplace).toBe(0);
    expect(r2.candidatos).toBe(1);
  });

  it('um timestamp ilegível conta naoMarketplace em vez de inventar uma idade', async () => {
    const c = cenario();
    // 5e13 cai na LACUNA indeterminável de `coerceToMicros` (9e12, 1e14) — alto
    // demais para ms, baixo demais para µs — e ainda assim satisfaz o filtro de
    // desigualdade do servidor, que é a única forma de a linha chegar até aqui.
    c.db.seed(`${PEDIDO_PATH}/${semearId()}`, {
      ehSaida: true,
      estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
      numero: SN_A,
      timestamp: 5e13,
      integracaoPedidoOuterRef: `documents/integracao/${INT_A}`,
      lastMarketplaceUpdate: AGORA_US - 30 * DIA_US,
      marketplace: { tipo: 'shopee', status: 'UNPAID', statusEm: null },
    });

    const r = await rodar(c);

    expect(r.naoMarketplace).toBe(1);
    expect(r.candidatos).toBe(0);
  });

  it('conta fora de listarContasShopeeAtivas ⇒ contaInativa, e a Shopee não é chamada', async () => {
    const c = cenario();
    c.db.store[`${INTEGRACAO_PATH}/${INT_A}`]!.data.ativo = false;
    semearPedido(c.db);

    const r = await rodar(c);

    expect(r.contaInativa).toBe(1);
    expect(r.candidatos).toBe(0);
    expect(c.getOrderDetail).not.toHaveBeenCalled();
    esperarInvariante(r);
  });

  it('apenasIntegracoes conta as linhas das OUTRAS contas em foraDoEscopo', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_B}`, contaDoc({ shop_id: SHOP_B }));
    semearPedido(c.db, { integracaoId: INT_A });
    semearPedido(c.db, { integracaoId: INT_B, orderSn: '260910OUTRO' });
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'UNPAID')]]));

    const r = await rodar(c, { apenasIntegracoes: [INT_A] });

    expect(r.foraDoEscopo).toBe(1);
    expect(r.naoMarketplace).toBe(0);
    expect(r.candidatos).toBe(1);
    expect(r.contas.map((x) => x.integracaoId)).toEqual([INT_A]);
    esperarInvariante(r);
  });

  it('uma conta sem shop_id é pulada ANTES de qualquer leitura, e seus candidatos são nao-verificaveis', async () => {
    const c = cenario();
    c.db.store[`${INTEGRACAO_PATH}/${INT_A}`]!.data.shop_id = null;
    semearPedido(c.db);

    const r = await rodar(c);

    expect(r.semShopId).toBe(1);
    expect(r.candidatos).toBe(1);
    expect(r.veredictos['nao-verificavel']).toBe(1);
    expect(r.contas[0]!.pulada).toBe(MOTIVO_SEM_SHOP_ID);
    expect(c.getOrderDetail).not.toHaveBeenCalled();
    // Uma ausência não é um resíduo: nenhum aviso é escrito.
    expect(c.db.writes).toEqual([]);
    esperarInvariante(r);
  });

  it('deixa em paz um pedido que um humano SALVOU', async () => {
    const c = cenario();
    semearPedido(c.db, { over: { hasUserInteraction: true } });

    const r = await rodar(c);

    expect(r.veredictos['interacao-humana']).toBe(1);
    expect(c.getOrderDetail).not.toHaveBeenCalled();
    expect(c.enqueue).not.toHaveBeenCalled();
    esperarInvariante(r);
  });

  it('recusa enquanto QUALQUER pagamento estiver aprovado — inclusive o segundo documento', async () => {
    const c = cenario();
    const pedidoId = semearPedido(c.db);
    const pagPath = pagamentoCollection.resolvePath({ pedidoId });
    // Um pagamento BR combinado se abre em N documentos; uma leitura por id
    // perderia o secundário, que é justamente onde o `aprovado` está.
    c.db.seed(`${pagPath}/pag-1`, { status_pagamento: STATUS_PAGAMENTO.pendente, valor: 10 });
    c.db.seed(`${pagPath}/pag-1-1`, { status_pagamento: STATUS_PAGAMENTO.aprovado, valor: 5 });

    const r = await rodar(c);

    expect(r.veredictos['pagamento-aprovado']).toBe(1);
    expect(c.getOrderDetail).not.toHaveBeenCalled();
    esperarInvariante(r);
  });
});

/* -------------------------------------------------------------------------- */
/*  4 — the read                                                              */
/* -------------------------------------------------------------------------- */

describe('runReservaTravadaSweep — a leitura', () => {
  it('um lote vira UMA chamada, com requestOrderStatusPending e a allow-list mínima', async () => {
    const c = cenario();
    const sns: string[] = [];
    for (let i = 0; i < LOTE_ORDER_DETAIL; i += 1) {
      const sn = `2609LOTE${String(i).padStart(3, '0')}`;
      sns.push(sn);
      semearPedido(c.db, { orderSn: sn, diasAtras: 30 + i / 1000 });
    }
    c.getOrderDetail = clienteTabela(new Map(sns.map((sn) => [sn, linha(sn, 'UNPAID')])));

    const r = await rodar(c, { forcarDryRun: true });

    expect(c.getOrderDetail).toHaveBeenCalledTimes(1);
    expect(chamada(c, 0).orderSnList).toHaveLength(LOTE_ORDER_DETAIL);
    expect(chamada(c, 0).requestOrderStatusPending).toBe(true);
    expect(r.contas[0]!.lotes).toBe(1);
    expect(r.contas[0]!.chamadas).toBe(1);
  });

  it('responseOptionalFields é exatamente pay_time, cancel_by, cancel_reason', async () => {
    const c = cenario();
    semearPedido(c.db);
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'UNPAID')]]));

    await rodar(c, { forcarDryRun: true });

    // ⚠️ A lista SUBSTITUI a do pacote; um campo não nomeado volta AUSENTE, e um
    // `pay_time` ausente leria como "não pago". Esta literal é a defesa.
    expect(chamada(c, 0).responseOptionalFields).toEqual([
      'pay_time',
      'cancel_by',
      'cancel_reason',
    ]);
    expect(CAMPOS_OPCIONAIS_RESERVA_TRAVADA).toEqual(['pay_time', 'cancel_by', 'cancel_reason']);
    // Nenhum token de comprador, e nem os dois campos BASE (nomeá-los arrisca
    // `error_param`), nem o `pending_terms` (que a FLAG entrega).
    for (const proibido of [
      'buyer_cpf_id',
      'buyer_username',
      'buyer_user_id',
      'recipient_address',
      'item_list',
      'invoice_data',
      'payment_info',
      'buyer_cancel_reason',
      'order_status',
      'update_time',
      'pending_terms',
    ]) {
      expect(chamada(c, 0).responseOptionalFields).not.toContain(proibido);
    }
  });

  it('reconcilia por order_sn, nunca por posição', async () => {
    const c = cenario();
    semearPedido(c.db, { orderSn: SN_A, diasAtras: 30 });
    semearPedido(c.db, { orderSn: '260910SEGUNDO', diasAtras: 31 });
    c.getOrderDetail = clienteTabela(
      new Map([
        [SN_A, linha(SN_A, 'CANCELLED')],
        ['260910SEGUNDO', linha('260910SEGUNDO', 'UNPAID')],
      ]),
      { embaralhar: true },
    );

    const r = await rodar(c);

    expect(r.veredictos['redirecionado-cancelado']).toBe(1);
    expect(r.veredictos['ainda-nao-pago']).toBe(1);
    expect(enfileirado(c, 0).data?.ordersn).toBe(SN_A);
    esperarInvariante(r);
  });

  it('uma linha AUSENTE da resposta ⇒ inexistente só para aquele pedido', async () => {
    const c = cenario();
    semearPedido(c.db, { orderSn: SN_A, diasAtras: 30 });
    semearPedido(c.db, { orderSn: '260910SUMIU', diasAtras: 31 });
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'UNPAID')]]));

    const r = await rodar(c);

    expect(r.veredictos.inexistente).toBe(1);
    expect(r.veredictos['ainda-nao-pago']).toBe(1);
    expect(c.getOrderDetail).toHaveBeenCalledTimes(1);
    // Nenhum código bruto: a linha simplesmente não voltou.
    expect(r.contas[0]!.codigosInexistente).toEqual({});
    esperarInvariante(r);
  });

  it('error_not_found num lote de N>1 CAI PARA chamadas por pedido', async () => {
    const c = cenario();
    const bons = ['260910BOM1', '260910BOM2'];
    semearPedido(c.db, { orderSn: bons[0]!, diasAtras: 30 });
    semearPedido(c.db, { orderSn: bons[1]!, diasAtras: 31 });
    semearPedido(c.db, { orderSn: '260910RUIM', diasAtras: 32 });
    c.getOrderDetail = clienteTabela(new Map(bons.map((sn) => [sn, linha(sn, 'UNPAID')])), {
      erroEmLote: apiError('error_not_found'),
    });

    const r = await rodar(c);

    // 1 chamada em lote (recusada) + 3 por pedido.
    expect(r.contas[0]!.chamadas).toBe(4);
    expect(r.contas[0]!.lotesComFallback).toBe(1);
    expect(r.veredictos['ainda-nao-pago']).toBe(2);
    expect(r.veredictos.inexistente).toBe(1);
    expect(r.contas[0]!.codigosInexistente).toEqual({ error_not_found: 1 });
    esperarInvariante(r);
  });

  it('inexistente mapeia error_not_found e order_not_found para o mesmo motivo e guarda o código bruto', async () => {
    for (const codigo of ['error_not_found', 'order_not_found']) {
      const c = cenario();
      const pedidoId = semearPedido(c.db);
      c.getOrderDetail = vi.fn(() => Promise.reject(apiError(codigo)));

      const r = await rodar(c);

      expect(r.veredictos.inexistente).toBe(1);
      // UM motivo semântico no aviso ("a Shopee nega o pedido")…
      const aviso = c.db.store[`${AVISO_PATH}/${chaveReservaTravada(INT_A, pedidoId)}`];
      expect(aviso).toBeDefined();
      expect(aviso!.data.motivo).toBe('order_not_found');
      // …e as DUAS grafias preservadas onde o item 38 é lido.
      expect(r.contas[0]!.codigosInexistente).toEqual({ [codigo]: 1 });
      expect(c.enqueue).not.toHaveBeenCalled();
      esperarInvariante(r);
    }
  });

  it.each([
    ['burst', rateLimit('burst')],
    ['daily', rateLimit('daily')],
  ])('um 429 %s ⇒ nao-verificavel para o lote e NENHUMA segunda chamada', async (_k, erro) => {
    const c = cenario();
    semearPedido(c.db, { orderSn: SN_A, diasAtras: 30 });
    semearPedido(c.db, { orderSn: '260910OUTRO2', diasAtras: 31 });
    c.getOrderDetail = vi.fn(() => Promise.reject(erro));

    const r = await rodar(c);

    // Nunca uma retentativa: a escalada da Shopee é restringir o app inteiro, e
    // o `error_limit` só zera às 00:00 UTC+8.
    expect(c.getOrderDetail).toHaveBeenCalledTimes(1);
    expect(r.veredictos['nao-verificavel']).toBe(2);
    expect(r.contas[0]!.pulada).toBe(MOTIVO_CONTA_ABORTADA);
    expect(r.erros).toEqual([]);
    esperarInvariante(r);
  });

  it('um 429 ABORTA a conta: os lotes restantes contam nao-verificavel sem mais nenhuma chamada', async () => {
    const c = cenario();
    const sns: string[] = [];
    for (let i = 0; i < LOTE_ORDER_DETAIL + 10; i += 1) {
      const sn = `2609AB${String(i).padStart(4, '0')}`;
      sns.push(sn);
      semearPedido(c.db, { orderSn: sn, diasAtras: 30 + i / 1000 });
    }
    c.getOrderDetail = vi.fn(() => Promise.reject(rateLimit('daily')));

    const r = await rodar(c);

    expect(c.getOrderDetail).toHaveBeenCalledTimes(1);
    expect(r.contas[0]!.lotes).toBe(1);
    expect(r.veredictos['nao-verificavel']).toBe(sns.length);
    expect(r.contas[0]!.pulada).toBe(MOTIVO_CONTA_ABORTADA);
    // ⚠️ Um candidato abortado NÃO aparece também em erros[] — isso tornaria
    // `erros.length` ilegível.
    expect(r.erros).toEqual([]);
    esperarInvariante(r);
  });

  it.each([
    ['reauth', reauth()],
    ['http', new ShopeeHttpError('502', { httpStatus: 502, path: '/x' })],
    ['rede', new ShopeeNetworkError('ECONNRESET')],
    ['schema', new ShopeeSchemaError('campo faltando', { httpStatus: 200, path: '/x' })],
  ])('%s ⇒ nao-verificavel, nunca um enfileiramento', async (_k, erro) => {
    const c = cenario();
    semearPedido(c.db);
    c.getOrderDetail = vi.fn(() => Promise.reject(erro));

    const r = await rodar(c);

    expect(r.veredictos['nao-verificavel']).toBe(1);
    expect(c.enqueue).not.toHaveBeenCalled();
    expect(c.db.writes).toEqual([]);
    esperarInvariante(r);
  });

  it('ShopeeConfigError RELANÇA — é nossa, e erroContidoPorConta não a contém', async () => {
    const c = cenario();
    semearPedido(c.db);
    c.getOrderDetail = vi.fn(() => Promise.reject(new ShopeeConfigError('partner_id ausente')));

    await expect(rodar(c)).rejects.toBeInstanceOf(ShopeeConfigError);
  });

  it('uma conta que falha não custa o tick às outras', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_B}`, contaDoc({ shop_id: SHOP_B }));
    semearPedido(c.db, { integracaoId: INT_A, orderSn: SN_A, diasAtras: 30 });
    semearPedido(c.db, { integracaoId: INT_B, orderSn: '260910BOA', diasAtras: 31 });
    c.clientPor.set(INT_A, {
      getOrderDetail: () => Promise.reject(grpc(14, 'UNAVAILABLE')),
    } as unknown as ShopeeClient);
    c.clientPor.set(INT_B, {
      getOrderDetail: () =>
        Promise.resolve({
          order_list: [linha('260910BOA', 'CANCELLED')],
        } as ShopeeOrderDetail),
    } as unknown as ShopeeClient);

    const r = await rodar(c);

    expect(r.veredictos['nao-verificavel']).toBe(1);
    expect(r.veredictos['redirecionado-cancelado']).toBe(1);
    const a = r.contas.find((x) => x.integracaoId === INT_A)!;
    const b = r.contas.find((x) => x.integracaoId === INT_B)!;
    expect(a.error).not.toBeNull();
    expect(b.error).toBeNull();
    expect(c.enqueue).toHaveBeenCalledTimes(1);
    esperarInvariante(r);
  });
});

/* -------------------------------------------------------------------------- */
/*  5 — the effects                                                           */
/* -------------------------------------------------------------------------- */

describe('runReservaTravadaSweep — os dois efeitos', () => {
  it('pago ⇒ redirecionado-avancou e UM enfileiramento com origem reserva-travada', async () => {
    const c = cenario();
    semearPedido(c.db);
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'READY_TO_SHIP')]]));

    const r = await rodar(c);

    expect(r.veredictos['redirecionado-avancou']).toBe(1);
    expect(c.enqueue).toHaveBeenCalledTimes(1);
    // Byte a byte o que o construtor compartilhado produz — inclusive o
    // `orderStatus`, que é a única coisa que o leitor do Cloud Logging tem para
    // comparar o que a VARREDURA viu com o que a IMPORTAÇÃO encontrou.
    expect(enfileirado(c, 0)).toEqual(
      notificacaoSinteticaDePedido({
        shopId: SHOP_A,
        orderSn: SN_A,
        nowMs: AGORA_MS,
        origem: 'reserva-travada',
        orderStatus: 'READY_TO_SHIP',
      }),
    );
    // Sem atraso: o candidato tem dias, não há push fresco com que correr.
    expect(enfileirado(c, 0)).not.toHaveProperty('scheduleDelaySeconds');
    // Um `avancou` NÃO solta a reserva (`pago` está dentro do conjunto): nenhum
    // aviso, e a conta o conta à parte.
    expect(r.contas[0]!.avisosEscritos).toBe(0);
    esperarInvariante(r);
  });

  it('CANCELLED e IN_CANCEL ⇒ redirecionado-cancelado, contados à parte de avancou', async () => {
    const c = cenario();
    semearPedido(c.db, { orderSn: '260910CANC', diasAtras: 30 });
    semearPedido(c.db, { orderSn: '260910EMCA', diasAtras: 31 });
    semearPedido(c.db, { orderSn: '260910AVAN', diasAtras: 32 });
    c.getOrderDetail = clienteTabela(
      new Map([
        ['260910CANC', linha('260910CANC', 'CANCELLED')],
        ['260910EMCA', linha('260910EMCA', 'IN_CANCEL')],
        ['260910AVAN', linha('260910AVAN', 'COMPLETED')],
      ]),
    );

    const r = await rodar(c);

    // "examinados 200, redirecionados 40" diria que 40 unidades voltaram ao
    // estoque quando 39 delas são vendas vivas cujo registro foi corrigido.
    expect(r.veredictos['redirecionado-cancelado']).toBe(2);
    expect(r.veredictos['redirecionado-avancou']).toBe(1);
    expect(c.enqueue).toHaveBeenCalledTimes(3);
    esperarInvariante(r);
  });

  it('dois candidatos com o mesmo order_sn no tick ⇒ UM enfileiramento', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_B}`, contaDoc({ shop_id: SHOP_A }));
    semearPedido(c.db, { integracaoId: INT_A, orderSn: SN_A, diasAtras: 30 });
    semearPedido(c.db, { integracaoId: INT_B, orderSn: SN_A, diasAtras: 31 });
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'CANCELLED')]]));

    const r = await rodar(c);

    expect(r.veredictos['redirecionado-cancelado']).toBe(2);
    // Mesmo `dedupKeyOf` (3:<shop>:<ordersn>) ⇒ um trabalho só.
    expect(c.enqueue).toHaveBeenCalledTimes(1);
    expect(dedupKeyOf(enfileirado(c, 0))).toBe(`3:${String(SHOP_A)}:${SN_A}`);
    esperarInvariante(r);
  });

  it('inexistente NÃO enfileira — cada tick escreveria uma carta morta estacionada', async () => {
    const c = cenario();
    semearPedido(c.db);
    c.getOrderDetail = vi.fn(() => Promise.reject(apiError('order_not_found')));

    const r = await rodar(c);

    expect(r.veredictos.inexistente).toBe(1);
    expect(c.enqueue).not.toHaveBeenCalled();
    esperarInvariante(r);
  });

  it('SHOPEE_TASKS_DISABLED ⇒ veredito tasks-desabilitado, decidido por LEITURA', async () => {
    const c = cenario();
    semearPedido(c.db);
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'CANCELLED')]]));
    process.env.SHOPEE_TASKS_DISABLED = '1';

    const r = await rodar(c);

    expect(r.tasksDesabilitado).toBe(true);
    expect(r.veredictos['tasks-desabilitado']).toBe(1);
    expect(r.veredictos['redirecionado-cancelado']).toBe(0);
    expect(c.enqueue).not.toHaveBeenCalled();
    // Uma LEITURA, não uma exceção contida: nada em erros[], nada na conta.
    expect(r.erros).toEqual([]);
    expect(r.contas[0]!.error).toBeNull();
    esperarInvariante(r);
  });

  it('um ShopeeTasksDisabledError vindo do enqueue mesmo assim dá o mesmo veredito', async () => {
    const c = cenario();
    semearPedido(c.db);
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'CANCELLED')]]));
    c.enqueue = vi.fn(() => Promise.reject(new ShopeeTasksDisabledError()));

    const r = await rodar(c);

    expect(r.veredictos['tasks-desabilitado']).toBe(1);
    expect(r.erros).toEqual([]);
    esperarInvariante(r);
  });

  it('um enfileiramento que falha por outro motivo vai para erros[], nunca para a contenção por conta', async () => {
    const c = cenario();
    const pedidoId = semearPedido(c.db);
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'CANCELLED')]]));
    c.enqueue = vi.fn(() => Promise.reject(grpc(14, 'UNAVAILABLE')));

    const r = await rodar(c);

    expect(r.erros).toEqual([{ pedidoId, message: 'UNAVAILABLE' }]);
    // O veredito continua sendo o que a classificação disse; a conta NÃO é
    // contida, e o candidato simplesmente volta a ser candidato semana que vem.
    expect(r.veredictos['redirecionado-cancelado']).toBe(1);
    expect(r.contas[0]!.error).toBeNull();
    expect(r.contas[0]!.enfileirados).toBe(0);
    esperarInvariante(r);
  });
});

/* -------------------------------------------------------------------------- */
/*  6 — the dry-run parity table                                              */
/* -------------------------------------------------------------------------- */

interface CasoParidade {
  readonly nome: string;
  readonly veredito: string;
  readonly montar: (c: Cenario) => void;
  readonly tasksOff?: boolean;
}

const CASOS_PARIDADE: readonly CasoParidade[] = [
  {
    nome: 'interacao-humana',
    veredito: 'interacao-humana',
    montar: (c) => {
      semearPedido(c.db, { over: { hasUserInteraction: true } });
    },
  },
  {
    nome: 'pagamento-aprovado',
    veredito: 'pagamento-aprovado',
    montar: (c) => {
      const pedidoId = semearPedido(c.db);
      c.db.seed(`${pagamentoCollection.resolvePath({ pedidoId })}/pag-1`, {
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        valor: 10,
      });
    },
  },
  {
    nome: 'nao-verificavel',
    veredito: 'nao-verificavel',
    montar: (c) => {
      semearPedido(c.db);
      c.getOrderDetail = vi.fn(() => Promise.reject(new ShopeeNetworkError('ECONNRESET')));
    },
  },
  {
    nome: 'inexistente',
    veredito: 'inexistente',
    montar: (c) => {
      semearPedido(c.db);
      c.getOrderDetail = vi.fn(() => Promise.reject(apiError('order_not_found')));
    },
  },
  {
    nome: 'ainda-nao-pago',
    veredito: 'ainda-nao-pago',
    montar: (c) => {
      semearPedido(c.db);
      c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'UNPAID')]]));
    },
  },
  {
    nome: 'pendente-pago',
    veredito: 'pendente-pago',
    montar: (c) => {
      semearPedido(c.db);
      c.getOrderDetail = clienteTabela(
        new Map([
          [
            SN_A,
            linha(SN_A, 'PENDING', {
              pay_time: 1_760_000_000,
              pending_terms: ['ARRANGE_SHIPMENT_PENDING'],
            }),
          ],
        ]),
      );
    },
  },
  {
    nome: 'redirecionado-avancou',
    veredito: 'redirecionado-avancou',
    montar: (c) => {
      semearPedido(c.db);
      c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'SHIPPED')]]));
    },
  },
  {
    nome: 'redirecionado-cancelado',
    veredito: 'redirecionado-cancelado',
    montar: (c) => {
      semearPedido(c.db);
      c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'CANCELLED')]]));
    },
  },
  {
    nome: 'manter-devolucao',
    veredito: 'manter-devolucao',
    montar: (c) => {
      semearPedido(c.db);
      c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'TO_RETURN')]]));
    },
  },
  {
    nome: 'status-desconhecido',
    veredito: 'status-desconhecido',
    montar: (c) => {
      semearPedido(c.db);
      c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'ALGO_QUE_NINGUEM_MODELOU')]]));
    },
  },
  {
    nome: 'tasks-desabilitado',
    veredito: 'tasks-desabilitado',
    tasksOff: true,
    montar: (c) => {
      semearPedido(c.db);
      c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'CANCELLED')]]));
    },
  },
];

describe('⚠️ a tabela de paridade do dry-run', () => {
  it.each(CASOS_PARIDADE.map((k) => [k.nome, k] as const))(
    '%s: mesmo veredito nos dois modos, e o dry run não escreve nem enfileira',
    async (_nome, caso) => {
      const vivo = cenario();
      caso.montar(vivo);
      if (caso.tasksOff === true) process.env.SHOPEE_TASKS_DISABLED = '1';
      const rVivo = await rodar(vivo);

      const seco = cenario();
      caso.montar(seco);
      const rSeco = await rodar(seco, { forcarDryRun: true });

      // Todo veredito é decidido do MESMO lado da fronteira nos dois modos.
      expect(rSeco.veredictos).toEqual(rVivo.veredictos);
      expect(rSeco.veredictos[caso.veredito as keyof typeof rSeco.veredictos]).toBe(1);
      expect(rSeco.candidatos).toBe(1);
      // A fronteira são EXATAMENTE dois efeitos.
      expect(seco.db.writes).toEqual([]);
      expect(seco.enqueue).not.toHaveBeenCalled();
      // E o dry run ainda LÊ: o Firestore e a Shopee.
      expect(seco.db.consultasCompletas.length).toBeGreaterThan(0);
      esperarInvariante(rVivo);
      esperarInvariante(rSeco);
    },
  );
});

/* -------------------------------------------------------------------------- */
/*  7 — the avisos, driven from the tick                                      */
/* -------------------------------------------------------------------------- */

describe('runReservaTravadaSweep — os avisos', () => {
  it('o aviso é escrito UMA vez e a segunda varredura incrementa ocorrencias sem mover criadoEm', async () => {
    const c = cenario();
    const pedidoId = semearPedido(c.db);
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'UNPAID')]]));
    const chave = chaveReservaTravada(INT_A, pedidoId);

    await rodar(c);
    const criadoEm = c.db.store[`${AVISO_PATH}/${chave}`]!.data.criadoEm;
    expect(c.db.store[`${AVISO_PATH}/${chave}`]!.data.ocorrencias).toBe(1);

    await rodar(c, { nowMs: AGORA_MS + 7 * DIA_MS });

    const depois = c.db.store[`${AVISO_PATH}/${chave}`]!.data;
    expect(depois.ocorrencias).toBe(2);
    // ⚠️ `criadoEm` parado é o que impede o aviso de re-alertar toda segunda —
    // e `ocorrencias` é a ÚNICA memória entre ticks que este desenho tem.
    expect(depois.criadoEm).toBe(criadoEm);
    expect(depois.resolvidoEm).toBeNull();
  });

  it('o resolve EM LINHA acontece só nos dois vereditos de porteira', async () => {
    const c = cenario();
    const pedidoId = semearPedido(c.db);
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'UNPAID')]]));
    const chave = chaveReservaTravada(INT_A, pedidoId);

    // Semana 1: sem pagamento e sem humano ⇒ aviso aberto.
    await rodar(c);
    expect(c.db.store[`${AVISO_PATH}/${chave}`]!.data.resolvidoEm).toBeNull();

    // Semana 2: um humano salvou o pedido.
    c.db.store[`${PEDIDO_PATH}/${pedidoId}`]!.data.hasUserInteraction = true;
    const r = await rodar(c, { nowMs: AGORA_MS + 7 * DIA_MS });

    expect(r.veredictos['interacao-humana']).toBe(1);
    expect(r.contas[0]!.avisosResolvidos).toBe(1);
    const doc = c.db.store[`${AVISO_PATH}/${chave}`]!.data;
    expect(doc.resolvidoEm).not.toBeNull();
    expect(doc.resolucaoMotivo).toBe('assumido-por-humano');
  });

  it('um redirecionado NÃO resolve em linha — resolver num enfileiramento fecharia um aviso vivo', async () => {
    const c = cenario();
    const pedidoId = semearPedido(c.db);
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'UNPAID')]]));
    const chave = chaveReservaTravada(INT_A, pedidoId);
    await rodar(c);

    // Semana 2: a Shopee agora diz CANCELLED ⇒ re-condução, e nada mais.
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'CANCELLED')]]));
    const r = await rodar(c, { nowMs: AGORA_MS + 7 * DIA_MS });

    expect(r.veredictos['redirecionado-cancelado']).toBe(1);
    expect(r.reconciliados).toBe(0);
    // O aviso continua aberto: o enfileiramento pode estacionar ou adiar, e não
    // existe canal de retorno. Quem o fecha é a passagem (b), na semana em que o
    // pedido REALMENTE sai do conjunto.
    expect(c.db.store[`${AVISO_PATH}/${chave}`]!.data.resolvidoEm).toBeNull();
  });

  it('a passagem (b) fecha um aviso cujo pedido saiu do conjunto, com o motivo certo', async () => {
    const c = cenario();
    const pedidoId = semearPedido(c.db);
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'UNPAID')]]));
    const chave = chaveReservaTravada(INT_A, pedidoId);
    await rodar(c);

    // O passo 5 aplicou a re-condução: o pedido saiu do estado de reserva e
    // deixou de ser candidato — o que é a OBSERVAÇÃO de que ela pegou.
    c.db.store[`${PEDIDO_PATH}/${pedidoId}`]!.data.estado = ESTADO_PEDIDO.cancelado;
    const r = await rodar(c, { nowMs: AGORA_MS + 7 * DIA_MS });

    expect(r.candidatos).toBe(0);
    expect(r.avisosVarridos).toBe(1);
    expect(r.reconciliados).toBe(1);
    expect(r.reconciliacaoTruncada).toBe(false);
    const doc = c.db.store[`${AVISO_PATH}/${chave}`]!.data;
    expect(doc.resolvidoEm).not.toBeNull();
    expect(doc.resolucaoMotivo).toBe('estado-saiu-do-conjunto');
  });

  it('a passagem (b) fecha um aviso cujo pedido sumiu, e deixa em paz o que ainda está travado', async () => {
    const c = cenario();
    const pedidoId = semearPedido(c.db);
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'UNPAID')]]));
    await rodar(c);

    delete c.db.store[`${PEDIDO_PATH}/${pedidoId}`];
    const r = await rodar(c, { nowMs: AGORA_MS + 7 * DIA_MS });
    expect(r.reconciliados).toBe(1);
    expect(
      c.db.store[`${AVISO_PATH}/${chaveReservaTravada(INT_A, pedidoId)}`]!.data.resolucaoMotivo,
    ).toBe('pedido-inexistente');
  });

  it('a passagem (b) ignora linhas que não são nossas e as chaves tocadas neste tick', async () => {
    const c = cenario();
    const pedidoId = semearPedido(c.db);
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'UNPAID')]]));
    // Um aviso aberto de OUTRO tipo, que a página carrega porque índice nenhum
    // discrimina tipo ou canal.
    c.db.seed(`${AVISO_PATH}/shopeeAutorizacaoExpirando:${INT_A}:${String(SHOP_A)}`, {
      tipo: TIPO_AVISO.shopeeAutorizacaoExpirando,
      canal: 'shopee',
      resolvidoEm: null,
      criadoEm: AGORA_US,
    });

    const r = await rodar(c);

    // 2 linhas na página (a nossa, recém-criada, e a alheia) e nada fechado: a
    // nossa está no conjunto de chaves tocadas, a outra não é nossa.
    expect(r.avisosVarridos).toBe(2);
    expect(r.reconciliados).toBe(0);
    expect(
      c.db.store[`${AVISO_PATH}/${chaveReservaTravada(INT_A, pedidoId)}`]!.data.resolvidoEm,
    ).toBeNull();
    expect(
      c.db.store[`${AVISO_PATH}/shopeeAutorizacaoExpirando:${INT_A}:${String(SHOP_A)}`]!.data
        .resolvidoEm,
    ).toBeNull();
  });

  it('a passagem (b) não RE-LÊ o pedido de uma chave que este tick acabou de tocar', async () => {
    const c = cenario();
    const pedidoId = semearPedido(c.db);
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'UNPAID')]]));

    const r = await rodar(c);

    expect(r.avisosVarridos).toBe(1);
    // A prova de que o pulo aconteceu é a AUSÊNCIA da leitura por id: sem ele, a
    // passagem (b) lê de novo cada pedido cujo aviso este tick acabou de
    // levantar — um round trip por candidato, toda semana — e, na janela em que
    // o documento mudou entre as duas leituras, chegaria a fechar um aviso no
    // mesmo tick em que o levantou.
    const leiturasPorId = c.db.opLog.filter(
      (o) => o.op === 'get' && o.path === `${PEDIDO_PATH}/${pedidoId}`,
    );
    expect(leiturasPorId).toEqual([]);
  });

  it('reconciliacaoTruncada dispara quando a página vem CHEIA', async () => {
    const c = cenario();
    // A página carrega todo aviso aberto de todo tipo e canal, porque índice
    // nenhum discrimina os dois — então uma caixa movimentada faz as NOSSAS
    // linhas passarem fome, e é esse contador que mede isso.
    for (let i = 0; i < RECONCILIACAO_PAGINA; i += 1) {
      c.db.seed(`${AVISO_PATH}/outroTipo:conta:${String(i).padStart(4, '0')}`, {
        tipo: TIPO_AVISO.shopeeAutorizacaoExpirando,
        canal: 'shopee',
        resolvidoEm: null,
        criadoEm: AGORA_US - i,
      });
    }

    const r = await rodar(c);

    expect(r.avisosVarridos).toBe(RECONCILIACAO_PAGINA);
    expect(r.reconciliacaoTruncada).toBe(true);
    expect(r.reconciliados).toBe(0);
  });

  it('uma página com uma linha a MENOS que o teto não é truncada', async () => {
    const c = cenario();
    for (let i = 0; i < RECONCILIACAO_PAGINA - 1; i += 1) {
      c.db.seed(`${AVISO_PATH}/outroTipo:conta:${String(i).padStart(4, '0')}`, {
        tipo: TIPO_AVISO.shopeeAutorizacaoExpirando,
        canal: 'shopee',
        resolvidoEm: null,
        criadoEm: AGORA_US - i,
      });
    }

    const r = await rodar(c);

    expect(r.avisosVarridos).toBe(RECONCILIACAO_PAGINA - 1);
    expect(r.reconciliacaoTruncada).toBe(false);
  });

  it('o dry run decide a passagem (b) igual e NÃO fecha nada', async () => {
    const c = cenario();
    const pedidoId = semearPedido(c.db);
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'UNPAID')]]));
    await rodar(c);
    c.db.store[`${PEDIDO_PATH}/${pedidoId}`]!.data.estado = ESTADO_PEDIDO.pago;

    const escritasAntes = c.db.writes.length;
    const r = await rodar(c, { nowMs: AGORA_MS + 7 * DIA_MS, forcarDryRun: true });

    expect(r.reconciliados).toBe(1);
    expect(c.db.writes).toHaveLength(escritasAntes);
    expect(
      c.db.store[`${AVISO_PATH}/${chaveReservaTravada(INT_A, pedidoId)}`]!.data.resolvidoEm,
    ).toBeNull();
  });

  it('params não carregam nenhum dado do comprador', async () => {
    const c = cenario();
    const pedidoId = semearPedido(c.db);
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linhaComPii(SN_A, 'UNPAID')]]));

    await rodar(c);

    const doc = c.db.store[`${AVISO_PATH}/${chaveReservaTravada(INT_A, pedidoId)}`]!.data;
    const params = doc.params as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual(['pedido', 'situacao']);
    expect(params.pedido).toBe(SN_A);
    const serializado = JSON.stringify(doc);
    for (const segredo of [ENDERECO_FALSO, CPF_FALSO, String(BUYER_ID_FALSO)]) {
      expect(serializado).not.toContain(segredo);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  8 — the diagnostic tables and the invariant                               */
/* -------------------------------------------------------------------------- */

describe('runReservaTravadaSweep — o instrumento', () => {
  it('as três tabelas de diagnóstico saem ANTES de qualquer chamada à Shopee', async () => {
    const c = cenario();
    semearPedido(c.db, { orderSn: SN_A, diasAtras: 20 });
    semearPedido(c.db, {
      orderSn: '260910VELHO',
      diasAtras: 100,
      over: {
        marketplace: { tipo: 'shopee', status: 'PENDING', statusEm: AGORA_US - 100 * DIA_US },
      },
    });
    // Um cliente que morre em TODA chamada: as tabelas ainda têm de sair.
    c.getOrderDetail = vi.fn(() => Promise.reject(new ShopeeNetworkError('sem rede')));

    const r = await rodar(c);

    expect(r.veredictos['nao-verificavel']).toBe(2);
    expect(r.statusArmazenado).toEqual({ UNPAID: 1, PENDING: 1 });
    expect(r.idadeStatusDias).toEqual({ '7-14': 0, '14-30': 1, '30-60': 0, '60-90': 0, '90+': 1 });
    expect(r.statusPorIdade.UNPAID!['14-30']).toBe(1);
    expect(r.statusPorIdade.PENDING!['90+']).toBe(1);
    // A junção só fica completa depois dos vereditos, e é a leitura útil.
    expect(r.statusArmazenadoPorVeredito.UNPAID!['nao-verificavel']).toBe(1);
    esperarInvariante(r);
  });

  it('um statusEm ilegível conta no status mas em nenhuma tabela de idade', async () => {
    const c = cenario();
    semearPedido(c.db, {
      over: { marketplace: { tipo: 'shopee', status: 'UNPAID', statusEm: null } },
    });
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'UNPAID')]]));

    const r = await rodar(c);

    expect(r.statusArmazenado).toEqual({ UNPAID: 1 });
    expect(r.idadeStatusDias).toEqual({ '7-14': 0, '14-30': 0, '30-60': 0, '60-90': 0, '90+': 0 });
    expect(r.statusPorIdade).toEqual({});
  });

  it('redriveAparentementeNaoAplicado conta o status armazenado IGUAL ao vivo num redirecionado', async () => {
    const c = cenario();
    // A entrega foi aceita (o bloco `marketplace` é escrito em toda entrega
    // aceita, no seu próprio grupo) e mesmo assim o estado não andou.
    semearPedido(c.db, {
      over: {
        marketplace: { tipo: 'shopee', status: 'CANCELLED', statusEm: AGORA_US - 30 * DIA_US },
      },
    });
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'CANCELLED')]]));

    const r = await rodar(c);

    expect(r.veredictos['redirecionado-cancelado']).toBe(1);
    expect(r.redriveAparentementeNaoAplicado).toBe(1);
    esperarInvariante(r);
  });

  it('um redirecionado cujo status armazenado DIFERE do vivo não conta', async () => {
    const c = cenario();
    semearPedido(c.db);
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'CANCELLED')]]));

    const r = await rodar(c);

    expect(r.veredictos['redirecionado-cancelado']).toBe(1);
    expect(r.redriveAparentementeNaoAplicado).toBe(0);
  });

  it('Σ veredictos === candidatos em todo fixture, e as porteiras 1 ficam de fora', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_B}`, contaDoc({ shop_id: SHOP_B }));
    semearPedido(c.db, { orderSn: '260910UM', diasAtras: 30 });
    semearPedido(c.db, {
      orderSn: '260910DOIS',
      diasAtras: 31,
      over: { hasUserInteraction: true },
    });
    semearPedido(c.db, { orderSn: '260910TRES', diasAtras: 32 });
    semearPedido(c.db, { integracaoId: INT_B, orderSn: '260910QUAT', diasAtras: 33 });
    semearPedido(c.db, { idAlheio: 'nao-nosso', over: { marketplace: null } });
    c.db.seed(`${PEDIDO_PATH}/sem-nada`, {
      ehSaida: true,
      estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
      timestamp: AGORA_US - 50 * DIA_US,
    });
    c.getOrderDetail = clienteTabela(
      new Map([
        ['260910UM', linha('260910UM', 'UNPAID')],
        ['260910TRES', linha('260910TRES', 'CANCELLED')],
        ['260910QUAT', linha('260910QUAT', 'TO_RETURN')],
      ]),
    );

    const r = await rodar(c);

    expect(r.examinados).toBe(6);
    expect(r.naoMarketplace).toBe(2);
    expect(r.candidatos).toBe(4);
    esperarInvariante(r);
    // ⚠️ Os contadores de porteira NUNCA são somados a `candidatos`.
    expect(r.naoMarketplace + r.candidatos).toBe(r.examinados);
  });

  it('os braços de valor ZERO estão presentes — uma chave ausente é indistinguível de um braço que não existia', async () => {
    const c = cenario();
    const r = await rodar(c);

    expect(Object.keys(r.veredictos).sort()).toEqual(
      Object.values(VEREDITO_RESERVA_TRAVADA).sort(),
    );
    expect(Object.values(r.veredictos).every((n) => n === 0)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  9 — the guards                                                            */
/* -------------------------------------------------------------------------- */

const AQUI = dirname(fileURLToPath(import.meta.url));
const FONTE_SWEEP = readFileSync(resolve(AQUI, 'reservaTravadaSweep.ts'), 'utf8');

describe('as guardas', () => {
  it('o módulo NUNCA nomeia a API de transação', () => {
    // A âncora primeiro: um teste de ausência sobre um arquivo que deixou de ser
    // lido passaria para sempre.
    expect(FONTE_SWEEP).toContain('export async function runReservaTravadaSweep');
    expect(FONTE_SWEEP).not.toContain('runTransaction');
    // `firestore-transaction-inventory` varre TEXTO CRU sobre `*.ts` e exclui
    // `*.test.ts` — por isso ESTE arquivo pode soletrar a palavra e o módulo
    // não. Não "conserte" isso montando a literal por concatenação.
  });

  it('o módulo não nomeia nenhum token de order_status próprio', () => {
    // A ÚNICA tabela de status é `estadoPedidoDeOrderStatus`, alcançada pelo
    // classificador. Um segundo mapa derivando para o plausível é o defeito que
    // este canal já pagou uma vez.
    for (const token of [
      'UNPAID',
      'PENDING',
      'READY_TO_SHIP',
      'PROCESSED',
      'RETRY_SHIP',
      'SHIPPED',
      'TO_CONFIRM_RECEIVE',
      'IN_CANCEL',
      'CANCELLED',
      'TO_RETURN',
      'COMPLETED',
    ]) {
      expect(FONTE_SWEEP).not.toContain(`'${token}'`);
    }
  });

  it('nenhuma linha de log carrega endereço, id de comprador ou CPF', async () => {
    const c = cenario();
    // Um pedido com digest Shopee e SEM watermark força o `warn` do módulo…
    semearPedido(c.db, {
      orderSn: '260910SEMWM',
      diasAtras: 30,
      over: { lastMarketplaceUpdate: null },
    });
    // …e um candidato de verdade cuja linha carrega os três campos de comprador.
    semearPedido(c.db, { orderSn: SN_A, diasAtras: 31 });
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linhaComPii(SN_A, 'UNPAID')]]));
    const spies = [
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];

    // Sem `logger` injetado: o padrão do módulo É o console.
    const r = await rodar(c, { semLogger: true });

    expect(r.veredictos['ainda-nao-pago']).toBe(1);
    // Não-vacuidade: se o tick não tivesse logado NADA, a asserção de ausência
    // abaixo passaria para sempre.
    expect(spies[0]!).toHaveBeenCalled();
    const tudo = spies
      .flatMap((s) => s.mock.calls)
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join('\n');
    for (const segredo of [ENDERECO_FALSO, CPF_FALSO, String(BUYER_ID_FALSO)]) {
      expect(tudo).not.toContain(segredo);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  10 — the two no-new-index proofs                                          */
/* -------------------------------------------------------------------------- */

interface EntradaIndice {
  collectionGroup?: string;
  queryScope?: string;
  fields?: { fieldPath?: string; order?: string }[];
}

const RAIZ = resolve(AQUI, '../../../../..');
const INDICES = (
  JSON.parse(readFileSync(resolve(RAIZ, 'firestore.indexes.json'), 'utf8')) as {
    indexes?: EntradaIndice[];
  }
).indexes;

describe('nenhuma das duas consultas exige um índice NOVO', () => {
  it('firestore.indexes.json é legível e não está vazio', () => {
    // Sem isto, um arquivo ilegível faria todo o resto passar por não achar nada
    // com que discordar.
    expect(Array.isArray(INDICES)).toBe(true);
    expect(INDICES!.length).toBeGreaterThan(0);
  });

  /**
   * ⚠️ A regra de modelagem, escrita porque a especificação abaixo é feita à
   * MÃO e o teste vale exatamente o que ela valer: `deriveRequiredIndex` trata
   * TODA entrada de `where` como uma igualdade ASCENDENTE, então um `in` de um
   * elemento entra como igualdade e a desigualdade `timestamp <` NÃO entra —
   * ela cavalga a vaga do `orderBy`. Passar `timestamp` também no `where`
   * derivaria um índice de QUATRO campos e reprovaria contra o composto de três
   * que está declarado.
   */
  const CANDIDATOS: RequiredIndex = deriveRequiredIndex('pedidos', {
    where: [{ field: 'ehSaida' }, { field: 'estado' }],
    orderBy: [{ field: 'timestamp', direction: 'desc' }],
  });

  const RECONCILIACAO: RequiredIndex = deriveRequiredIndex('avisos', {
    where: [{ field: 'resolvidoEm' }],
    orderBy: [{ field: 'criadoEm', direction: 'desc' }],
  });

  it('a consulta de candidatos roda em (ehSaida ASC, estado ASC, timestamp DESC), já declarado', () => {
    expect(CANDIDATOS.fields).toEqual([
      { fieldPath: 'ehSaida', order: 'ASCENDING' },
      { fieldPath: 'estado', order: 'ASCENDING' },
      { fieldPath: 'timestamp', order: 'DESCENDING' },
    ]);
    expect(INDICES!.some((i) => indexSatisfies(i, CANDIDATOS))).toBe(true);
  });

  it('a consulta do reconciliador roda em (resolvidoEm ASC, criadoEm DESC), já declarado', () => {
    expect(RECONCILIACAO.fields).toEqual([
      { fieldPath: 'resolvidoEm', order: 'ASCENDING' },
      { fieldPath: 'criadoEm', order: 'DESCENDING' },
    ]);
    expect(INDICES!.some((i) => indexSatisfies(i, RECONCILIACAO))).toBe(true);
  });

  describe('o próprio detector', () => {
    it('aceita o conhecido-BOM', () => {
      expect(
        indexSatisfies(
          {
            collectionGroup: 'pedidos',
            queryScope: 'COLLECTION',
            fields: [
              { fieldPath: 'ehSaida', order: 'ASCENDING' },
              { fieldPath: 'estado', order: 'ASCENDING' },
              { fieldPath: 'timestamp', order: 'DESCENDING' },
            ],
          },
          CANDIDATOS,
        ),
      ).toBe(true);
    });

    it('recusa o conhecido-RUIM: a direção do orderBy invertida', () => {
      // Um índice ASCENDENTE não serve um `orderBy desc`. Se isto passasse, o
      // teste aceitaria um índice que não atende à consulta — e na Enterprise o
      // sinal disso é a FATURA, não uma exceção.
      expect(
        indexSatisfies(
          {
            collectionGroup: 'pedidos',
            queryScope: 'COLLECTION',
            fields: [
              { fieldPath: 'ehSaida', order: 'ASCENDING' },
              { fieldPath: 'estado', order: 'ASCENDING' },
              { fieldPath: 'timestamp', order: 'ASCENDING' },
            ],
          },
          CANDIDATOS,
        ),
      ).toBe(false);
    });

    it('recusa o conhecido-RUIM: um campo a menos e uma coleção errada', () => {
      expect(
        indexSatisfies(
          {
            collectionGroup: 'pedidos',
            queryScope: 'COLLECTION',
            fields: [
              { fieldPath: 'ehSaida', order: 'ASCENDING' },
              { fieldPath: 'timestamp', order: 'DESCENDING' },
            ],
          },
          CANDIDATOS,
        ),
      ).toBe(false);
      expect(
        indexSatisfies(
          {
            collectionGroup: 'avisos',
            queryScope: 'COLLECTION',
            fields: [
              { fieldPath: 'ehSaida', order: 'ASCENDING' },
              { fieldPath: 'estado', order: 'ASCENDING' },
              { fieldPath: 'timestamp', order: 'DESCENDING' },
            ],
          },
          CANDIDATOS,
        ),
      ).toBe(false);
    });
  });

  it('⚠️ a Enterprise omite o __name__ final — os dois compostos param nos campos reais', () => {
    const nossos = INDICES!.filter(
      (i) =>
        (i.collectionGroup === 'pedidos' || i.collectionGroup === 'avisos') &&
        (indexSatisfies(i, CANDIDATOS) || indexSatisfies(i, RECONCILIACAO)),
    );
    expect(nossos.length).toBe(2);
    for (const i of nossos) {
      expect(i.fields?.map((f) => f.fieldPath)).not.toContain('__name__');
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  10 — the observation seam (wave 4): `deps.onCandidato`                     */
/* -------------------------------------------------------------------------- */

/**
 * The twelve field names {@link CandidatoObservado} may carry, pinned HERE as
 * well as in `varrerReservasCli.test.ts`.
 *
 * ⚠️ Two pins on purpose, at two layers: this one says the SWEEP emits exactly
 * these, the CLI's says its allow-list admits exactly these. A single pin would
 * let a field added at the seam ride straight through the summary that is
 * supposed to BE the redaction.
 */
const CAMPOS_OBSERVADOS = [
  'pedidoId',
  'integracaoId',
  'orderSn',
  'veredito',
  'orderStatus',
  'pendingTerms',
  'temPayTime',
  'idadeDias',
  'cancelBy',
  'cancelReason',
  'enfileiraria',
  'avisaria',
];

describe('runReservaTravadaSweep — a observação por candidato', () => {
  it.each(CASOS_PARIDADE.map((k) => [k.nome, k] as const))(
    'onCandidato é chamado exatamente uma vez por candidato, em todo veredito › %s',
    async (_nome, caso) => {
      const c = cenario();
      caso.montar(c);
      if (caso.tasksOff === true) process.env.SHOPEE_TASKS_DISABLED = '1';
      const vistos: CandidatoObservado[] = [];

      const r = await rodar(c, { onCandidato: (obs) => vistos.push(obs) });

      // ⚠️ Uma linha por candidato, nem mais nem menos — e é ESTRUTURAL: a
      // chamada mora dentro da única função que registra um veredito, que é a
      // mesma propriedade que `Σ veredictos === candidatos` fixa.
      expect(vistos).toHaveLength(r.candidatos);
      expect(r.candidatos).toBe(1);
      expect(vistos[0]!.veredito).toBe(caso.veredito);
      expect(vistos[0]!.integracaoId).toBe(INT_A);
      expect(vistos[0]!.orderSn).toBe(SN_A);
      expect(new Set(vistos.map((v) => v.pedidoId)).size).toBe(vistos.length);
      esperarInvariante(r);
    },
  );

  it('três candidatos num tick ⇒ três linhas, uma por pedidoId, e nenhuma repetida', async () => {
    const c = cenario();
    const sns = ['260910KJBHUJDM', '260910KJBHUJDN', '260910KJBHUJDP'];
    const ids = sns.map((sn) => semearPedido(c.db, { orderSn: sn }));
    c.getOrderDetail = clienteTabela(
      new Map([
        [sns[0]!, linha(sns[0]!, 'UNPAID')],
        [sns[1]!, linha(sns[1]!, 'CANCELLED')],
        [sns[2]!, linha(sns[2]!, 'TO_RETURN')],
      ]),
    );
    const vistos: CandidatoObservado[] = [];

    const r = await rodar(c, { onCandidato: (obs) => vistos.push(obs) });

    expect(r.candidatos).toBe(3);
    expect(vistos).toHaveLength(3);
    expect(new Set(vistos.map((v) => v.pedidoId))).toEqual(new Set(ids));
    // E cada linha carrega o veredito do SEU pedido, não o do vizinho.
    const porId = new Map(vistos.map((v) => [v.pedidoId, v]));
    expect(porId.get(ids[0]!)!.veredito).toBe(VEREDITO_RESERVA_TRAVADA.aindaNaoPago);
    expect(porId.get(ids[1]!)!.veredito).toBe(VEREDITO_RESERVA_TRAVADA.redirecionadoCancelado);
    expect(porId.get(ids[2]!)!.veredito).toBe(VEREDITO_RESERVA_TRAVADA.manterDevolucao);
    esperarInvariante(r);
  });

  it('a linha observada tem exatamente os 12 campos e nenhum dado do comprador', async () => {
    const c = cenario();
    semearPedido(c.db);
    // A linha `.passthrough()` que carrega tudo que a Shopee poderia mandar de
    // carona — endereço, CPF e id do comprador.
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linhaComPii(SN_A, 'UNPAID')]]));
    const vistos: CandidatoObservado[] = [];

    await rodar(c, { onCandidato: (obs) => vistos.push(obs) });

    expect(vistos).toHaveLength(1);
    expect(Object.keys(vistos[0]!).sort()).toEqual([...CAMPOS_OBSERVADOS].sort());
    const serializado = JSON.stringify(vistos);
    expect(serializado).not.toContain(ENDERECO_FALSO);
    expect(serializado).not.toContain(CPF_FALSO);
    expect(serializado).not.toContain(String(BUYER_ID_FALSO));
    expect(serializado).not.toContain('buyer_');
    // ÂNCORA: o negativo não pode ser vazio — a linha carrega mesmo o que o
    // ensaio precisa ler.
    expect(vistos[0]!.orderStatus).toBe('UNPAID');
    expect(vistos[0]!.idadeDias).toBe(30);
    expect(vistos[0]!.avisaria).toBe(true);
  });

  it('cancelBy e cancelReason chegam do wire só nos vereditos lidos', async () => {
    const c = cenario();
    semearPedido(c.db);
    c.getOrderDetail = clienteTabela(
      new Map([
        [
          SN_A,
          linha(SN_A, 'CANCELLED', {
            cancel_by: 'system',
            cancel_reason: 'BACKEND_LOGISTICS_NOT_STARTED',
          }),
        ],
      ]),
    );
    const lidos: CandidatoObservado[] = [];
    await rodar(c, { onCandidato: (obs) => lidos.push(obs) });

    // ⚠️ As duas colunas morriam dentro do consumidor do lote; elas são o
    // observável do item 37 do registro e por isso são passadas UMA A UMA.
    expect(lidos[0]!.cancelBy).toBe('system');
    expect(lidos[0]!.cancelReason).toBe('BACKEND_LOGISTICS_NOT_STARTED');
    expect(lidos[0]!.enfileiraria).toBe(true);

    // Um veredito de porteira não leu linha nenhuma ⇒ não pode inventar nada.
    const d = cenario();
    semearPedido(d.db, { over: { hasUserInteraction: true } });
    const porteira: CandidatoObservado[] = [];
    await rodar(d, { onCandidato: (obs) => porteira.push(obs) });

    expect(porteira[0]!.veredito).toBe(VEREDITO_RESERVA_TRAVADA.interacaoHumana);
    expect(porteira[0]!.orderStatus).toBeNull();
    expect(porteira[0]!.cancelBy).toBeNull();
    expect(porteira[0]!.cancelReason).toBeNull();
    expect(porteira[0]!.temPayTime).toBe(false);
    expect(porteira[0]!.enfileiraria).toBe(false);
    expect(porteira[0]!.avisaria).toBe(false);
    expect(d.getOrderDetail).not.toHaveBeenCalled();
  });

  it('com a fila desabilitada `enfileiraria` é FALSO, e o veredito acompanha', async () => {
    const c = cenario();
    semearPedido(c.db);
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'CANCELLED')]]));
    process.env.SHOPEE_TASKS_DISABLED = '1';
    const vistos: CandidatoObservado[] = [];

    await rodar(c, { onCandidato: (obs) => vistos.push(obs) });

    // A previsão é sobre o que um tick VIVO com a válvula aberta faria; com ela
    // fechada não há enfileiramento a prever, e o veredito diz o porquê.
    expect(vistos[0]!.veredito).toBe(VEREDITO_RESERVA_TRAVADA.tasksDesabilitado);
    expect(vistos[0]!.enfileiraria).toBe(false);
    expect(c.enqueue).not.toHaveBeenCalled();
  });

  it('o dry run observa o MESMO que o tick vivo — é para isso que o ensaio existe', async () => {
    const montar = (c: Cenario): void => {
      semearPedido(c.db);
      c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'CANCELLED')]]));
    };
    const vivo = cenario();
    montar(vivo);
    const obsVivo: CandidatoObservado[] = [];
    await rodar(vivo, { onCandidato: (o) => obsVivo.push(o) });

    const seco = cenario();
    montar(seco);
    const obsSeco: CandidatoObservado[] = [];
    await rodar(seco, { forcarDryRun: true, onCandidato: (o) => obsSeco.push(o) });

    expect(obsSeco).toEqual(obsVivo);
    expect(obsSeco[0]!.enfileiraria).toBe(true);
    expect(seco.db.writes).toEqual([]);
    expect(seco.enqueue).not.toHaveBeenCalled();
  });

  it('uma exceção DENTRO do callback sobe — não vira erros[] nem contenção por conta', async () => {
    const c = cenario();
    semearPedido(c.db);
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'UNPAID')]]));

    // ⚠️ A falha é do ENSAIO, não da varredura. Engoli-la faria a CLI perder
    // linhas exatamente da tabela cruzada que ela existe para montar.
    await expect(
      rodar(c, {
        onCandidato: () => {
          throw new TypeError('o ensaio quebrou');
        },
      }),
    ).rejects.toThrow('o ensaio quebrou');
  });

  it('sem onCandidato nada muda — o resultado é idêntico', async () => {
    const montar = (c: Cenario): void => {
      semearPedido(c.db);
      semearPedido(c.db, { orderSn: '260910KJBHUJDN' });
      c.getOrderDetail = clienteTabela(
        new Map([
          [SN_A, linha(SN_A, 'UNPAID')],
          ['260910KJBHUJDN', linha('260910KJBHUJDN', 'SHIPPED')],
        ]),
      );
    };
    const sem = cenario();
    montar(sem);
    const rSem = await rodar(sem);

    const com = cenario();
    montar(com);
    const rCom = await rodar(com, { onCandidato: () => {} });

    // O tick devolve contadores e só contadores: o seam não entra no resultado.
    expect(rSem).toEqual(rCom);
    expect(Object.keys(rSem)).not.toContain('candidatosObservados');
    esperarInvariante(rSem);
  });

  it('o par do dry-run da CLI roda com a flag mestra AUSENTE e não grava nada', async () => {
    // ⚠️ Este é o contrato da CLI, dirigido pelo tick de verdade: `--dry-run` (o
    // padrão) entrega `forcarDryRun` + `ignorarFlagMestra`, porque o ensaio tem
    // de rodar ANTES de a flag mestra existir no `.env.deploy` — e a asserção
    // pareada do tick é o que torna "pode ensaiar antes da flag, nunca pode
    // escrever antes da flag" estrutural.
    const c = cenario();
    semearPedido(c.db);
    c.getOrderDetail = clienteTabela(new Map([[SN_A, linha(SN_A, 'UNPAID')]]));
    delete process.env[RESERVA_TRAVADA_FLAG_ENV];
    const vistos: CandidatoObservado[] = [];

    const r = await rodar(c, {
      forcarDryRun: true,
      ignorarFlagMestra: true,
      onCandidato: (o) => vistos.push(o),
    });

    expect(r.enabled).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.candidatos).toBe(1);
    expect(vistos).toHaveLength(1);
    expect(vistos[0]!.avisaria).toBe(true);
    // Leu o Firestore E a Shopee…
    expect(c.getOrderDetail).toHaveBeenCalledTimes(1);
    expect(c.db.consultasCompletas.length).toBeGreaterThan(0);
    // …e não escreveu nem enfileirou NADA.
    expect(c.db.writes).toEqual([]);
    expect(c.enqueue).not.toHaveBeenCalled();
    esperarInvariante(r);
  });
});
