import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from 'vitest';
import { AppErrorCode } from 'firebase-admin/app';
import type { Firestore } from 'firebase-admin/firestore';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  incidenteCollection,
  integracaoCollection,
  notificacaoShopeeCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import { INTEGRACAO_TIPO, ORIGEM_INCIDENTE } from '@delfrance/schemas';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_RETURN_LIST_MAX_PAGE_SIZE,
  SHOPEE_RETURN_LIST_MAX_WINDOW_SECONDS,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeRateLimitError,
  assertReturnListParams,
  shopeeReturnDetailSchema,
  shopeeReturnListSchema,
  type GetReturnListParams,
  type ShopeeClient,
  type ShopeeReturnListEnvelope,
} from '@delfrance/integrations-shopee';

import { FIXTURE_RETURN_LIST_DOC, lerFixture, lerListaDeDevolucoes } from '../fixtures/wireCorpus';
import {
  docIdOf,
  handleNotificationTask,
  reprocessDeferredNotifications,
  type DestinoPush,
  type ShopeeNotificationPayload,
  type ShopeeProcessDeps,
  type TaskResult,
} from '../notificacoes/notificacao';
import { makePedidoIdShopee } from '../pedidos/orderIds';
import { ShopeeTasksDisabledError, type ShopeeTaskScheduler } from '../shopeeTasks';
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import {
  CORPO_DA_RESPOSTA_DO_TASKS,
  falhaDoApp,
  falhaDoFunctions,
  rejeicaoDoTransporte,
} from '../testing/falhaDeEnfileiramento';
import { mapearDevolucaoShopee } from './devolucaoMapping';
import { salvarIncidenteDevolucaoShopee } from './devolucaoTx';
import {
  JANELA_DEVOLUCOES_SEGUNDOS,
  MAX_ENFILEIRADOS_DEVOLUCOES_POR_CONTA,
  MAX_PAGINAS_DEVOLUCOES_POR_CONTA,
  MOTIVO_SWEEP_DEVOLUCOES,
  SHOPEE_DEVOLUCAO_SWEEP_DISABLED_ENV,
  runShopeeDevolucoesSweep,
  sweepDevolucoesDesligado,
  type ResultadoContaSweepDevolucoes,
  type ResultadoSweepDevolucoes,
  type ShopeeDevolucoesSweepDeps,
} from './devolucoesSweep';
import { idIncidenteDevolucaoShopee } from './idsDevolucao';
import { importarDevolucaoShopee } from './importarDevolucao';
import { alvoDoPushDeDevolucao } from './pushDevolucao';

/**
 * The returns reconciliation (step 17, #1525, R-7) against the REAL FakeDb, the
 * REAL predicate (`motivoDeReimportacao`), the REAL synthetic builder, the REAL
 * code-29 parser and — for the round trips — the REAL importer and its
 * transaction (the same-day re-import also delivers through the REAL code-29
 * arm and notification pipeline). Mocked: `loadShopeeContext` (only to observe
 * the default client seam) and `destinoDoCodigo` for code 29 (only to express
 * a table where 29 is not routed — every other code, and 29 by default, read
 * the REAL table).
 *
 * `FakeDb` has no `getAll`; the subclass below adds one that answers in
 * REVERSED order, so a positional reconciliation fails here instead of in
 * production.
 */

/* -------------------------------------------------------------------------- */
/*  Mocks                                                                      */
/* -------------------------------------------------------------------------- */

const h = vi.hoisted(() => ({
  loadCtx: vi.fn(),
  /** `null` ⇒ the REAL dispatch table answers code 29. */
  destino29: null as DestinoPush | null,
}));

vi.mock('../core/shopee', async (importActual) => {
  const actual = await importActual<typeof import('../core/shopee')>();
  return { ...actual, loadShopeeContext: h.loadCtx };
});

vi.mock('../notificacoes/notificacao', async (importActual) => {
  const real = await importActual<typeof import('../notificacoes/notificacao')>();
  return {
    ...real,
    destinoDoCodigo: (code: number): DestinoPush =>
      code === 29 && h.destino29 !== null ? h.destino29 : real.destinoDoCodigo(code),
  };
});

/* -------------------------------------------------------------------------- */
/*  Fixtures — fixture ids only. No real partner, shop, order or return.       */
/* -------------------------------------------------------------------------- */

const AGORA_MS = 1_767_000_000_000;
const AGORA_S = 1_767_000_000;
/** The START of AGORA_MS's UTC day (AGORA_MS is 9 h 20 min into it) — the code 29's stamp. */
const DIA_DE_AGORA_MS = 1_766_966_400_000;
const DIA_MS = 86_400_000;
/** A return's clock inside the window: one hour before the tick. */
const T_S = AGORA_S - 3_600;
const INTEGRACAO_PATH = integracaoCollection.resolvePath({});
const PEDIDO_PATH = pedidoCollection.resolvePath({});
const NOTIFICACAO_PATH = notificacaoShopeeCollection.resolvePath({});
const INT_A = 'int-1';
const INT_B = 'int-2';
const INT_SEM_SHOP = 'int-sem-shop';
const SHOP_A = 987654;
const SHOP_B = 987655;
const ORDER_SN = '260910KJBHUJDM';
/** The frozen ALPHANUMERIC fixture return_sn (reconcile header). */
const DEVOLUCAO = '260910ABCDE0001';
const DEVOLUCAO_2 = '260910ABCDE0002';
const TASKS_DISABLED_ENV = 'SHOPEE_TASKS_DISABLED';

/**
 * An INJECTED environment holding only `over` — plus the `NODE_ENV` Next's
 * typing of `NodeJS.ProcessEnv` requires. Never a spread of `process.env`:
 * the ambient valves must not decide any test.
 */
function envInjetado(over: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...over };
}

/** A synthetic return_sn, fixture-shaped (`260910ABCDE` + 4 digits). */
function devolucaoN(n: number): string {
  return `260910ABCDE${String(n).padStart(4, '0')}`;
}

/** One `get_return_list` row as the wire sends it (every key the app reads). */
function linhaWire(returnSn: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    return_sn: returnSn,
    order_sn: ORDER_SN,
    status: 'REQUESTED',
    update_time: T_S,
    create_time: T_S - 3_600,
    reason: 'NOT_RECEIPT',
    refund_amount: 13.97,
    amount_before_discount: 13.99,
    currency: 'BRL',
    due_date: T_S + 3 * 86_400,
    return_ship_due_date: T_S + 5 * 86_400,
    return_seller_due_date: T_S + 2 * 86_400,
    negotiation_status: 'PENDING_RESPOND',
    seller_proof_status: 'PENDING',
    seller_compensation_status: 'PENDING_REQUEST',
    return_refund_type: 'NORMAL',
    return_solution: 0,
    return_refund_request_type: 0,
    validation_type: 'seller_validation',
    is_seller_arrange: false,
    ...over,
  };
}

/** One page, RAW wire through the REAL list schema (a drifted row becomes `null`). */
function pagina(linhas: readonly unknown[], more = false, error = '-'): ShopeeReturnListEnvelope {
  return shopeeReturnListSchema.parse({
    error,
    message: '-',
    response: { more, return: linhas },
  });
}

/**
 * The DETAIL the importer would read for a list row: the same common fields,
 * with the three flat sub-statuses nested where `get_return_detail` carries
 * them. RAW wire.
 */
function detalheDaLinha(linha: Record<string, unknown>): Record<string, unknown> {
  const { negotiation_status, seller_proof_status, seller_compensation_status, ...comuns } = linha;
  return {
    ...comuns,
    negotiation: { negotiation_status },
    seller_proof: { seller_proof_status },
    seller_compensation: { seller_compensation_status },
  };
}

/** `FakeDb` + the `getAll` the sweep reads with — answered in REVERSED order. */
class FakeDbComGetAll extends FakeDb {
  /** Each `getAll`: the document paths it asked for, in request order. */
  readonly leiturasEmLote: string[][] = [];

  getAll(
    ...refs: {
      path: string;
      id: string;
      get: () => Promise<{ exists: boolean; data: () => unknown }>;
    }[]
  ): Promise<unknown[]> {
    this.leiturasEmLote.push(refs.map((r) => r.path));
    return Promise.all(
      refs.map(async (r) => {
        const snap = await r.get();
        return { id: r.id, ref: { path: r.path }, exists: snap.exists, data: snap.data };
      }),
    ).then((snaps) => snaps.reverse());
  }
}

type ListaMock = Mock<(p: GetReturnListParams) => Promise<ShopeeReturnListEnvelope>>;
type EnqueueMock = Mock<(p: ShopeeNotificationPayload) => Promise<void>>;

interface Log {
  readonly msg: string;
  readonly meta: unknown;
}

interface Cenario {
  readonly db: FakeDbComGetAll;
  readonly lista: ListaMock;
  readonly enqueue: EnqueueMock;
  readonly client: Pick<ShopeeClient, 'getReturnList'>;
  readonly clientPor: Map<string, Pick<ShopeeClient, 'getReturnList'>>;
  readonly logs: Log[];
}

/** A scenario whose list answers `paginas` in order, then an empty last page. */
function cenario(...paginas: ShopeeReturnListEnvelope[]): Cenario {
  const fila = [...paginas];
  const lista: ListaMock = vi.fn<(p: GetReturnListParams) => Promise<ShopeeReturnListEnvelope>>(
    () => Promise.resolve(fila.shift() ?? pagina([])),
  );
  const enqueue: EnqueueMock = vi.fn<(p: ShopeeNotificationPayload) => Promise<void>>(() =>
    Promise.resolve(),
  );
  return {
    db: new FakeDbComGetAll(),
    lista,
    enqueue,
    client: { getReturnList: lista },
    clientPor: new Map(),
    logs: [],
  };
}

function semearConta(c: Cenario, integracaoId: string, shopId: number | null = SHOP_A): void {
  c.db.seed(`${INTEGRACAO_PATH}/${integracaoId}`, {
    tipo: INTEGRACAO_TIPO.shopee,
    ativo: true,
    nome: 'Loja BR',
    ...(shopId === null ? {} : { shop_id: shopId }),
  });
}

function pedidoIdDe(integracaoId: string = INT_A, orderSn: string = ORDER_SN): string {
  return makePedidoIdShopee(integracaoId, orderSn);
}

function caminhoDoIncidente(returnSn: string, integracaoId: string = INT_A): string {
  return `${incidenteCollection.resolvePath({ pedidoId: pedidoIdDe(integracaoId) })}/${idIncidenteDevolucaoShopee(returnSn)}`;
}

/** Store the incidente EXACTLY as the importer's transaction writes it for `linha`. */
async function importadaComo(c: Cenario, linha: Record<string, unknown>): Promise<void> {
  const pedidoId = pedidoIdDe();
  c.db.seed(`${PEDIDO_PATH}/${pedidoId}`, { numero: ORDER_SN });
  const detalhe = shopeeReturnDetailSchema.parse({
    error: '-',
    message: '-',
    response: detalheDaLinha(linha),
  });
  const r = await salvarIncidenteDevolucaoShopee(asDb(c.db), {
    pedidoId,
    incidenteId: idIncidenteDevolucaoShopee(detalhe.response.return_sn),
    mapeada: mapearDevolucaoShopee(detalhe.response),
  });
  // ÂNCORA: the helper really stored something.
  expect(r.acao).not.toBe('ignorado-sem-pedido');
}

/** Overwrite fields of a stored incidente (an operator's edit, a legacy row). */
function editarIncidente(c: Cenario, returnSn: string, campos: Record<string, unknown>): void {
  const caminho = caminhoDoIncidente(returnSn);
  const atual = c.db.store[caminho]?.data;
  if (atual === undefined) throw new Error('incidente não semeado');
  c.db.seed(caminho, { ...atual, ...campos });
}

/** The code-29 failure row the pipeline would have written for `returnSn` on the day starting at `diaMs`. */
function caminhoDaFalha(returnSn: string, diaMs: number, shopId = SHOP_A): string {
  return `${NOTIFICACAO_PATH}/29:${String(shopId)}:${returnSn}:${String(diaMs)}`;
}

function rodar(
  c: Cenario,
  over: Partial<ShopeeDevolucoesSweepDeps> = {},
): Promise<ResultadoSweepDevolucoes> {
  const scheduler: ShopeeTaskScheduler = { enqueue: c.enqueue };
  return runShopeeDevolucoesSweep(asDb(c.db), {
    scheduler,
    nowMs: AGORA_MS,
    env: envInjetado(),
    logger: {
      warn: (msg: string, meta?: Record<string, unknown>): void => {
        c.logs.push({ msg, meta });
      },
    },
    clientFor: (_db, integracaoId) => Promise.resolve(c.clientPor.get(integracaoId) ?? c.client),
    ...over,
  });
}

/** The ONE conta of a single-conta scenario, or a loud failure. */
function unica(r: ResultadoSweepDevolucoes): ResultadoContaSweepDevolucoes {
  expect(r.contas).toHaveLength(1);
  const conta = r.contas[0];
  if (conta === undefined) throw new Error('nenhuma conta no resultado');
  return conta;
}

function chamadaLista(c: Cenario, n: number): GetReturnListParams {
  const p = c.lista.mock.calls[n]?.[0];
  if (p === undefined) throw new Error(`getReturnList não foi chamado ${String(n + 1)} vez(es)`);
  return p;
}

function enfileirado(c: Cenario, n: number): ShopeeNotificationPayload {
  const p = c.enqueue.mock.calls[n]?.[0];
  if (p === undefined) throw new Error(`enqueue não foi chamado ${String(n + 1)} vez(es)`);
  return p;
}

function totalEnfileiradas(r: ResultadoContaSweepDevolucoes): number {
  return Object.values(r.enfileiradas).reduce((t, n) => t + n, 0);
}

/** The partition of `ResultadoContaSweepDevolucoes`'s docblock. */
function esperarParticao(r: ResultadoContaSweepDevolucoes): void {
  expect(r.listadas).toBe(
    r.linhasIlegiveis +
      r.repetidas +
      r.jaAtualizadas +
      totalEnfileiradas(r) +
      r.comFalhaHoje +
      r.alemDoLimite,
  );
}

function apiError(code: string): ShopeeApiError {
  return new ShopeeApiError(
    `Shopee /api/v2/returns/get_return_list respondeu ${code} — ${DEVOLUCAO}`,
    {
      code,
      kind: SHOPEE_ERROR_KIND.other,
      httpStatus: 200,
      path: '/api/v2/returns/get_return_list',
    },
  );
}

function limite(kind: 'burst' | 'daily'): ShopeeRateLimitError {
  return new ShopeeRateLimitError(`Shopee respondeu ${kind}`, {
    code: kind === 'burst' ? 'error_rate_limit' : 'error_limit',
    kind,
    httpStatus: 429,
    path: '/api/v2/returns/get_return_list',
  });
}

/** A Firestore that throws on ANY property access — proof nothing was read. */
function dbQueExplode(): Firestore {
  return new Proxy(
    {},
    {
      get: (_alvo, prop) => {
        throw new Error(`o Firestore foi tocado (${String(prop)})`);
      },
    },
  ) as Firestore;
}

let info: MockInstance<typeof console.info>;

beforeEach(() => {
  // The ambient environment must not decide any test: both valves UNSET.
  vi.stubEnv(SHOPEE_DEVOLUCAO_SWEEP_DISABLED_ENV, undefined);
  vi.stubEnv(TASKS_DISABLED_ENV, undefined);
  h.loadCtx.mockReset();
  h.destino29 = null;
  // The importer's ONE delivery line (round trips only) — silenced, never asserted here.
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  h.destino29 = null;
});

/* -------------------------------------------------------------------------- */
/*                                as três portas                               */
/* -------------------------------------------------------------------------- */

describe('sweepDevolucoesDesligado — a válvula, só o literal "1"', () => {
  it.each(['1'])('%j DESLIGA', (valor) => {
    expect(sweepDevolucoesDesligado(valor)).toBe(true);
  });

  it.each(['true', ' 1', '1 ', '01', '0', '', 'sim', 'TRUE'])(
    '⛔ QUASE-FALHA: %j mantém LIGADO',
    (valor) => {
      expect(sweepDevolucoesDesligado(valor)).toBe(false);
    },
  );

  it('sem argumento lê o process.env — e só o literal "1"', () => {
    vi.stubEnv(SHOPEE_DEVOLUCAO_SWEEP_DISABLED_ENV, '1');
    expect(sweepDevolucoesDesligado()).toBe(true);
    vi.stubEnv(SHOPEE_DEVOLUCAO_SWEEP_DISABLED_ENV, 'true');
    expect(sweepDevolucoesDesligado()).toBe(false);
  });

  it('o nome da variável é o que DEPLOY.md e .env.example documentam', () => {
    expect(SHOPEE_DEVOLUCAO_SWEEP_DISABLED_ENV).toBe('SHOPEE_DEVOLUCAO_SWEEP_DISABLED');
  });
});

describe('runShopeeDevolucoesSweep — as três portas, antes de QUALQUER leitura', () => {
  async function rodarSemNada(
    env: NodeJS.ProcessEnv = envInjetado(),
  ): Promise<ResultadoSweepDevolucoes> {
    return runShopeeDevolucoesSweep(dbQueExplode(), {
      scheduler: { enqueue: () => Promise.reject(new Error('enfileirou')) },
      nowMs: AGORA_MS,
      env,
      clientFor: () => Promise.reject(new Error('cliente construído')),
      logger: {
        warn: () => {
          throw new Error('logou');
        },
      },
    });
  }

  it('a válvula "1" (deps.env) ⇒ sweep-desligado, e NADA é lido', async () => {
    const r = await rodarSemNada(envInjetado({ [SHOPEE_DEVOLUCAO_SWEEP_DISABLED_ENV]: '1' }));
    expect(r).toEqual({
      motivo: MOTIVO_SWEEP_DEVOLUCOES.desligado,
      contas: [],
      semShopId: 0,
      interrompidoPorLimite: null,
    });
  });

  it.each(['true', ' 1', '01', '0', ''])(
    '⛔ QUASE-FALHA: a válvula %j NÃO desliga — o tick lê',
    async (valor) => {
      const c = cenario();
      semearConta(c, INT_A);
      const r = await rodar(c, {
        env: envInjetado({ [SHOPEE_DEVOLUCAO_SWEEP_DISABLED_ENV]: valor }),
      });
      expect(r.motivo).toBeNull();
      expect(c.lista).toHaveBeenCalledTimes(1);
    },
  );

  it('⚠️ um env injetado SEM a variável é LIGADO — nunca "vá ler o process.env"', async () => {
    // The `?? ''` near-miss: the default parameter of `sweepDevolucoesDesligado`
    // reads the REAL process env on `undefined`, so an injected env without the
    // variable must not reach it.
    vi.stubEnv(SHOPEE_DEVOLUCAO_SWEEP_DISABLED_ENV, '1');
    const c = cenario();
    semearConta(c, INT_A);
    const r = await rodar(c, { env: envInjetado() });
    expect(r.motivo).toBeNull();
    expect(c.lista).toHaveBeenCalledTimes(1);
  });

  it('sem deps.env, a válvula é lida do process.env', async () => {
    vi.stubEnv(SHOPEE_DEVOLUCAO_SWEEP_DISABLED_ENV, '1');
    const r = await runShopeeDevolucoesSweep(dbQueExplode(), {
      scheduler: { enqueue: () => Promise.reject(new Error('enfileirou')) },
      nowMs: AGORA_MS,
    });
    expect(r.motivo).toBe(MOTIVO_SWEEP_DEVOLUCOES.desligado);
  });

  it('a tabela de despacho SEM o braço de devolução para o código 29 ⇒ handler-ausente, NADA lido', async () => {
    // ⚠️ The guard READS the table (M84): while 29 parked, every synthetic would
    // have left a terminal dead-letter row per return per tick.
    h.destino29 = 'parado';
    const r = await rodarSemNada();
    expect(r.motivo).toBe(MOTIVO_SWEEP_DEVOLUCOES.handlerAusente);
    expect(r.contas).toEqual([]);
  });

  it('a tabela REAL roteia o 29 para `devolucao` — o tick roda', async () => {
    const real = await vi.importActual<typeof import('../notificacoes/notificacao')>(
      '../notificacoes/notificacao',
    );
    expect(real.destinoDoCodigo(29)).toBe('devolucao');
    const c = cenario();
    semearConta(c, INT_A);
    expect((await rodar(c)).motivo).toBeNull();
  });

  it('SHOPEE_TASKS_DISABLED="1" ⇒ tasks-desabilitado, decidido LENDO a válvula, NADA lido', async () => {
    vi.stubEnv(TASKS_DISABLED_ENV, '1');
    const r = await rodarSemNada();
    expect(r.motivo).toBe(MOTIVO_SWEEP_DEVOLUCOES.tasksDesabilitado);
  });

  it('a ORDEM: a válvula do sweep vence as outras duas; a tabela vence a das tasks', async () => {
    vi.stubEnv(TASKS_DISABLED_ENV, '1');
    h.destino29 = 'parado';
    expect(
      (await rodarSemNada(envInjetado({ [SHOPEE_DEVOLUCAO_SWEEP_DISABLED_ENV]: '1' }))).motivo,
    ).toBe(MOTIVO_SWEEP_DEVOLUCOES.desligado);
    expect((await rodarSemNada()).motivo).toBe(MOTIVO_SWEEP_DEVOLUCOES.handlerAusente);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  a janela                                   */
/* -------------------------------------------------------------------------- */

describe('a janela e a paginação', () => {
  it('UMA janela de update_time, ancorada em ⌊nowMs/1000⌋, 15 d − 300 s, sem janela de criação', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    await rodar(c, { nowMs: AGORA_MS + 999 }); // floor, never round
    const p = chamadaLista(c, 0);
    expect(p).toEqual({
      pageNo: 0,
      pageSize: SHOPEE_RETURN_LIST_MAX_PAGE_SIZE,
      updateTimeFromS: AGORA_S - JANELA_DEVOLUCOES_SEGUNDOS,
      updateTimeToS: AGORA_S,
    });
    expect(Object.keys(p)).not.toContain('createTimeFromS');
    // The package's own guard accepts it (the call would die before the token otherwise).
    expect(() => {
      assertReturnListParams(p);
    }).not.toThrow();
  });

  it('⛔ a janela é EXATAMENTE 15 d − 300 s — abaixo do teto da Shopee, com folga para desvio de relógio', () => {
    expect(JANELA_DEVOLUCOES_SEGUNDOS).toBe(1_295_700);
    expect(JANELA_DEVOLUCOES_SEGUNDOS).toBe(SHOPEE_RETURN_LIST_MAX_WINDOW_SECONDS - 300);
    // QUASE-FALHA: a full 15 d is the package's edge, and one second past it is refused.
    expect(() => {
      assertReturnListParams({
        pageNo: 0,
        pageSize: 100,
        updateTimeFromS: AGORA_S - SHOPEE_RETURN_LIST_MAX_WINDOW_SECONDS - 1,
        updateTimeToS: AGORA_S,
      });
    }).toThrow(ShopeeConfigError);
  });

  it('página 0, depois +1 enquanto `more` — e a MESMA janela em todas', async () => {
    const c = cenario(
      pagina([linhaWire(devolucaoN(1))], true),
      pagina([linhaWire(devolucaoN(2))], true),
      pagina([linhaWire(devolucaoN(3))], false),
    );
    semearConta(c, INT_A);
    const conta = unica(await rodar(c));
    expect(c.lista.mock.calls.map(([p]) => p.pageNo)).toEqual([0, 1, 2]);
    const janelas = new Set(
      c.lista.mock.calls.map(([p]) => `${String(p.updateTimeFromS)}-${String(p.updateTimeToS)}`),
    );
    expect(janelas.size).toBe(1);
    expect(conta.paginas).toBe(3);
    expect(conta.truncada).toBe(false);
    expect(conta.enfileiradas.ausente).toBe(3);
  });

  it(`para em ${String(MAX_PAGINAS_DEVOLUCOES_POR_CONTA)} páginas com \`more\` ainda verdadeiro ⇒ truncada`, async () => {
    const paginas = Array.from({ length: MAX_PAGINAS_DEVOLUCOES_POR_CONTA + 2 }, (_, i) =>
      pagina([linhaWire(devolucaoN(i + 1))], true),
    );
    const c = cenario(...paginas);
    semearConta(c, INT_A);
    const conta = unica(await rodar(c));
    expect(c.lista).toHaveBeenCalledTimes(MAX_PAGINAS_DEVOLUCOES_POR_CONTA);
    expect(conta.truncada).toBe(true);
    esperarParticao(conta);
  });

  it('`more: false` termina mesmo com a página CHEIA — nunca a contagem de linhas', async () => {
    const cheia = Array.from({ length: 100 }, (_, i) => linhaWire(devolucaoN(i + 1)));
    const c = cenario(pagina(cheia, false));
    semearConta(c, INT_A);
    const conta = unica(await rodar(c));
    expect(c.lista).toHaveBeenCalledTimes(1);
    expect(conta.truncada).toBe(false);
  });

  it('erroEnvelope é o `error` da PRIMEIRA página, verbatim (registro 231)', async () => {
    const c = cenario(pagina([], true, ' '), pagina([], false, '-'));
    semearConta(c, INT_A);
    expect(unica(await rodar(c)).erroEnvelope).toBe(' ');
  });
});

describe('paginação ambígua (registro 235) — qualquer return_sn repetido PARA a conta', () => {
  it('base 0 ≡ 1: a página 1 repete a 0 ⇒ para, avisa, e a 0 enfileirou uma vez só', async () => {
    const linhas = [linhaWire(DEVOLUCAO), linhaWire(DEVOLUCAO_2)];
    const c = cenario(
      pagina(linhas, true),
      pagina(linhas, true),
      pagina([linhaWire(devolucaoN(9))]),
    );
    semearConta(c, INT_A);
    const conta = unica(await rodar(c));
    expect(c.lista).toHaveBeenCalledTimes(2);
    expect(conta.paginacaoAmbigua).toBe(true);
    expect(conta.repetidas).toBe(2);
    expect(c.enqueue).toHaveBeenCalledTimes(2);
    expect(c.logs.map((l) => l.msg).join('\n')).toContain('paginacao-ambigua');
    esperarParticao(conta);
  });

  it('leitura por DESLOCAMENTO: a página 1 repete N−1 e traz uma nova ⇒ a nova é avaliada, e para', async () => {
    const c = cenario(
      pagina([linhaWire(devolucaoN(1)), linhaWire(devolucaoN(2))], true),
      pagina([linhaWire(devolucaoN(2)), linhaWire(devolucaoN(3))], true),
      pagina([linhaWire(devolucaoN(4))]),
    );
    semearConta(c, INT_A);
    const conta = unica(await rodar(c));
    expect(c.lista).toHaveBeenCalledTimes(2);
    expect(conta.paginacaoAmbigua).toBe(true);
    expect(conta.repetidas).toBe(1);
    expect(c.enqueue.mock.calls.map(([p]) => p.data?.return_sn)).toEqual([
      devolucaoN(1),
      devolucaoN(2),
      devolucaoN(3),
    ]);
    esperarParticao(conta);
  });

  it('⛔ QUASE-FALHA: páginas DISTINTAS nunca são ambíguas', async () => {
    const c = cenario(
      pagina([linhaWire(devolucaoN(1))], true),
      pagina([linhaWire(devolucaoN(2))], false),
    );
    semearConta(c, INT_A);
    const conta = unica(await rodar(c));
    expect(conta.paginacaoAmbigua).toBe(false);
    expect(conta.repetidas).toBe(0);
    expect(c.logs.map((l) => l.msg).join('\n')).not.toContain('paginacao-ambigua');
  });
});

/* -------------------------------------------------------------------------- */
/*                         o predicado, linha a linha                          */
/* -------------------------------------------------------------------------- */

describe('o que é reimportado — `motivoDeReimportacao` contra o incidente que o IMPORTADOR gravou', () => {
  it('ausente ⇒ UM code 29 (`reconciliacao`) com o carimbo do DIA, e `data` exatamente {order_sn, return_sn, origem}', async () => {
    const c = cenario(pagina([linhaWire(DEVOLUCAO)]));
    semearConta(c, INT_A);
    const conta = unica(await rodar(c));
    expect(conta.enfileiradas).toEqual({ ausente: 1, relogio: 0, divergente: 0, invariante: 0 });
    expect(enfileirado(c, 0)).toEqual({
      code: 29,
      shopId: SHOP_A,
      timestamp: DIA_DE_AGORA_MS,
      data: { order_sn: ORDER_SN, return_sn: DEVOLUCAO, origem: 'reconciliacao' },
    });
    // ⛔ QUASE-FALHA: never the tick's own clock — a fresh doc id every six hours.
    expect(enfileirado(c, 0).timestamp).not.toBe(AGORA_MS);
    // The arm's own parser accepts what was enqueued.
    const alvo = alvoDoPushDeDevolucao(enfileirado(c, 0).data ?? {});
    expect(alvo).toMatchObject({
      ok: true,
      orderSn: ORDER_SN,
      returnSn: DEVOLUCAO,
      origem: 'reconciliacao',
    });
  });

  it('o incidente gravado pelo importador para a MESMA linha ⇒ jaAtualizadas, ZERO enfileirado', async () => {
    const c = cenario(pagina([linhaWire(DEVOLUCAO)]));
    semearConta(c, INT_A);
    await importadaComo(c, linhaWire(DEVOLUCAO));
    const conta = unica(await rodar(c));
    expect(conta.jaAtualizadas).toBe(1);
    expect(c.enqueue).not.toHaveBeenCalled();
    esperarParticao(conta);
  });

  it('update_time da linha MAIS NOVO que a marca d’água ⇒ relogio', async () => {
    const c = cenario(pagina([linhaWire(DEVOLUCAO, { update_time: T_S + 1 })]));
    semearConta(c, INT_A);
    await importadaComo(c, linhaWire(DEVOLUCAO));
    expect(unica(await rodar(c)).enfileiradas.relogio).toBe(1);
  });

  it.each([
    ['negotiation_status', { negotiation_status: 'TERMINATED' }],
    ['seller_proof_status', { seller_proof_status: 'UPLOADED' }],
    ['seller_compensation_status', { seller_compensation_status: 'COMPENSATION_REQUESTED' }],
    ['status', { status: 'PROCESSING' }],
    ['due_date', { due_date: T_S + 3 * 86_400 + 1 }],
    ['return_seller_due_date', { return_seller_due_date: T_S + 2 * 86_400 + 1 }],
    ['return_ship_due_date', { return_ship_due_date: T_S + 5 * 86_400 + 1 }],
    ['refund_amount', { refund_amount: 13.98 }],
  ])(
    'um campo da lista DIVERGENTE no MESMO update_time (%s) ⇒ divergente',
    async (_campo, mudanca) => {
      const c = cenario(pagina([linhaWire(DEVOLUCAO, mudanca)]));
      semearConta(c, INT_A);
      await importadaComo(c, linhaWire(DEVOLUCAO));
      const conta = unica(await rodar(c));
      expect(conta.enfileiradas).toEqual({ ausente: 0, relogio: 0, divergente: 1, invariante: 0 });
    },
  );

  it('origem RETIPADA por um operador (99) ⇒ invariante', async () => {
    const c = cenario(pagina([linhaWire(DEVOLUCAO)]));
    semearConta(c, INT_A);
    await importadaComo(c, linhaWire(DEVOLUCAO));
    editarIncidente(c, DEVOLUCAO, { origem: ORIGEM_INCIDENTE.outros });
    expect(unica(await rodar(c)).enfileiradas.invariante).toBe(1);
  });

  it('claimStatus armazenado ≠ o derivado do status ⇒ invariante (como um conjunto terminal corrigido cura)', async () => {
    const c = cenario(pagina([linhaWire(DEVOLUCAO)]));
    semearConta(c, INT_A);
    await importadaComo(c, linhaWire(DEVOLUCAO));
    editarIncidente(c, DEVOLUCAO, { claimStatus: 'closed' });
    expect(unica(await rodar(c)).enfileiradas.invariante).toBe(1);
  });

  it('a reconciliação do getAll é por CAMINHO — a dupla responde invertida, e cada linha casa com o SEU incidente', async () => {
    const c = cenario(pagina([linhaWire(DEVOLUCAO), linhaWire(DEVOLUCAO_2)]));
    semearConta(c, INT_A);
    await importadaComo(c, linhaWire(DEVOLUCAO));
    const conta = unica(await rodar(c));
    expect(conta.jaAtualizadas).toBe(1);
    expect(conta.enfileiradas.ausente).toBe(1);
    expect(enfileirado(c, 0).data?.return_sn).toBe(DEVOLUCAO_2);
  });

  it('UM getAll por página, com os ids DERIVADOS (pedido digest + `shopee-devolucao-<sn>`)', async () => {
    const c = cenario(
      pagina([linhaWire(DEVOLUCAO), linhaWire(DEVOLUCAO_2)], true),
      pagina([linhaWire(devolucaoN(3))]),
    );
    semearConta(c, INT_A);
    await rodar(c);
    expect(c.db.leiturasEmLote).toEqual([
      [caminhoDoIncidente(DEVOLUCAO), caminhoDoIncidente(DEVOLUCAO_2)],
      [caminhoDoIncidente(devolucaoN(3))],
    ]);
    // ÂNCORA: the path really is the pedido's subcollection.
    expect(caminhoDoIncidente(DEVOLUCAO)).toBe(
      `pedidos/${pedidoIdDe()}/incidentes/shopee-devolucao-${DEVOLUCAO}`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                         linhas que o braço recusaria                        */
/* -------------------------------------------------------------------------- */

describe('linhas ilegíveis — o parser do PRÓPRIO braço decide, nunca uma segunda cópia', () => {
  it.each([
    ['sem update_time (a linha vira null no schema)', { update_time: undefined }],
    ['return_sn com hífen', { return_sn: '260910-ABCDE01' }],
    ['return_sn com espaço', { return_sn: ' 260910ABCDE0001' }],
    ['order_sn com espaço (pré-imagem do pedido)', { order_sn: ` ${ORDER_SN}` }],
    ['order_sn sentinela "-"', { order_sn: '-' }],
  ])('%s ⇒ linhasIlegiveis, nada lido nem enfileirado para ela', async (_caso, mudanca) => {
    const c = cenario(pagina([linhaWire(DEVOLUCAO, mudanca)]));
    semearConta(c, INT_A);
    const conta = unica(await rodar(c));
    expect(conta.linhasIlegiveis).toBe(1);
    expect(c.db.leiturasEmLote).toEqual([]);
    expect(c.enqueue).not.toHaveBeenCalled();
    expect(c.logs.map((l) => l.msg).join('\n')).toContain('linhas ilegíveis');
    esperarParticao(conta);
  });

  it('⛔ QUASE-FALHA: um return_sn ALFANUMÉRICO bem-formado é legível (nunca um teste só de dígitos)', async () => {
    const c = cenario(pagina([linhaWire('260910ABCDE0001')]));
    semearConta(c, INT_A);
    const conta = unica(await rodar(c));
    expect(conta.linhasIlegiveis).toBe(0);
    expect(conta.enfileiradas.ausente).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                           o limite de um por dia                            */
/* -------------------------------------------------------------------------- */

/** Every point read of THE fixture pedido document (never its subcollections). */
function leiturasDoPedido(c: Cenario): readonly unknown[] {
  const caminho = `${PEDIDO_PATH}/${pedidoIdDe()}`;
  return c.db.opLog.filter((o) => o.op === 'get' && o.path === caminho);
}

describe('≤ 1 linha de falha por devolução por dia UTC (a forma do `3685867cc`)', () => {
  it('a linha de HOJE `parked` ⇒ comFalhaHoje, nada enfileirado — e o pedido nem é lido, mesmo existindo', async () => {
    const c = cenario(pagina([linhaWire(DEVOLUCAO)]));
    semearConta(c, INT_A);
    c.db.seed(`${PEDIDO_PATH}/${pedidoIdDe()}`, { numero: ORDER_SN });
    c.db.seed(caminhoDaFalha(DEVOLUCAO, DIA_DE_AGORA_MS), { status: 'parked' });
    const conta = unica(await rodar(c));
    expect(conta.comFalhaHoje).toBe(1);
    expect(c.enqueue).not.toHaveBeenCalled();
    // Terminal for the day whatever the pedido says: its read is never paid.
    expect(leiturasDoPedido(c)).toHaveLength(0);
    esperarParticao(conta);
  });

  it('a linha de HOJE `deferred` com o pedido AINDA ausente ⇒ comFalhaHoje, nada enfileirado', async () => {
    const c = cenario(pagina([linhaWire(DEVOLUCAO)]));
    semearConta(c, INT_A);
    c.db.seed(caminhoDaFalha(DEVOLUCAO, DIA_DE_AGORA_MS), { status: 'deferred' });
    const conta = unica(await rodar(c));
    expect(conta.comFalhaHoje).toBe(1);
    expect(c.enqueue).not.toHaveBeenCalled();
    // ÂNCORA: the verdict came from READING the pedido, not from the row alone.
    expect(leiturasDoPedido(c)).toHaveLength(1);
    esperarParticao(conta);
  });

  it('⛔ QUASE-FALHA: a linha de HOJE `deferred` com o pedido JÁ presente ⇒ reenfileirada, no MESMO doc id', async () => {
    // The precondition the defer waited on has cleared: skipping on the row
    // alone held the return un-imported for the rest of the UTC day.
    const c = cenario(pagina([linhaWire(DEVOLUCAO)]));
    semearConta(c, INT_A);
    c.db.seed(`${PEDIDO_PATH}/${pedidoIdDe()}`, { numero: ORDER_SN });
    c.db.seed(caminhoDaFalha(DEVOLUCAO, DIA_DE_AGORA_MS), { status: 'deferred' });
    const conta = unica(await rodar(c));
    expect(conta.comFalhaHoje).toBe(0);
    expect(conta.enfileiradas).toEqual({ ausente: 1, relogio: 0, divergente: 0, invariante: 0 });
    // The SAME id as the row it ignored — a second failure is an ALREADY_EXISTS
    // no-op, so the one-row-per-day bound does not rest on the skip.
    expect(`${NOTIFICACAO_PATH}/${docIdOf(enfileirado(c, 0)) ?? ''}`).toBe(
      caminhoDaFalha(DEVOLUCAO, DIA_DE_AGORA_MS),
    );
    esperarParticao(conta);
  });

  it.each<[string, Record<string, unknown>]>([
    ['`failed` (a faixa transitória)', { status: 'failed' }],
    ['um status que o módulo não conhece', { status: 'pendente' }],
    ['sem status', {}],
  ])(
    'a linha de HOJE %s, pedido ausente ⇒ reenfileirada, e o pedido NÃO é lido',
    async (_caso, linhaDeFalha) => {
      const c = cenario(pagina([linhaWire(DEVOLUCAO)]));
      semearConta(c, INT_A);
      c.db.seed(caminhoDaFalha(DEVOLUCAO, DIA_DE_AGORA_MS), linhaDeFalha);
      const conta = unica(await rodar(c));
      expect(conta.comFalhaHoje).toBe(0);
      expect(conta.enfileiradas.ausente).toBe(1);
      // Only a `deferred` row pays the pedido read.
      expect(leiturasDoPedido(c)).toHaveLength(0);
      esperarParticao(conta);
    },
  );

  it('o id lido é o docIdOf do PRÓPRIO sintético enfileirável', async () => {
    const c = cenario(pagina([linhaWire(DEVOLUCAO)]));
    semearConta(c, INT_A);
    await rodar(c);
    expect(`${NOTIFICACAO_PATH}/${docIdOf(enfileirado(c, 0)) ?? ''}`).toBe(
      caminhoDaFalha(DEVOLUCAO, DIA_DE_AGORA_MS),
    );
  });

  it.each([
    ['de ONTEM', DIA_DE_AGORA_MS - DIA_MS],
    ['carimbada com o relógio do tick', AGORA_MS],
  ])('⛔ QUASE-FALHA: uma linha de falha %s não segura a devolução', async (_caso, carimbo) => {
    const c = cenario(pagina([linhaWire(DEVOLUCAO)]));
    semearConta(c, INT_A);
    c.db.seed(caminhoDaFalha(DEVOLUCAO, carimbo), { status: 'parked' });
    expect(unica(await rodar(c)).enfileiradas.ausente).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*     o dia não fica sequestrado — o braço, o pipeline e o importador REAIS    */
/* -------------------------------------------------------------------------- */

describe('a devolução adiada às 00:40 sem pedido é importada no tick das 06:35, não amanhã', () => {
  const T_0040 = DIA_DE_AGORA_MS + 40 * 60_000;
  const T_0635 = DIA_DE_AGORA_MS + (6 * 60 + 35) * 60_000;
  const T_1235 = DIA_DE_AGORA_MS + (12 * 60 + 35) * 60_000;
  /** The return last changed the evening BEFORE — inside every tick's window. */
  const U_S = DIA_DE_AGORA_MS / 1000 - 3_600;

  function linha(): Record<string, unknown> {
    return linhaWire(DEVOLUCAO, { update_time: U_S, create_time: U_S - 3_600 });
  }

  /**
   * The REAL code-29 arm's deps: only the Shopee detail and the code-3 queue
   * are stubbed — the importer, its transaction and its aviso are the real ones.
   */
  function depsDoBraco(nowMs: number, codes3: ShopeeNotificationPayload[]): ShopeeProcessDeps {
    return {
      partnerClient: () => {
        throw new Error('cliente de parceiro inesperado');
      },
      increment,
      nowMs: () => nowMs,
      importarDevolucao: (db, alvo) =>
        importarDevolucaoShopee(db, alvo, {
          clientFor: () =>
            Promise.resolve({
              getReturnDetail: () =>
                Promise.resolve(
                  shopeeReturnDetailSchema.parse({
                    error: '-',
                    message: '-',
                    response: detalheDaLinha(linha()),
                  }),
                ),
            }),
          scheduler: {
            enqueue: (s) => {
              codes3.push(s);
              return Promise.resolve();
            },
          },
          aviso: { increment, nowMs },
        }),
    };
  }

  /** One delivery through the REAL `handleNotificationTask` (the pipeline's row writes included). */
  function entregar(
    c: Cenario,
    p: ShopeeNotificationPayload,
    nowMs: number,
    codes3: ShopeeNotificationPayload[],
  ): Promise<TaskResult> {
    return handleNotificationTask(asDb(c.db), structuredClone(p), 0, depsDoBraco(nowMs, codes3));
  }

  beforeEach(() => {
    // The arm resolves the shop through the cached reader; each test seeds its own db.
    __resetAllReadCaches();
  });

  it('adiada às 00:40, pedido criado às 00:41 ⇒ o tick das 06:35 reimporta; o das 12:35 já a acha em dia', async () => {
    const c = cenario(pagina([linha()]), pagina([linha()]), pagina([linha()]));
    semearConta(c, INT_A);
    const codes3: ShopeeNotificationPayload[] = [];

    // 00:40 — first seen by the poller (its push was lost or late): absent.
    expect(unica(await rodar(c, { nowMs: T_0040 })).enfileiradas.ausente).toBe(1);
    const primeiro = enfileirado(c, 0);
    // The arm defers — no pedido yet — and enqueues ONE synthetic code 3.
    expect((await entregar(c, primeiro, T_0040, codes3)).outcome).toBe('deferred');
    expect(codes3.map((p) => p.code)).toEqual([3]);
    expect(c.db.store[caminhoDaFalha(DEVOLUCAO, DIA_DE_AGORA_MS)]?.data.status).toBe('deferred');

    // 00:41 — that code 3 creates the pedido.
    c.db.seed(`${PEDIDO_PATH}/${pedidoIdDe()}`, { numero: ORDER_SN });

    // 06:35 — today's row still STANDS, but no longer holds the return.
    const seisHoras = unica(await rodar(c, { nowMs: T_0635 }));
    expect(seisHoras.comFalhaHoje).toBe(0);
    expect(seisHoras.enfileiradas.ausente).toBe(1);
    const segundo = enfileirado(c, 1);
    expect(docIdOf(segundo)).toBe(docIdOf(primeiro));
    const importada = await entregar(c, segundo, T_0635, codes3);
    expect(importada).toMatchObject({ outcome: 'done', acaoDevolucao: 'criado' });
    expect(c.db.store[caminhoDoIncidente(DEVOLUCAO)]).toBeDefined();
    expect(codes3).toHaveLength(1); // no second code 3: the pedido exists

    // 12:35 — the incidente reflects the row: nothing to enqueue, nothing skipped.
    const dozeHoras = unica(await rodar(c, { nowMs: T_1235 }));
    expect(dozeHoras).toMatchObject({ jaAtualizadas: 1, comFalhaHoje: 0 });
    expect(c.enqueue).toHaveBeenCalledTimes(2);

    // The stale deferred row is its OWN lane's: the next daily pass re-drives
    // it, the import is already in place, and the row is removed.
    const caminhoDaLinha = caminhoDaFalha(DEVOLUCAO, DIA_DE_AGORA_MS);
    expect(c.db.store[caminhoDaLinha]).toBeDefined();
    const diaria = await reprocessDeferredNotifications(
      asDb(c.db),
      // `processedAt` is the pipeline's own wall clock, so the lane's window is too.
      { now: Date.now() + DIA_MS + 60_000 },
      depsDoBraco(T_1235 + DIA_MS, codes3),
    );
    expect(diaria.processed).toBe(1);
    expect(c.db.store[caminhoDaLinha]).toBeUndefined();
    expect(codes3).toHaveLength(1);
  });

  it('⛔ QUASE-FALHA: o pedido AINDA ausente às 06:35 ⇒ a linha adiada segura a devolução — nem code 29, nem code 3 a mais', async () => {
    const c = cenario(pagina([linha()]), pagina([linha()]));
    semearConta(c, INT_A);
    const codes3: ShopeeNotificationPayload[] = [];

    await rodar(c, { nowMs: T_0040 });
    expect((await entregar(c, enfileirado(c, 0), T_0040, codes3)).outcome).toBe('deferred');

    const seisHoras = unica(await rodar(c, { nowMs: T_0635 }));
    expect(seisHoras.comFalhaHoje).toBe(1);
    expect(totalEnfileiradas(seisHoras)).toBe(0);
    expect(c.enqueue).toHaveBeenCalledTimes(1);
    expect(codes3).toHaveLength(1);
    expect(c.db.store[caminhoDoIncidente(DEVOLUCAO)]).toBeUndefined();
  });
});

describe(`o teto de ${String(MAX_ENFILEIRADOS_DEVOLUCOES_POR_CONTA)} enfileiramentos por conta`, () => {
  it('o 201º candidato é alemDoLimite, a conta é truncada, e NENHUMA página a mais é lida', async () => {
    const lote = (de: number): Record<string, unknown>[] =>
      Array.from({ length: 100 }, (_, i) => linhaWire(devolucaoN(de + i)));
    const c = cenario(
      pagina(lote(1), true),
      pagina(lote(101), true),
      pagina([linhaWire(devolucaoN(201))], true),
      pagina([linhaWire(devolucaoN(202))], false),
    );
    semearConta(c, INT_A);
    const conta = unica(await rodar(c));
    expect(c.enqueue).toHaveBeenCalledTimes(MAX_ENFILEIRADOS_DEVOLUCOES_POR_CONTA);
    expect(conta.alemDoLimite).toBe(1);
    expect(conta.truncada).toBe(true);
    expect(c.lista).toHaveBeenCalledTimes(3);
    // The failure-row read is skipped past the cap: 200 reads, not 201.
    const leiturasDeFalha = c.db.opLog.filter(
      (o) => o.op === 'get' && o.path.startsWith(`${NOTIFICACAO_PATH}/`),
    );
    expect(leiturasDeFalha).toHaveLength(MAX_ENFILEIRADOS_DEVOLUCOES_POR_CONTA);
    esperarParticao(conta);
  });

  it('⛔ QUASE-FALHA: EXATAMENTE o teto de candidatos enche a conta SEM truncá-la', async () => {
    const lote = (de: number): Record<string, unknown>[] =>
      Array.from({ length: 100 }, (_, i) => linhaWire(devolucaoN(de + i)));
    const c = cenario(pagina(lote(1), true), pagina(lote(101), false));
    semearConta(c, INT_A);
    const conta = unica(await rodar(c));
    expect(totalEnfileiradas(conta)).toBe(MAX_ENFILEIRADOS_DEVOLUCOES_POR_CONTA);
    expect(conta.truncada).toBe(false);
    expect(conta.alemDoLimite).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*                                a contenção                                  */
/* -------------------------------------------------------------------------- */

describe('contenção por conta — o limite PRIMEIRO, ShopeeConfigError relança', () => {
  function duasContas(): Cenario {
    const c = cenario();
    semearConta(c, INT_A, SHOP_A);
    semearConta(c, INT_B, SHOP_B);
    return c;
  }

  it.each(['burst', 'daily'] as const)(
    'um limite %s na conta A ABORTA o tick: B nem tem cliente construído',
    async (kind) => {
      const c = duasContas();
      c.clientPor.set(INT_A, { getReturnList: () => Promise.reject(limite(kind)) });
      const clientFor = vi.fn((_db: Firestore, id: string) =>
        Promise.resolve(c.clientPor.get(id) ?? c.client),
      );
      const r = await rodar(c, { clientFor });
      expect(r.interrompidoPorLimite).toBe(kind);
      expect(r.contas.map((x) => x.integracaoId)).toEqual([INT_A]);
      expect(r.contas[0]?.error).toBe(
        `ShopeeRateLimitError: ${kind === 'burst' ? 'error_rate_limit' : 'error_limit'}`,
      );
      expect(clientFor.mock.calls.map(([, id]) => id)).toEqual([INT_A]);
    },
  );

  it('⛔ QUASE-FALHA: um ShopeeApiError comum na conta A é CONTIDO — B ainda é varrida, sem o texto da Shopee', async () => {
    const c = duasContas();
    c.clientPor.set(INT_A, { getReturnList: () => Promise.reject(apiError('error_param')) });
    const r = await rodar(c);
    expect(r.interrompidoPorLimite).toBeNull();
    expect(r.contas.map((x) => [x.integracaoId, x.error])).toEqual([
      [INT_A, 'ShopeeApiError: error_param'],
      [INT_B, null],
    ]);
    expect(JSON.stringify(c.logs)).not.toContain(DEVOLUCAO);
  });

  // ⚠️ The code is Shopee's text too: it reaches the result and the log only
  // through `codigoSeguro`, the ONE gate (`nfe/redacaoNfe.ts`).
  it.each<[string, string, string]>([
    ['aparado (o PAR: o mesmo token)', ' error_param\t', 'ShopeeApiError: error_param'],
    [
      'com sete dígitos (um identificador, nunca um código)',
      'error_2609100',
      'ShopeeApiError: (não é um código)',
    ],
    ['uma frase', 'Service is temporarily not available', 'ShopeeApiError: (não é um código)'],
  ])(
    'o código de um ShopeeApiError contido passa pelo codigoSeguro — %s',
    async (_caso, codigo, descricao) => {
      const c = duasContas();
      c.clientPor.set(INT_A, { getReturnList: () => Promise.reject(apiError(codigo)) });
      const r = await rodar(c);
      expect(r.contas[0]?.error).toBe(descricao);
      expect(c.logs.map((l) => (l.meta as { erro?: unknown } | undefined)?.erro)).toContain(
        descricao,
      );
      // ⛔ QUASE-FALHA: the raw code — untrimmed, or the refused one — never.
      const texto = JSON.stringify([r, c.logs]);
      expect(texto).not.toContain(JSON.stringify(codigo).slice(1, -1));
    },
  );

  it('ShopeeConfigError RELANÇA — é nossa, e o tick tem de falhar alto', async () => {
    const c = duasContas();
    c.clientPor.set(INT_A, {
      getReturnList: () => Promise.reject(new ShopeeConfigError('SHOPEE_PARTNER_KEY ausente')),
    });
    await expect(rodar(c)).rejects.toBeInstanceOf(ShopeeConfigError);
  });

  it('um erro que não é de família nenhuma RELANÇA (regra 6)', async () => {
    const c = duasContas();
    c.clientPor.set(INT_A, { getReturnList: () => Promise.reject(new TypeError('bug')) });
    await expect(rodar(c)).rejects.toBeInstanceOf(TypeError);
  });

  // ⚠️ The REAL enqueue failures: the SDK's classes and STRING codes, which the
  // shared gRPC check does not recognise. They reach the fake through
  // `rejeicaoDoTransporte`, the SAME classifier the real scheduler runs (#1759):
  // a raw SDK class rejected by the fake would stand in for a scheduler
  // production never builds.
  it.each<[string, () => Error, string]>([
    [
      'functions/unknown-error (503/429 do Cloud Tasks)',
      () => falhaDoFunctions('unknown-error'),
      'FirebaseFunctionsError functions/unknown-error, HTTP 503',
    ],
    [
      'functions/internal-error',
      () => falhaDoFunctions('internal-error', 500),
      'FirebaseFunctionsError functions/internal-error, HTTP 500',
    ],
    [
      'functions/aborted',
      () => falhaDoFunctions('aborted', 409),
      'FirebaseFunctionsError functions/aborted, HTTP 409',
    ],
    [
      'app/network-error',
      () => falhaDoApp(AppErrorCode.NETWORK_ERROR),
      'FirebaseAppError app/network-error',
    ],
    [
      'app/network-timeout',
      () => falhaDoApp(AppErrorCode.NETWORK_TIMEOUT),
      'FirebaseAppError app/network-timeout',
    ],
  ])(
    'um enqueue TRANSITÓRIO (%s) é contido na conta, descrito pela classe compartilhada — nunca pela mensagem do SDK',
    async (_codigo, falha, detalhe) => {
      const c = cenario(pagina([linhaWire(DEVOLUCAO)]));
      semearConta(c, INT_A, SHOP_A);
      semearConta(c, INT_B, SHOP_B);
      const erro = falha();
      // ÂNCORA: the SDK's own message DOES leak — so its absence below is the description's doing.
      expect(erro.message).toContain(CORPO_DA_RESPOSTA_DO_TASKS);
      c.enqueue.mockImplementationOnce(() => rejeicaoDoTransporte(erro));
      const r = await rodar(c);
      expect(r.contas.map((x) => [x.integracaoId, x.error])).toEqual([
        [
          INT_A,
          `ShopeeTasksTransientError: enqueue no Cloud Tasks falhou de forma transitória (${detalhe})`,
        ],
        [INT_B, null],
      ]);
      // The failed enqueue is not counted as one.
      expect(c.enqueue).toHaveBeenCalledTimes(1);
      expect(r.contas[0]?.enfileiradas).toEqual({
        ausente: 0,
        relogio: 0,
        divergente: 0,
        invariante: 0,
      });
      const texto = JSON.stringify([r, c.logs]);
      for (const segredo of [CORPO_DA_RESPOSTA_DO_TASKS, ORDER_SN, DEVOLUCAO]) {
        expect(texto).not.toContain(segredo);
      }
    },
  );

  // ⚠️ The near-misses: the same two CLASSES carrying a deploy-shaped code (the
  // real classifier hands them back RAW), the transient code on a look-alike
  // that is not the class, and the class raised somewhere OTHER than the
  // enqueue — each fails the tick as the very object thrown, and B is never
  // walked.
  it.each<[string, () => Error, 'lista' | 'transporte']>([
    [
      'functions/permission-denied (falta o IAM)',
      () => falhaDoFunctions('permission-denied', 403),
      'transporte',
    ],
    [
      'functions/not-found (sem fila nessa região)',
      () => falhaDoFunctions('not-found', 404),
      'transporte',
    ],
    ['app/invalid-credential', () => falhaDoApp(AppErrorCode.INVALID_CREDENTIAL), 'transporte'],
    [
      'um Error comum com o MESMO código (a forma, não a classe)',
      () => Object.assign(new Error('503'), { code: 'functions/unknown-error' }),
      'transporte',
    ],
    [
      'app/network-error FORA do enqueue (na listagem)',
      () => falhaDoApp(AppErrorCode.NETWORK_ERROR),
      'lista',
    ],
    [
      'functions/unknown-error FORA do enqueue (na listagem)',
      () => falhaDoFunctions('unknown-error'),
      'lista',
    ],
  ])('⛔ %s RELANÇA — o tick falha e B nunca é varrida', async (_t, falha, onde) => {
    const c = cenario(pagina([linhaWire(DEVOLUCAO)]));
    semearConta(c, INT_A, SHOP_A);
    semearConta(c, INT_B, SHOP_B);
    const lancado = falha();
    if (onde === 'lista') {
      c.clientPor.set(INT_A, { getReturnList: () => Promise.reject(lancado) });
    } else {
      c.enqueue.mockImplementationOnce(() => rejeicaoDoTransporte(lancado));
    }
    const clientFor = vi.fn((_db: Firestore, id: string) =>
      Promise.resolve(c.clientPor.get(id) ?? c.client),
    );
    await expect(rodar(c, { clientFor })).rejects.toBe(lancado);
    expect(clientFor.mock.calls.map(([, id]) => id)).toEqual([INT_A]);
  });

  it('ShopeeTasksDisabledError no meio do tick (a válvula virou) é contido por conta', async () => {
    const c = cenario(pagina([linhaWire(DEVOLUCAO)]));
    semearConta(c, INT_A);
    c.enqueue.mockImplementationOnce(() => Promise.reject(new ShopeeTasksDisabledError()));
    expect(unica(await rodar(c)).error).toBe(
      'ShopeeTasksDisabledError: ' + new ShopeeTasksDisabledError().message,
    );
  });
});

describe('contas', () => {
  it('uma conta sem shop_id é CONTADA, nunca chamada, e fica fora de `contas`', async () => {
    const c = cenario();
    semearConta(c, INT_SEM_SHOP, null);
    semearConta(c, INT_A);
    const clientFor = vi.fn((_db: Firestore, _id: string) => Promise.resolve(c.client));
    const r = await rodar(c, { clientFor });
    expect(r.semShopId).toBe(1);
    expect(r.contas.map((x) => x.integracaoId)).toEqual([INT_A]);
    expect(clientFor.mock.calls.map(([, id]) => id)).toEqual([INT_A]);
  });

  it('sem `clientFor`, o cliente é o do contexto da conta (`loadShopeeContext(db, id).createShopClient()`)', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    const createShopClient = vi.fn(() => c.client);
    h.loadCtx.mockResolvedValue({ createShopClient });
    await runShopeeDevolucoesSweep(asDb(c.db), {
      scheduler: { enqueue: c.enqueue },
      nowMs: AGORA_MS,
      env: envInjetado(),
    });
    expect(h.loadCtx).toHaveBeenCalledWith(asDb(c.db), INT_A);
    expect(createShopClient).toHaveBeenCalledTimes(1);
    expect(c.lista).toHaveBeenCalledTimes(1);
  });

  it('o shop_id do sintético é o da CONTA varrida', async () => {
    const c = cenario();
    semearConta(c, INT_B, SHOP_B);
    c.clientPor.set(INT_B, {
      getReturnList: () => Promise.resolve(pagina([linhaWire(DEVOLUCAO)])),
    });
    await rodar(c);
    expect(enfileirado(c, 0).shopId).toBe(SHOP_B);
  });
});

/* -------------------------------------------------------------------------- */
/*                       nada escrito, nada vazado                             */
/* -------------------------------------------------------------------------- */

describe('o sweep NÃO escreve e NÃO vaza', () => {
  it('um tick com todos os motivos e uma falha de hoje: ZERO escritas, só leituras', async () => {
    const c = cenario(
      pagina([
        linhaWire(DEVOLUCAO),
        linhaWire(DEVOLUCAO_2, { update_time: T_S + 1 }),
        linhaWire(devolucaoN(3)),
        null,
      ]),
    );
    semearConta(c, INT_A);
    await importadaComo(c, linhaWire(DEVOLUCAO_2));
    // `parked`: a row that still HOLDS the return (a `failed` one is re-enqueued).
    c.db.seed(caminhoDaFalha(devolucaoN(3), DIA_DE_AGORA_MS), { status: 'parked' });
    const escritasAntes = c.db.writes.length;
    const conta = unica(await rodar(c));
    expect(c.db.writes).toHaveLength(escritasAntes);
    expect(conta).toMatchObject({
      linhasIlegiveis: 1,
      comFalhaHoje: 1,
      enfileiradas: { ausente: 1, relogio: 1, divergente: 0, invariante: 0 },
    });
    esperarParticao(conta);
  });

  it('o resultado e cada linha de log levam ids de CONTA e contagens — nunca order_sn nem return_sn', async () => {
    const c = cenario(
      pagina([linhaWire(DEVOLUCAO), linhaWire(DEVOLUCAO, {}), linhaWire('260910-RUIM')], true),
    );
    semearConta(c, INT_A);
    const r = await rodar(c);
    const serializado = JSON.stringify([r, c.logs]);
    // ÂNCORA: there WERE log lines (ambiguity + illegible rows).
    expect(c.logs.length).toBeGreaterThanOrEqual(2);
    for (const proibido of [ORDER_SN, DEVOLUCAO, '260910-RUIM', pedidoIdDe()]) {
      expect(serializado).not.toContain(proibido);
    }
  });

  it('⚠️ o módulo não converte unidade nenhuma nem abre bloco atômico (R-10, regra 7 tier 0) — texto cru', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('./devolucoesSweep.ts', import.meta.url)),
      'utf8',
    );
    for (const proibido of [
      'millisToMicros',
      'coerceToMicros',
      'microsDeSegundosShopee',
      'runTransaction',
      'Date.now',
    ]) {
      expect(fonte, proibido).not.toContain(proibido);
    }
    // ÂNCORA: the file really was read.
    expect(fonte).toContain('export async function runShopeeDevolucoesSweep(');
  });
});

/* -------------------------------------------------------------------------- */
/*                       RT-6 — a ida e a volta pelo importador                 */
/* -------------------------------------------------------------------------- */

describe('RT-6 — o corpo `get_return_list.doc.json` → o sweep → o importador REAL → o sweep de novo', () => {
  /** The corpus row, RAW (the schema STRIPS what the app does not read). */
  function linhaDoCorpus(): Record<string, unknown> {
    const bruto = lerFixture(FIXTURE_RETURN_LIST_DOC) as {
      response: { return: Record<string, unknown>[] };
    };
    const linha = bruto.response.return[0];
    if (linha === undefined) throw new Error('o corpo não tem linha');
    return linha;
  }

  /** The corpus page, with `more` forced false so the walk ends on it. */
  function paginaDoCorpus(): ShopeeReturnListEnvelope {
    const env = lerListaDeDevolucoes(FIXTURE_RETURN_LIST_DOC);
    return { ...env, response: { ...env.response, more: false } };
  }

  it('ausente ⇒ UM code 29 do dia; o importador o consome e grava; o próximo tick do MESMO dia não enfileira nada', async () => {
    const c = cenario(paginaDoCorpus(), paginaDoCorpus());
    semearConta(c, INT_A);
    const pedidoId = pedidoIdDe();
    c.db.seed(`${PEDIDO_PATH}/${pedidoId}`, { numero: ORDER_SN });
    const linha = linhaDoCorpus();
    const returnSn = String(linha.return_sn);

    // Tick 1 — absent.
    const primeiro = unica(await rodar(c));
    expect(primeiro.enfileiradas.ausente).toBe(1);
    expect(c.enqueue).toHaveBeenCalledTimes(1);
    expect(enfileirado(c, 0).timestamp).toBe(DIA_DE_AGORA_MS);
    expect(c.db.writes).toHaveLength(0);

    // The arm's parser + the REAL importer consume the enqueued pointer.
    const alvo = alvoDoPushDeDevolucao(enfileirado(c, 0).data ?? {});
    if (!alvo.ok) throw new Error(`o braço recusou o sintético: ${alvo.motivo}`);
    const getReturnDetail = vi.fn(() =>
      Promise.resolve(
        shopeeReturnDetailSchema.parse({
          error: '-',
          message: '-',
          response: detalheDaLinha(linha),
        }),
      ),
    );
    const importado = await importarDevolucaoShopee(
      asDb(c.db),
      {
        integracaoId: INT_A,
        shopId: SHOP_A,
        orderSn: alvo.orderSn,
        returnSn: alvo.returnSn,
        nowMs: AGORA_MS,
        origem: alvo.origem,
        diario: alvo.diario,
      },
      {
        clientFor: () => Promise.resolve({ getReturnDetail }),
        scheduler: { enqueue: () => Promise.reject(new Error('code 3 inesperado')) },
        aviso: { increment, nowMs: AGORA_MS },
      },
    );
    expect(importado.acao).toBe('criado');
    expect(getReturnDetail).toHaveBeenCalledWith({ returnSn });
    expect(c.db.store[caminhoDoIncidente(returnSn)]).toBeDefined();

    // Tick 2, the same day — the list projection now equals the mapped block.
    const segundo = unica(await rodar(c));
    expect(segundo.jaAtualizadas).toBe(1);
    expect(totalEnfileiradas(segundo)).toBe(0);
    expect(c.enqueue).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalled();
  });

  it('a linha ADIADA de HOJE para a devolução do corpo, pedido ausente ⇒ comFalhaHoje, nada enfileirado', async () => {
    const c = cenario(paginaDoCorpus());
    semearConta(c, INT_A);
    c.db.seed(caminhoDaFalha(String(linhaDoCorpus().return_sn), DIA_DE_AGORA_MS), {
      status: 'deferred',
    });
    const conta = unica(await rodar(c));
    expect(conta.comFalhaHoje).toBe(1);
    expect(c.enqueue).not.toHaveBeenCalled();
  });

  it('o corpo, com o `more: true` da própria amostra e um stub que repete a página, é AMBÍGUO e para', async () => {
    const env = lerListaDeDevolucoes(FIXTURE_RETURN_LIST_DOC);
    expect(env.response.more).toBe(true); // ÂNCORA: the doc sample really says more.
    const c = cenario(env, env, env);
    semearConta(c, INT_A);
    const conta = unica(await rodar(c));
    expect(c.lista).toHaveBeenCalledTimes(2);
    expect(conta.paginacaoAmbigua).toBe(true);
    expect(c.enqueue).toHaveBeenCalledTimes(1);
  });
});
