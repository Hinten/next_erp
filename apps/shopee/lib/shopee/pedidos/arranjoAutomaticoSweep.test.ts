import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi, type Mock } from 'vitest';
import { AppErrorCode, FirebaseAppError } from 'firebase-admin/app';
import type { Firestore } from 'firebase-admin/firestore';
import { FirebaseFunctionsError } from 'firebase-admin/functions';
import {
  credenciaisIntegracaoCollection,
  integracaoCollection,
  notificacaoShopeeCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  assertSearchPackageListParams,
  createShopeeClient,
  resolveShopeeHosts,
  shopeePackageDetailPayloadSchema,
  shopeeSearchPackageListPayloadSchema,
  type GetPackageDetailParams,
  type SearchPackageListParams,
  type ShopeeClient,
  type ShopeePackageDetail,
  type ShopeeSearchPackageList,
} from '@delfrance/integrations-shopee';

import { SHOPEE_CREDENCIAL_DOC_ID } from '../core/credentialStore';
import { CANAIS_ARRANJO_AUTOMATICO, type FasePacote } from '../etiqueta/faseEtiqueta';
import {
  FIXTURE_SEARCH_PACKAGE_LIST_DOC,
  FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_TURBO,
  lerBuscaDePacotes,
  lerFixture,
} from '../fixtures/wireCorpus';
import { dedupKeyOf, docIdOf, type ShopeeNotificationPayload } from '../notificacoes/notificacao';
import { ShopeeTasksDisabledError, type ShopeeTaskScheduler } from '../shopeeTasks';
import { FakeDb, asDb, grpc } from '../testing/fakeDb';
import { SHOPEE_ARRANJO_AUTOMATICO_DISABLED_ENV } from './arranjoAutomatico';
import {
  MAX_ENFILEIRADOS_ARRANJO_POR_CONTA,
  MAX_PAGINAS_ARRANJO_POR_CONTA,
  MOTIVO_ARRANJO_DESLIGADO,
  MOTIVO_SWEEP_DESLIGADO,
  MOTIVO_TASKS_DESABILITADO,
  PRAZO_DO_TICK_ARRANJO_MS,
  SHOPEE_ARRANJO_SWEEP_DISABLED_ENV,
  TRUNCAGEM_ARRANJO,
  arranjoSweepDesligado,
  runShopeeArranjoAutomaticoSweep,
  type ArranjoAutomaticoContaResult,
  type ArranjoAutomaticoSweepDeps,
  type ArranjoAutomaticoSweepResult,
} from './arranjoAutomaticoSweep';
import { makePedidoIdShopee } from './orderIds';

/* -------------------------------------------------------------------------- */
/*  `loadShopeeContext` is replaced ONLY so the default client seam (no        */
/*  `clientFor`) can be observed; every error class stays the REAL one.        */
/* -------------------------------------------------------------------------- */

const h = vi.hoisted(() => ({ loadCtx: vi.fn() }));

vi.mock('../core/shopee', async (importActual) => {
  const actual = await importActual<typeof import('../core/shopee')>();
  return { ...actual, loadShopeeContext: h.loadCtx };
});

/* -------------------------------------------------------------------------- */
/*  Fixtures — fixture ids only. No real partner, shop, order or package.      */
/* -------------------------------------------------------------------------- */

const AGORA_MS = 1_767_000_000_000;
/** The START of AGORA_MS's UTC day (AGORA_MS is 9 h 20 min into it) — the code 3's stamp. */
const DIA_DE_AGORA_MS = 1_766_966_400_000;
const DIA_MS = 86_400_000;
const INTEGRACAO_PATH = integracaoCollection.resolvePath({});
const PEDIDO_PATH = pedidoCollection.resolvePath({});
const NOTIFICACAO_PATH = notificacaoShopeeCollection.resolvePath({});
const INT_A = 'int-1';
const INT_B = 'int-2';
const INT_C = 'int-3';
const INT_SEM_SHOP = 'int-sem-shop';
const SHOP_A = 987654;
const SHOP_B = 987655;
const SHOP_C = 987656;
const ORDER_SN = '260910KJBHUJDM';
const ORDER_SN_2 = '260910SEGUNDO';
const PACOTE = 'OFG000000000001';
const PACOTE_2 = 'OFG000000000002';
/** 1573's first channel. */
const CANAL_TURBO = 90011;
/** A Seller-Logistics channel 1573 does NOT oblige — the near-miss. */
const CANAL_FORA = 90021;
const TASKS_DISABLED_ENV = 'SHOPEE_TASKS_DISABLED';

const FASES_ZERO: Record<FasePacote, number> = {
  'nfe-pendente': 0,
  'nao-pronto': 0,
  retido: 0,
  programar: 0,
  arranjado: 0,
  'janela-fechada': 0,
  inelegivel: 0,
  desconhecido: 0,
};

/** A synthetic package number, fixture-shaped (`OFG` + 12 digits). */
function pacoteN(n: number): string {
  return `OFG${String(n).padStart(12, '0')}`;
}

type BuscaMock = Mock<(p: SearchPackageListParams) => Promise<ShopeeSearchPackageList>>;
type DetalheMock = Mock<(p: GetPackageDetailParams) => Promise<ShopeePackageDetail>>;
type EnqueueMock = Mock<(p: ShopeeNotificationPayload) => Promise<void>>;

interface Log {
  readonly msg: string;
  readonly meta: unknown;
}

interface Cenario {
  readonly db: FakeDb;
  readonly busca: BuscaMock;
  readonly detalhe: DetalheMock;
  readonly enqueue: EnqueueMock;
  /** Shopee's truth per package — what `get_package_detail` answers, RAW wire. */
  readonly pacotes: Map<string, Record<string, unknown>>;
  readonly client: ShopeeClient;
  /** Per-conta client override. */
  readonly clientPor: Map<string, ShopeeClient>;
  readonly logs: Log[];
}

/** One search page, RAW wire through the REAL payload schema. */
function pagina(
  linhas: readonly unknown[],
  paginacao: Record<string, unknown> = { total_count: linhas.length, more: false, next_cursor: '' },
): ShopeeSearchPackageList {
  return shopeeSearchPackageListPayloadSchema.parse({
    packages_list: linhas,
    pagination: paginacao,
  });
}

/** A page with NO `pagination` key at all. */
function paginaSemPaginacao(linhas: readonly unknown[]): ShopeeSearchPackageList {
  return shopeeSearchPackageListPayloadSchema.parse({ packages_list: linhas });
}

/** One search row as the SG wire sends it (all six keys). */
function linhaBusca(numero: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_sn: ORDER_SN,
    package_number: numero,
    logistics_channel_id: CANAL_TURBO,
    product_location_id: 'SGZ',
    sorting_group: '',
    is_shipment_arranged: false,
    ...over,
  };
}

/** Put a package in Shopee's truth: READY, not arranged, invoice valid, Turbo. */
function naShopee(c: Cenario, numero: string, over: Record<string, unknown> = {}): void {
  c.pacotes.set(numero, {
    order_sn: ORDER_SN,
    package_number: numero,
    fulfillment_status: 'LOGISTICS_READY',
    logistics_channel_id: CANAL_TURBO,
    is_shipment_arranged: false,
    pending_terms: [],
    invoice_pending: { status: 'valid', pending_reason: '' },
    ...over,
  });
}

function cenario(): Cenario {
  const db = new FakeDb();
  const pacotes = new Map<string, Record<string, unknown>>();
  const busca: BuscaMock = vi.fn<(p: SearchPackageListParams) => Promise<ShopeeSearchPackageList>>(
    () => Promise.resolve(pagina([], { total_count: 0, more: false, next_cursor: '' })),
  );
  const detalhe: DetalheMock = vi.fn<(p: GetPackageDetailParams) => Promise<ShopeePackageDetail>>(
    (p) =>
      Promise.resolve(
        shopeePackageDetailPayloadSchema.parse({
          package_list: p.packageNumbers.filter((n) => pacotes.has(n)).map((n) => pacotes.get(n)),
        }),
      ),
  );
  const enqueue: EnqueueMock = vi.fn<(p: ShopeeNotificationPayload) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const client = { searchPackageList: busca, getPackageDetail: detalhe } as unknown as ShopeeClient;
  return { db, busca, detalhe, enqueue, pacotes, client, clientPor: new Map(), logs: [] };
}

function semearConta(c: Cenario, integracaoId: string, shopId: number | null = SHOP_A): void {
  c.db.seed(`${INTEGRACAO_PATH}/${integracaoId}`, {
    tipo: INTEGRACAO_TIPO.shopee,
    ativo: true,
    nome: 'Loja BR',
    ...(shopId === null ? {} : { shop_id: shopId }),
  });
}

function caminhoDoPedido(integracaoId: string, orderSn: string): string {
  return `${PEDIDO_PATH}/${makePedidoIdShopee(integracaoId, orderSn)}`;
}

function semearPedido(c: Cenario, integracaoId: string, orderSn: string): void {
  c.db.seed(caminhoDoPedido(integracaoId, orderSn), { numero: orderSn });
}

/** The conta's FIXED `current` credential document — where the token store stamps a dead refresh. */
function caminhoDaCredencial(integracaoId: string): string {
  return credenciaisIntegracaoCollection.docPath({ integracaoId }, SHOPEE_CREDENCIAL_DOC_ID);
}

/** A stored credential carrying `ultimaFalhaRefresh` exactly as given (fixture tokens only). */
function semearCredencial(c: Cenario, integracaoId: string, ultimaFalhaRefresh: unknown): void {
  c.db.seed(caminhoDaCredencial(integracaoId), {
    access_token: 'access-inventado',
    refresh_token: 'refresh-inventado',
    expirationDate: AGORA_MS - 1,
    provider: 'shopee',
    ultimaFalhaRefresh,
  });
}

/** The code-3 failure row the pipeline would have written for `orderSn` on the day starting at `diaMs`. */
function caminhoDaFalhaDoPedido(orderSn: string, diaMs: number, shopId = SHOP_A): string {
  return `${NOTIFICACAO_PATH}/3:${String(shopId)}:${orderSn}:${String(diaMs)}`;
}

/** `TaskQueue.enqueue`'s REAL HTTP failure (firebase-admin 14.2.0's `toFirebaseError`). */
function falhaDoFunctions(code: string): FirebaseFunctionsError {
  // ⚠️ The SDK's message may carry the response body — here it names the
  // package and the order, so a description built from it would leak both.
  return new FirebaseFunctionsError({
    code,
    message: `Unexpected response with status: 503 and body: ${PACOTE} ${ORDER_SN}`,
  });
}

/** `TaskQueue.enqueue`'s REAL socket failure (the SDK's HTTP client, after its own retries). */
function falhaDoApp(code: string): FirebaseAppError {
  return new FirebaseAppError({
    code,
    message: `Error while making request: socket hang up (${PACOTE}). Error code: ECONNRESET`,
  });
}

function rodar(
  c: Cenario,
  over: Partial<ArranjoAutomaticoSweepDeps> = {},
): Promise<ArranjoAutomaticoSweepResult> {
  const scheduler: ShopeeTaskScheduler = { enqueue: c.enqueue };
  return runShopeeArranjoAutomaticoSweep(asDb(c.db), {
    scheduler,
    nowMs: AGORA_MS,
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
function unica(r: ArranjoAutomaticoSweepResult): ArranjoAutomaticoContaResult {
  expect(r.contas).toHaveLength(1);
  const conta = r.contas[0];
  if (conta === undefined) throw new Error('nenhuma conta no resultado');
  return conta;
}

/** The `searchPackageList` params of call `n`; throws rather than read a call that never happened. */
function chamadaBusca(c: Cenario, n: number): SearchPackageListParams {
  const p = c.busca.mock.calls[n]?.[0];
  if (p === undefined)
    throw new Error(`searchPackageList não foi chamado ${String(n + 1)} vez(es)`);
  return p;
}

/** The package numbers of every `getPackageDetail` call, in order. */
function lotesDoDetalhe(c: Cenario): (readonly string[])[] {
  return c.detalhe.mock.calls.map(([p]) => p.packageNumbers);
}

function enfileirado(c: Cenario, n: number): ShopeeNotificationPayload {
  const p = c.enqueue.mock.calls[n]?.[0];
  if (p === undefined) throw new Error(`enqueue não foi chamado ${String(n + 1)} vez(es)`);
  return p;
}

/** Both counter partitions of `ArranjoAutomaticoContaResult`'s docblock. */
function esperarParticao(r: ArranjoAutomaticoContaResult): void {
  expect(r.linhas).toBe(
    r.ilegiveisNaBusca +
      r.duplicadas +
      r.jaArranjadosNaBusca +
      r.foraDoCanal +
      r.consultadosNoDetalhe +
      r.naoConsultadosPeloLimite,
  );
  const somaFases = Object.values(r.fases).reduce((t, n) => t + n, 0);
  expect(r.consultadosNoDetalhe).toBe(
    r.ausentesNoDetalhe + r.foraDoCanalNoDetalhe + r.canalDesconhecidoNoDetalhe + somaFases,
  );
  expect(r.nfePendenteNaBusca).toBe(r.fases['nfe-pendente']);
}

function apiError(code: string, extra: { providerMessage?: string } = {}): ShopeeApiError {
  const detalhe = extra.providerMessage === undefined ? '' : ` — ${extra.providerMessage}`;
  return new ShopeeApiError(`Shopee /api/v2/order/get_package_detail respondeu ${code}${detalhe}`, {
    code,
    kind: SHOPEE_ERROR_KIND.other,
    httpStatus: 200,
    path: '/api/v2/order/get_package_detail',
    ...(extra.providerMessage === undefined ? {} : { providerMessage: extra.providerMessage }),
  });
}

function limite(kind: 'burst' | 'daily'): ShopeeRateLimitError {
  return new ShopeeRateLimitError(`Shopee respondeu ${kind}`, {
    code: kind === 'burst' ? 'error_rate_limit' : 'error_limit',
    kind,
    httpStatus: 429,
    path: '/api/v2/order/search_package_list',
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

/**
 * A REAL `ShopeeClient` (the package's own guards, signing, envelope and
 * schemas) over a scripted transport that answers `respostas` in order and
 * records each call's path and body — parsed, and as the BYTES that went out.
 */
function clienteReal(respostas: unknown[]): {
  readonly client: ShopeeClient;
  readonly caminhos: string[];
  readonly corpos: unknown[];
  readonly corposBrutos: (string | null)[];
} {
  const fila = [...respostas];
  const caminhos: string[] = [];
  const corpos: unknown[] = [];
  const corposBrutos: (string | null)[] = [];
  const transporte = vi.fn<typeof globalThis.fetch>((entrada, init) => {
    const url =
      typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    caminhos.push(new URL(url).pathname);
    const bruto = typeof init?.body === 'string' ? init.body : null;
    corposBrutos.push(bruto);
    const corpo: unknown = bruto === null ? null : JSON.parse(bruto);
    corpos.push(corpo);
    return Promise.resolve(
      new Response(JSON.stringify(fila.shift()), {
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
    shopId: SHOP_A,
    getAccessToken: () => Promise.resolve('access-inventado'),
  });
  return { client, caminhos, corpos, corposBrutos };
}

/** A wire envelope around a payload, as Shopee sends a success. */
function envelope(response: unknown): Record<string, unknown> {
  return { error: '', message: '', response };
}

beforeEach(() => {
  // The ambient environment must not decide any test: all three valves UNSET.
  vi.stubEnv(SHOPEE_ARRANJO_SWEEP_DISABLED_ENV, undefined);
  vi.stubEnv(SHOPEE_ARRANJO_AUTOMATICO_DISABLED_ENV, undefined);
  vi.stubEnv(TASKS_DISABLED_ENV, undefined);
  h.loadCtx.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*                                  as válvulas                                */
/* -------------------------------------------------------------------------- */

describe('runShopeeArranjoAutomaticoSweep — as três válvulas', () => {
  it.each([
    [SHOPEE_ARRANJO_SWEEP_DISABLED_ENV, MOTIVO_SWEEP_DESLIGADO],
    [SHOPEE_ARRANJO_AUTOMATICO_DISABLED_ENV, MOTIVO_ARRANJO_DESLIGADO],
    [TASKS_DISABLED_ENV, MOTIVO_TASKS_DESABILITADO],
  ])(
    '%s="1" ⇒ enabled:false, motivo %s, e NADA é lido (nem Firestore, nem Shopee)',
    async (variavel, motivo) => {
      vi.stubEnv(variavel, '1');
      const clientFor = vi.fn(() => Promise.reject(new Error('cliente construído')));
      const enqueue = vi.fn(() => Promise.reject(new Error('enfileirou')));

      const r = await runShopeeArranjoAutomaticoSweep(dbQueExplode(), {
        scheduler: { enqueue },
        nowMs: AGORA_MS,
        clientFor,
        logger: {
          warn: () => {
            throw new Error('logou');
          },
        },
      });

      expect(r).toEqual({
        enabled: false,
        motivo,
        semShopId: 0,
        reconexaoPendente: 0,
        interrompidoPorLimite: null,
        interrompidoPorPrazo: false,
        contas: [],
      });
      expect(clientFor).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it('a ordem: a válvula do sweep vence a do arranjo, que vence a das tasks', async () => {
    vi.stubEnv(SHOPEE_ARRANJO_SWEEP_DISABLED_ENV, '1');
    vi.stubEnv(SHOPEE_ARRANJO_AUTOMATICO_DISABLED_ENV, '1');
    vi.stubEnv(TASKS_DISABLED_ENV, '1');
    const c = cenario();
    expect((await rodar(c)).motivo).toBe(MOTIVO_SWEEP_DESLIGADO);

    vi.stubEnv(SHOPEE_ARRANJO_SWEEP_DISABLED_ENV, undefined);
    expect((await rodar(c)).motivo).toBe(MOTIVO_ARRANJO_DESLIGADO);

    vi.stubEnv(SHOPEE_ARRANJO_AUTOMATICO_DISABLED_ENV, undefined);
    expect((await rodar(c)).motivo).toBe(MOTIVO_TASKS_DESABILITADO);
    expect(c.db.caminhos).toEqual([]);
  });

  // ⚠️ The near-misses: only the literal '1' turns a valve off (mutant 81 — a
  // `!== undefined` / truthy reader — answers OFF for every one of these).
  it.each(
    [
      SHOPEE_ARRANJO_SWEEP_DISABLED_ENV,
      SHOPEE_ARRANJO_AUTOMATICO_DISABLED_ENV,
      TASKS_DISABLED_ENV,
    ].flatMap((variavel) =>
      ['true', ' 1', '0', '', 'yes'].map((valor) => [variavel, valor] as const),
    ),
  )('%s=%j NÃO desliga: o tick roda', async (variavel, valor) => {
    vi.stubEnv(variavel, valor);
    const c = cenario();
    semearConta(c, INT_A);

    const r = await rodar(c);

    expect(r.enabled).toBe(true);
    expect(r.motivo).toBeNull();
    expect(c.busca).toHaveBeenCalledTimes(1);
  });

  it('arranjoSweepDesligado lê o env A CADA CHAMADA, nunca no carregamento do módulo', () => {
    expect(arranjoSweepDesligado()).toBe(false);
    vi.stubEnv(SHOPEE_ARRANJO_SWEEP_DISABLED_ENV, '1');
    expect(arranjoSweepDesligado()).toBe(true);
    vi.stubEnv(SHOPEE_ARRANJO_SWEEP_DISABLED_ENV, 'true');
    expect(arranjoSweepDesligado()).toBe(false);
    expect(SHOPEE_ARRANJO_SWEEP_DISABLED_ENV).toBe('SHOPEE_ARRANJO_SWEEP_DISABLED');
  });

  // T7 (review 3b, a TYPE pin — `pnpm typecheck` is what fails it): a constant
  // widened to `string` widens `motivo` with it, and then the handler's
  // `satisfies Record<NonNullable<motivo>, string>` accepts ANY rows — a fourth
  // reason without a variable would compile.
  it('`motivo` é a união LITERAL dos três motivos, nunca `string`', () => {
    expectTypeOf<ArranjoAutomaticoSweepResult['motivo']>().toEqualTypeOf<
      'sweep-desligado' | 'arranjo-desligado' | 'tasks-desabilitado' | null
    >();
  });
});

/* -------------------------------------------------------------------------- */
/*                                  a requisição                               */
/* -------------------------------------------------------------------------- */

describe('a busca — o pedido exato à Shopee', () => {
  it('página 1: os três filtros que a Shopee já tem por padrão SÃO enviados, ShipByDate crescente, 100 por página, sem chave `cursor`', async () => {
    const c = cenario();
    semearConta(c, INT_A);

    await rodar(c);

    expect(c.busca).toHaveBeenCalledTimes(1);
    const p = chamadaBusca(c, 0);
    expect(p).toEqual({
      pageSize: 100,
      filtro: {
        packageStatus: 2,
        fulfillmentType: 2,
        invoicePending: false,
        logisticsChannelIds: [90011, 90012, 90026],
      },
      ordenacao: { sortType: 1, ascending: true },
    });
    // `toEqual` ignores an `undefined` key; the ABSENCE is the wire fact.
    expect('cursor' in p).toBe(false);
    // The filter IS the predicate's tuple — the two can never name different channels.
    expect(p.filtro.logisticsChannelIds).toBe(CANAIS_ARRANJO_AUTOMATICO);
    // …and the package's own guard accepts it (a refusal would be a rethrown ShopeeConfigError).
    expect(() => assertSearchPackageListParams(p)).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/*                                  a paginação                                */
/* -------------------------------------------------------------------------- */

describe('a paginação — `more` é o ÚNICO terminador', () => {
  it('uma página CURTA com more:true NÃO encerra: a página 2 leva o cursor VERBATIM e os mesmos filtros', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    const CURSOR = ' 1760000000,123456789 ';
    c.busca
      .mockResolvedValueOnce(
        pagina([linhaBusca(PACOTE)], { total_count: 2, more: true, next_cursor: CURSOR }),
      )
      .mockResolvedValueOnce(
        pagina([linhaBusca(PACOTE_2)], { total_count: 2, more: false, next_cursor: '' }),
      );

    const r = unica(await rodar(c));

    expect(c.busca).toHaveBeenCalledTimes(2);
    const { cursor, ...semCursor } = chamadaBusca(c, 1);
    expect(cursor).toBe(CURSOR);
    expect(semCursor).toEqual(chamadaBusca(c, 0));
    expect(r.paginasLidas).toBe(2);
    expect(r.totalInformado).toBe(2);
    expect(r.linhas).toBe(2);
    expect(r.truncada).toBe(false);
  });

  it('uma página CHEIA (100 linhas) com more:false encerra — nunca pela contagem de linhas', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    const linhas = Array.from({ length: 100 }, (_, i) =>
      linhaBusca(pacoteN(i + 1), { is_shipment_arranged: true }),
    );
    c.busca.mockResolvedValueOnce(
      pagina(linhas, { total_count: 100, more: false, next_cursor: '' }),
    );

    const r = unica(await rodar(c));

    expect(c.busca).toHaveBeenCalledTimes(1);
    expect(r.truncada).toBe(false);
    expect(r.jaArranjadosNaBusca).toBe(100);
  });

  it(`para em EXATAMENTE ${String(MAX_PAGINAS_ARRANJO_POR_CONTA)} páginas com more:true — truncada por \`limite-de-paginas\``, async () => {
    expect(MAX_PAGINAS_ARRANJO_POR_CONTA).toBe(5);
    const c = cenario();
    semearConta(c, INT_A);
    let n = 0;
    c.busca.mockImplementation(() => {
      n += 1;
      return Promise.resolve(
        pagina([linhaBusca(pacoteN(n), { is_shipment_arranged: true })], {
          total_count: 999,
          more: true,
          next_cursor: `cursor-${String(n)}`,
        }),
      );
    });

    const r = unica(await rodar(c));

    expect(c.busca).toHaveBeenCalledTimes(5);
    expect(chamadaBusca(c, 4).cursor).toBe('cursor-4');
    expect(r.paginasLidas).toBe(5);
    expect(r.totalInformado).toBe(999);
    expect(r.truncada).toBe(true);
    expect(r.truncadaPor).toBe(TRUNCAGEM_ARRANJO.paginas);
  });

  it('quase-igual: a 5ª página diz more:false ⇒ drenada, NÃO truncada', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    let n = 0;
    c.busca.mockImplementation(() => {
      n += 1;
      return Promise.resolve(
        pagina([], {
          total_count: 0,
          more: n < 5,
          next_cursor: n < 5 ? `cursor-${String(n)}` : '',
        }),
      );
    });

    const r = unica(await rodar(c));

    expect(c.busca).toHaveBeenCalledTimes(5);
    expect(r.truncada).toBe(false);
    expect(r.truncadaPor).toBeNull();
  });

  it.each([[null], [''], ['   ']])(
    'more:true com next_cursor %j ⇒ truncada `more-sem-cursor`, um warn, e nenhuma segunda página',
    async (proximo) => {
      const c = cenario();
      semearConta(c, INT_A);
      c.busca.mockResolvedValueOnce(
        pagina([linhaBusca(PACOTE, { is_shipment_arranged: true })], {
          total_count: 9,
          more: true,
          next_cursor: proximo,
        }),
      );

      const r = unica(await rodar(c));

      expect(c.busca).toHaveBeenCalledTimes(1);
      expect(r.truncadaPor).toBe(TRUNCAGEM_ARRANJO.moreSemCursor);
      expect(c.logs.map((l) => l.msg)).toEqual([
        '[shopee/arranjo-automatico] more=true sem next_cursor — conta truncada',
      ]);
    },
  );

  it('sem `pagination`: sem linhas ⇒ drenada; COM linhas ⇒ truncada `paginacao-ausente`, e as linhas ainda contam', async () => {
    const vazia = cenario();
    semearConta(vazia, INT_A);
    vazia.busca.mockResolvedValueOnce(paginaSemPaginacao([]));
    const rv = unica(await rodar(vazia));
    expect(rv.truncada).toBe(false);
    expect(rv.totalInformado).toBe(0);
    expect(vazia.logs).toEqual([]);

    const cheia = cenario();
    semearConta(cheia, INT_A);
    semearPedido(cheia, INT_A, ORDER_SN);
    naShopee(cheia, PACOTE);
    cheia.busca.mockResolvedValueOnce(paginaSemPaginacao([linhaBusca(PACOTE)]));
    const rc = unica(await rodar(cheia));
    expect(cheia.busca).toHaveBeenCalledTimes(1);
    expect(rc.truncadaPor).toBe(TRUNCAGEM_ARRANJO.paginacaoAusente);
    expect(rc.enfileiradosPacote).toBe(1);
  });

  it('a resposta VAZIA que a Shopee mandou (SG, 2026-10-01): `[]` + `{0, false, ""}` ⇒ drenada, zero detalhe, zero tarefa', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    c.busca.mockResolvedValueOnce(
      lerBuscaDePacotes(FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_TURBO).response,
    );

    const r = unica(await rodar(c));

    expect(r).toMatchObject({ paginasLidas: 1, linhas: 0, truncada: false, totalInformado: 0 });
    expect(c.detalhe).not.toHaveBeenCalled();
    expect(c.enqueue).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*                               a triagem grátis                              */
/* -------------------------------------------------------------------------- */

describe('a triagem grátis da linha da busca', () => {
  it('`is_shipment_arranged: true` não custa detalhe; `false`, `null` e o texto "false" (lido como null) custam', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);
    for (const n of [2, 3, 4]) naShopee(c, pacoteN(n));
    c.busca.mockResolvedValueOnce(
      pagina([
        linhaBusca(pacoteN(1), { is_shipment_arranged: true }),
        linhaBusca(pacoteN(2), { is_shipment_arranged: false }),
        linhaBusca(pacoteN(3), { is_shipment_arranged: null }),
        linhaBusca(pacoteN(4), { is_shipment_arranged: 'false' }),
      ]),
    );

    const r = unica(await rodar(c));

    expect(lotesDoDetalhe(c)).toEqual([[pacoteN(2), pacoteN(3), pacoteN(4)]]);
    expect(r.jaArranjadosNaBusca).toBe(1);
    expect(r.enfileiradosPacote).toBe(3);
    esperarParticao(r);
  });

  it('um canal CONHECIDO fora do conjunto é `foraDoCanal` + warn, nunca detalhe; `null` e "90011" vão ao detalhe', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);
    naShopee(c, pacoteN(2));
    naShopee(c, pacoteN(3));
    // The search row's channel was unknown; the FRESH row says it is off-set.
    naShopee(c, pacoteN(4), { logistics_channel_id: 90025 });
    c.busca.mockResolvedValueOnce(
      pagina([
        linhaBusca(pacoteN(1), { logistics_channel_id: CANAL_FORA }),
        linhaBusca(pacoteN(2), { logistics_channel_id: null }),
        linhaBusca(pacoteN(3), { logistics_channel_id: '90011' }),
        linhaBusca(pacoteN(4), { logistics_channel_id: 'ilegivel' }),
      ]),
    );

    const r = unica(await rodar(c));

    expect(lotesDoDetalhe(c)).toEqual([[pacoteN(2), pacoteN(3), pacoteN(4)]]);
    expect(r.foraDoCanal).toBe(1);
    expect(r.foraDoCanalNoDetalhe).toBe(1);
    expect(r.enfileiradosPacote).toBe(2);
    expect(c.enqueue.mock.calls.map(([p]) => p.data?.package_number)).toEqual([
      pacoteN(2),
      pacoteN(3),
    ]);
    expect(c.logs).toEqual([
      {
        msg: '[shopee/arranjo-automatico] linhas FORA do filtro de canal',
        meta: { integracaoId: INT_A, foraDoCanal: 1, foraDoCanalNoDetalhe: 1 },
      },
    ]);
    esperarParticao(r);
  });

  it('uma linha ilegível (identidade em branco) vira o sentinela `null` e só CONTA', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    c.busca.mockResolvedValueOnce(
      pagina([
        linhaBusca(''),
        linhaBusca(PACOTE, { order_sn: '' }),
        linhaBusca(PACOTE_2, { is_shipment_arranged: true }),
      ]),
    );

    const r = unica(await rodar(c));

    expect(r.ilegiveisNaBusca).toBe(2);
    expect(r.linhas).toBe(3);
    expect(c.detalhe).not.toHaveBeenCalled();
    esperarParticao(r);
  });

  // ⚠️ Through the REAL client: its `getPackageDetail` guard refuses a blank,
  // `"-"` or a comma with `ShopeeConfigError` — which the sweep RETHROWS. One
  // such row reaching the detail would fail every tick for every conta.
  it('`-`, branco e vírgula NÃO são pacote: contam como ilegíveis e nunca chegam ao detalhe (o guarda real do pacote)', async () => {
    const { client, caminhos, corpos } = clienteReal([
      envelope({
        packages_list: [
          linhaBusca('-'),
          linhaBusca('   '),
          linhaBusca(`${PACOTE},${PACOTE_2}`),
          linhaBusca(PACOTE),
        ],
        pagination: { total_count: 4, more: false, next_cursor: '' },
      }),
      envelope({
        package_list: [
          {
            order_sn: ORDER_SN,
            package_number: PACOTE,
            fulfillment_status: 'LOGISTICS_READY',
            logistics_channel_id: CANAL_TURBO,
            is_shipment_arranged: false,
            invoice_pending: { status: 'valid', pending_reason: '' },
          },
        ],
      }),
    ]);
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);

    const r = unica(await rodar(c, { clientFor: () => Promise.resolve(client) }));

    expect(r.error).toBeNull();
    expect(r.ilegiveisNaBusca).toBe(3);
    expect(caminhos).toEqual([
      '/api/v2/order/search_package_list',
      '/api/v2/order/get_package_detail',
    ]);
    expect(corpos[1]).toBeNull();
    expect(c.enqueue).toHaveBeenCalledTimes(1);
    expect(enfileirado(c, 0).data?.package_number).toBe(PACOTE);
    esperarParticao(r);
  });

  it('no detalhe, uma linha sem `order_sn` utilizável não nomeia pacote (ilegível ⇒ ausente); um `order_sn` acolchoado é o mesmo pedido', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);
    naShopee(c, PACOTE, { order_sn: '-' });
    naShopee(c, PACOTE_2, { order_sn: ` ${ORDER_SN}  ` });
    c.busca.mockResolvedValueOnce(pagina([linhaBusca(PACOTE), linhaBusca(PACOTE_2)]));

    const r = unica(await rodar(c));

    expect(r).toMatchObject({ ilegiveisNoDetalhe: 1, ausentesNoDetalhe: 1, enfileiradosPacote: 1 });
    expect(enfileirado(c, 0).data).toEqual({
      ordersn: ORDER_SN,
      package_number: PACOTE_2,
      origem: 'arranjo-automatico',
    });
    esperarParticao(r);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  o detalhe                                  */
/* -------------------------------------------------------------------------- */

describe('o pré-filtro do detalhe', () => {
  it('lotes de EXATAMENTE 50: 51 candidatos ⇒ 2 chamadas (50 + 1); 50 ⇒ 1 (o quase-igual)', async () => {
    for (const [total, lotes] of [
      [51, [50, 1]],
      [50, [50]],
    ] as const) {
      const c = cenario();
      semearConta(c, INT_A);
      semearPedido(c, INT_A, ORDER_SN);
      const numeros = Array.from({ length: total }, (_, i) => pacoteN(i + 1));
      for (const n of numeros) naShopee(c, n);
      c.busca.mockResolvedValueOnce(pagina(numeros.map((n) => linhaBusca(n))));

      const r = unica(await rodar(c));

      expect(lotesDoDetalhe(c).map((l) => l.length)).toEqual(lotes);
      expect(lotesDoDetalhe(c).flat()).toEqual(numeros);
      expect(r.enfileiradosPacote).toBe(total);
    }
  });

  it('reconcilia POR `package_number`, nunca por posição: resposta INVERTIDA, com um `null` e um ausente', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);
    semearPedido(c, INT_A, ORDER_SN_2);
    naShopee(c, PACOTE, { order_sn: ORDER_SN });
    naShopee(c, PACOTE_2, { order_sn: ORDER_SN_2 });
    c.detalhe.mockImplementationOnce(() =>
      Promise.resolve(
        shopeePackageDetailPayloadSchema.parse({
          package_list: [c.pacotes.get(PACOTE_2), { order_sn: '' }, c.pacotes.get(PACOTE)],
        }),
      ),
    );
    c.busca.mockResolvedValueOnce(
      pagina([
        linhaBusca(PACOTE, { order_sn: ORDER_SN }),
        linhaBusca(PACOTE_2, { order_sn: ORDER_SN_2 }),
        linhaBusca(pacoteN(3)),
      ]),
    );

    const r = unica(await rodar(c));

    expect(c.enqueue.mock.calls.map(([p]) => p.data)).toEqual([
      { ordersn: ORDER_SN, package_number: PACOTE, origem: 'arranjo-automatico' },
      { ordersn: ORDER_SN_2, package_number: PACOTE_2, origem: 'arranjo-automatico' },
    ]);
    expect(r.ilegiveisNoDetalhe).toBe(1);
    expect(r.ausentesNoDetalhe).toBe(1);
    expect(r.consultadosNoDetalhe).toBe(3);
    esperarParticao(r);
  });

  // ⚠️ S2-2 (review 3b): the handler the code 30 feeds finds its row with
  // `r.package_number === packageNumber` (`rastrearPedido.ts`), EXACT. A sweep
  // that matched the detail TRIMMED enqueued a package the handler could never
  // find — one parked row and two detail calls per tick, the package never
  // arranged. One reader: the detail is matched exactly here too.
  it('o número do DETALHE é comparado EXATO, como o handler: o exato vira tarefa (o par); o ACOLCHOADO é ausente, nunca tarefa (o quase-igual)', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);
    // The detail spells OFG…1 padded: the handler would never find it.
    naShopee(c, PACOTE, { package_number: `  ${PACOTE} ` });
    naShopee(c, PACOTE_2);
    // The SEARCH side still trims (the number goes OUT in the detail request):
    // `' OFG…1 '` and `'OFG…1'` are ONE package, a duplicate.
    c.busca.mockResolvedValueOnce(
      pagina([linhaBusca(` ${PACOTE} `), linhaBusca(PACOTE), linhaBusca(PACOTE_2)]),
    );

    const r = unica(await rodar(c));

    expect(lotesDoDetalhe(c)).toEqual([[PACOTE, PACOTE_2]]);
    expect(r.duplicadas).toBe(1);
    expect(r.ausentesNoDetalhe).toBe(1);
    expect(r.ilegiveisNoDetalhe).toBe(0);
    expect(r.enfileiradosPacote).toBe(1);
    // Only the EXACT one is a task — and its identity is the string the handler asks for.
    expect(c.enqueue.mock.calls.map(([p]) => p.data?.package_number)).toEqual([PACOTE_2]);
    expect(dedupKeyOf(enfileirado(c, 0))).toBe(`30:${String(SHOP_A)}:${PACOTE_2}`);
    // A padded spelling is a drift, and the ONE package it hid is said out loud (S1-3).
    expect(c.logs).toEqual([
      {
        msg: '[shopee/arranjo-automatico] linhas ilegíveis ou ausentes — pacotes não avaliados',
        meta: {
          integracaoId: INT_A,
          ilegiveisNaBusca: 0,
          ilegiveisNoDetalhe: 0,
          ausentesNoDetalhe: 1,
          canalDesconhecidoNoDetalhe: 0,
        },
      },
    ]);
    esperarParticao(r);
  });

  // S1-7 (review 3b): a `null` fresh channel is UNKNOWN, not off the set.
  it('um canal `null` no DETALHE conta em `canalDesconhecidoNoDetalhe`, fora do warn do registro 224 — e nunca vira tarefa', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);
    naShopee(c, PACOTE, { logistics_channel_id: null });
    c.busca.mockResolvedValueOnce(pagina([linhaBusca(PACOTE)]));

    const r = unica(await rodar(c));

    expect(r).toMatchObject({
      canalDesconhecidoNoDetalhe: 1,
      foraDoCanalNoDetalhe: 0,
      foraDoCanal: 0,
    });
    expect(c.enqueue).not.toHaveBeenCalled();
    // NOT register 224's warn — the unreadable-rows one, and only that (S1-3).
    expect(c.logs).toEqual([
      {
        msg: '[shopee/arranjo-automatico] linhas ilegíveis ou ausentes — pacotes não avaliados',
        meta: {
          integracaoId: INT_A,
          ilegiveisNaBusca: 0,
          ilegiveisNoDetalhe: 0,
          ausentesNoDetalhe: 0,
          canalDesconhecidoNoDetalhe: 1,
        },
      },
    ]);
    esperarParticao(r);
  });

  it('cada fase conta na SUA chave (todas presentes); só `programar` vira tarefa — nunca uma NF-e pendente', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);
    const casos: [number, Record<string, unknown>][] = [
      [1, { invoice_pending: { status: ' Pending ', pending_reason: 'x' } }],
      [2, { fulfillment_status: 'LOGISTICS_PICKUP_RETRY' }],
      [3, { is_shipment_arranged: true }],
      [4, { pending_terms: ['SELLER_HOLD'] }],
      [5, { fulfillment_status: 'LOGISTICS_NOT_START' }],
      [6, {}],
      [7, { fulfillment_status: 'LOGISTICS_PICKUP_DONE' }],
      [8, { fulfillment_status: 'LOGISTICS_INVALID' }],
      [9, { fulfillment_status: 'LOGISTICS_ALGO_NOVO' }],
      [10, { pending_terms: ['-'] }],
    ];
    for (const [n, over] of casos) naShopee(c, pacoteN(n), over);
    c.busca.mockResolvedValueOnce(pagina(casos.map(([n]) => linhaBusca(pacoteN(n)))));

    const r = unica(await rodar(c));

    expect(r.fases).toEqual({
      ...FASES_ZERO,
      'nfe-pendente': 1,
      arranjado: 2,
      retido: 1,
      'nao-pronto': 1,
      programar: 2,
      'janela-fechada': 1,
      inelegivel: 1,
      desconhecido: 1,
    });
    // Register 222's instrument: the `false` filter RETURNED a pending package.
    expect(r.nfePendenteNaBusca).toBe(1);
    expect(c.enqueue.mock.calls.map(([p]) => p.data?.package_number)).toEqual([
      pacoteN(6),
      pacoteN(10),
    ]);
    esperarParticao(r);
  });

  it('sem nenhum sobrevivente, ZERO chamadas de detalhe — e as chaves de fase todas presentes, em zero', async () => {
    const c = cenario();
    semearConta(c, INT_A);

    const r = unica(await rodar(c));

    expect(c.detalhe).not.toHaveBeenCalled();
    expect(r.fases).toEqual(FASES_ZERO);
    expect(Object.keys(r.fases).sort()).toEqual(Object.keys(FASES_ZERO).sort());
  });
});

/* -------------------------------------------------------------------------- */
/*                                 o enfileiramento                            */
/* -------------------------------------------------------------------------- */

describe('o enfileiramento', () => {
  it('pedido PRESENTE ⇒ exatamente um code 30, `data` com EXATAMENTE três chaves (sem `update_time`)', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);
    naShopee(c, PACOTE);
    c.busca.mockResolvedValueOnce(pagina([linhaBusca(PACOTE)]));

    const r = unica(await rodar(c));

    expect(c.enqueue).toHaveBeenCalledTimes(1);
    const p = enfileirado(c, 0);
    expect(p).toEqual({
      code: 30,
      shopId: SHOP_A,
      timestamp: DIA_DE_AGORA_MS,
      data: { ordersn: ORDER_SN, package_number: PACOTE, origem: 'arranjo-automatico' },
    });
    expect(Object.keys(p.data ?? {}).sort()).toEqual(['ordersn', 'origem', 'package_number']);
    expect(docIdOf(p)).toBe(`30:${String(SHOP_A)}:${PACOTE}:${String(DIA_DE_AGORA_MS)}`);
    expect(dedupKeyOf(p)).toBe(`30:${String(SHOP_A)}:${PACOTE}`);
    expect(r).toMatchObject({ enfileiradosPacote: 1, enfileiradosPedido: 0 });
  });

  it('pedido AUSENTE ⇒ UM code 3 por order_sn (dois pacotes do mesmo pedido = um), nenhum code 30, uma leitura por pedido', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    naShopee(c, PACOTE);
    naShopee(c, PACOTE_2);
    naShopee(c, pacoteN(3), { order_sn: ORDER_SN_2 });
    c.busca.mockResolvedValueOnce(
      pagina([
        linhaBusca(PACOTE),
        linhaBusca(PACOTE_2),
        linhaBusca(pacoteN(3), { order_sn: ORDER_SN_2 }),
      ]),
    );

    const r = unica(await rodar(c));

    // ⚠️ Stamped with the START of the UTC day, never `nowMs` (S1-4 / S2-1).
    expect(c.enqueue.mock.calls.map(([p]) => p)).toEqual([
      {
        code: 3,
        shopId: SHOP_A,
        timestamp: DIA_DE_AGORA_MS,
        data: { ordersn: ORDER_SN, origem: 'arranjo-automatico' },
      },
      {
        code: 3,
        shopId: SHOP_A,
        timestamp: DIA_DE_AGORA_MS,
        data: { ordersn: ORDER_SN_2, origem: 'arranjo-automatico' },
      },
    ]);
    expect(r).toMatchObject({
      enfileiradosPacote: 0,
      enfileiradosPedido: 2,
      pedidosComFalhaHoje: 0,
    });
    expect(r.fases.programar).toBe(3);
    const leituras = c.db.opLog.filter((o) => o.path === caminhoDoPedido(INT_A, ORDER_SN));
    expect(leituras).toEqual([{ op: 'get', path: caminhoDoPedido(INT_A, ORDER_SN) }]);
    // …and ONE read of each order's failure row for today — per ORDER, not per package.
    const falhas = c.db.opLog.filter((o) => o.path.startsWith(`${NOTIFICACAO_PATH}/`));
    expect(falhas).toEqual([
      { op: 'get', path: caminhoDaFalhaDoPedido(ORDER_SN, DIA_DE_AGORA_MS) },
      { op: 'get', path: caminhoDaFalhaDoPedido(ORDER_SN_2, DIA_DE_AGORA_MS) },
    ]);
  });

  describe('o code 3 de um pedido ausente: no máximo UMA tentativa por pedido por dia UTC (S1-4 / S2-1)', () => {
    /** One order, two packages, NO pedido yet. */
    function pedidoAusente(): Cenario {
      const c = cenario();
      semearConta(c, INT_A);
      naShopee(c, PACOTE);
      naShopee(c, PACOTE_2);
      c.busca.mockResolvedValue(pagina([linhaBusca(PACOTE), linhaBusca(PACOTE_2)]));
      return c;
    }

    it('o carimbo é o INÍCIO do dia UTC: o mesmo dia ⇒ o MESMO doc id; o dia seguinte ⇒ outro (o quase-igual)', async () => {
      expect(DIA_DE_AGORA_MS % DIA_MS).toBe(0);
      expect(AGORA_MS - DIA_DE_AGORA_MS).toBeLessThan(DIA_MS);
      const ids: (string | null)[] = [];
      // 09:20, 23:20 (past noon: a ROUNDING floor would move it) and 09:20 the next day.
      for (const nowMs of [AGORA_MS, AGORA_MS + 14 * 3_600_000, AGORA_MS + DIA_MS]) {
        const c = pedidoAusente();
        await rodar(c, { nowMs });
        expect(c.enqueue).toHaveBeenCalledTimes(1);
        ids.push(docIdOf(enfileirado(c, 0)));
      }
      expect(ids).toEqual([
        `3:${String(SHOP_A)}:${ORDER_SN}:${String(DIA_DE_AGORA_MS)}`,
        `3:${String(SHOP_A)}:${ORDER_SN}:${String(DIA_DE_AGORA_MS)}`,
        `3:${String(SHOP_A)}:${ORDER_SN}:${String(DIA_DE_AGORA_MS + DIA_MS)}`,
      ]);
    });

    it('a linha de falha de HOJE existe ⇒ NÃO reenfileira, conta `pedidosComFalhaHoje` (uma leitura, dois pacotes)', async () => {
      const c = pedidoAusente();
      c.db.seed(caminhoDaFalhaDoPedido(ORDER_SN, DIA_DE_AGORA_MS), { status: 'parked' });

      const r = unica(await rodar(c));

      expect(c.enqueue).not.toHaveBeenCalled();
      expect(r).toMatchObject({ pedidosComFalhaHoje: 1, enfileiradosPedido: 0 });
      expect(r.fases.programar).toBe(2);
      expect(
        c.db.opLog.filter((o) => o.path === caminhoDaFalhaDoPedido(ORDER_SN, DIA_DE_AGORA_MS)),
      ).toHaveLength(1);
      esperarParticao(r);
    });

    it.each([
      ['de ONTEM', caminhoDaFalhaDoPedido(ORDER_SN, DIA_DE_AGORA_MS - DIA_MS)],
      ['de OUTRO pedido', caminhoDaFalhaDoPedido(ORDER_SN_2, DIA_DE_AGORA_MS)],
      ['de OUTRA loja', caminhoDaFalhaDoPedido(ORDER_SN, DIA_DE_AGORA_MS, SHOP_B)],
    ])('quase-igual: uma linha de falha %s não impede o code 3 de hoje', async (_caso, caminho) => {
      const c = pedidoAusente();
      c.db.seed(caminho, { status: 'parked' });

      const r = unica(await rodar(c));

      expect(c.enqueue).toHaveBeenCalledTimes(1);
      expect(r).toMatchObject({ pedidosComFalhaHoje: 0, enfileiradosPedido: 1 });
    });

    it('com o pedido PRESENTE, a linha de falha nem é lida (a leitura é só do caminho ausente)', async () => {
      const c = pedidoAusente();
      semearPedido(c, INT_A, ORDER_SN);

      await rodar(c);

      expect(c.enqueue).toHaveBeenCalledTimes(2);
      // Only the code-3 row: the code 30 of a PRESENT pedido reads ITS OWN row
      // (`pacotesComFalhaHoje`, PR #1758's review).
      expect(c.db.caminhos.some((p) => p.startsWith(`${NOTIFICACAO_PATH}/3:`))).toBe(false);
    });
  });

  describe('o code 30 de HOJE (review do PR #1758: o mesmo teto do code 3)', () => {
    function caminhoDaFalhaDoPacote(pacote: string, diaMs: number, shopId = SHOP_A): string {
      return `${NOTIFICACAO_PATH}/30:${String(shopId)}:${pacote}:${String(diaMs)}`;
    }

    function pedidoPresente(): Cenario {
      const c = cenario();
      semearConta(c, INT_A);
      semearPedido(c, INT_A, ORDER_SN);
      naShopee(c, PACOTE);
      c.busca.mockResolvedValueOnce(pagina([linhaBusca(PACOTE)]));
      return c;
    }

    it('a linha de falha de HOJE do pacote existe ⇒ NÃO reenfileira, conta `pacotesComFalhaHoje` (uma leitura)', async () => {
      const c = pedidoPresente();
      c.db.seed(caminhoDaFalhaDoPacote(PACOTE, DIA_DE_AGORA_MS), { status: 'parked' });

      const r = unica(await rodar(c));

      expect(c.enqueue).not.toHaveBeenCalled();
      expect(r).toMatchObject({ pacotesComFalhaHoje: 1, enfileiradosPacote: 0 });
      expect(r.fases.programar).toBe(1);
      expect(
        c.db.opLog.filter((o) => o.path === caminhoDaFalhaDoPacote(PACOTE, DIA_DE_AGORA_MS)),
      ).toHaveLength(1);
      esperarParticao(r);
    });

    it.each([
      ['de ONTEM', caminhoDaFalhaDoPacote(PACOTE, DIA_DE_AGORA_MS - DIA_MS)],
      ['de OUTRO pacote', caminhoDaFalhaDoPacote(PACOTE_2, DIA_DE_AGORA_MS)],
      ['de OUTRA loja', caminhoDaFalhaDoPacote(PACOTE, DIA_DE_AGORA_MS, SHOP_B)],
      ['do code 3 do MESMO pedido', caminhoDaFalhaDoPedido(ORDER_SN, DIA_DE_AGORA_MS)],
    ])(
      'quase-igual: uma linha de falha %s não impede o code 30 de hoje',
      async (_caso, caminho) => {
        const c = pedidoPresente();
        c.db.seed(caminho, { status: 'parked' });

        const r = unica(await rodar(c));

        expect(c.enqueue).toHaveBeenCalledTimes(1);
        expect(r).toMatchObject({ pacotesComFalhaHoje: 0, enfileiradosPacote: 1 });
      },
    );

    it('o carimbo é o INÍCIO do dia UTC: dois ticks do mesmo dia dão o MESMO doc id; o dia seguinte, outro', async () => {
      const ids: string[] = [];
      for (const nowMs of [AGORA_MS, AGORA_MS + 14 * 3_600_000, AGORA_MS + DIA_MS]) {
        const c = pedidoPresente();
        await rodar(c, { nowMs });
        const id = docIdOf(enfileirado(c, 0));
        if (id === null) throw new Error('code 30 sem doc id');
        ids.push(id);
      }
      expect(ids).toEqual([
        `30:${String(SHOP_A)}:${PACOTE}:${String(DIA_DE_AGORA_MS)}`,
        `30:${String(SHOP_A)}:${PACOTE}:${String(DIA_DE_AGORA_MS)}`,
        `30:${String(SHOP_A)}:${PACOTE}:${String(DIA_DE_AGORA_MS + DIA_MS)}`,
      ]);
    });
  });

  it('no tick seguinte, com o pedido já importado, cada pacote vira o SEU code 30', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);
    naShopee(c, PACOTE);
    naShopee(c, PACOTE_2);
    c.busca.mockResolvedValueOnce(pagina([linhaBusca(PACOTE), linhaBusca(PACOTE_2)]));

    await rodar(c);

    expect(c.enqueue.mock.calls.map(([p]) => [p.code, p.data?.package_number])).toEqual([
      [30, PACOTE],
      [30, PACOTE_2],
    ]);
  });

  it('o mesmo pacote em duas páginas é UMA leitura e UMA tarefa (o `Set` por conta)', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);
    naShopee(c, PACOTE);
    naShopee(c, PACOTE_2);
    c.busca
      .mockResolvedValueOnce(
        pagina([linhaBusca(PACOTE)], { total_count: 3, more: true, next_cursor: 'c2' }),
      )
      .mockResolvedValueOnce(pagina([linhaBusca(PACOTE), linhaBusca(PACOTE_2)]));

    const r = unica(await rodar(c));

    expect(lotesDoDetalhe(c)).toEqual([[PACOTE, PACOTE_2]]);
    expect(r.duplicadas).toBe(1);
    expect(c.enqueue).toHaveBeenCalledTimes(2);
    esperarParticao(r);
  });

  it(`no máximo ${String(MAX_ENFILEIRADOS_ARRANJO_POR_CONTA)} tarefas por conta — e nenhum detalhe a mais depois do teto`, async () => {
    expect(MAX_ENFILEIRADOS_ARRANJO_POR_CONTA).toBe(100);
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);
    const numeros = Array.from({ length: 150 }, (_, i) => pacoteN(i + 1));
    for (const n of numeros) naShopee(c, n);
    c.busca.mockResolvedValueOnce(pagina(numeros.map((n) => linhaBusca(n))));

    const r = unica(await rodar(c));

    expect(c.enqueue).toHaveBeenCalledTimes(100);
    expect(lotesDoDetalhe(c).map((l) => l.length)).toEqual([50, 50]);
    expect(r.naoConsultadosPeloLimite).toBe(50);
    expect(r.truncadaPor).toBe(TRUNCAGEM_ARRANJO.enfileirados);
    esperarParticao(r);
  });

  it('o teto corta NO MEIO de um lote: a 100ª tarefa é a última, e o resto do lote só CONTA', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);
    const numeros = Array.from({ length: 150 }, (_, i) => pacoteN(i + 1));
    // The first 10 are arranged on the FRESH row: read, counted, never enqueued —
    // so the 100th enqueue lands inside the THIRD lot, not on a lot boundary.
    for (const [i, n] of numeros.entries()) naShopee(c, n, { is_shipment_arranged: i < 10 });
    c.busca.mockResolvedValueOnce(pagina(numeros.map((n) => linhaBusca(n))));

    const r = unica(await rodar(c));

    expect(lotesDoDetalhe(c).map((l) => l.length)).toEqual([50, 50, 50]);
    expect(c.enqueue).toHaveBeenCalledTimes(100);
    expect(enfileirado(c, 99).data?.package_number).toBe(pacoteN(110));
    expect(r.fases).toMatchObject({ arranjado: 10, programar: 140 });
    expect(r.naoConsultadosPeloLimite).toBe(0);
    expect(r.truncadaPor).toBe(TRUNCAGEM_ARRANJO.enfileirados);
    esperarParticao(r);
  });

  it('o teto conta code 3 e code 30 JUNTOS; exatamente 100 candidatos NÃO truncam (o quase-igual)', async () => {
    const juntos = cenario();
    semearConta(juntos, INT_A);
    semearPedido(juntos, INT_A, ORDER_SN);
    const ausentes = ['260910AUSENTE1', '260910AUSENTE2'];
    for (const [i, sn] of ausentes.entries()) naShopee(juntos, pacoteN(900 + i), { order_sn: sn });
    const presentes = Array.from({ length: 99 }, (_, i) => pacoteN(i + 1));
    for (const n of presentes) naShopee(juntos, n);
    juntos.busca.mockResolvedValueOnce(
      pagina([
        linhaBusca(pacoteN(900), { order_sn: ausentes[0] }),
        linhaBusca(pacoteN(901), { order_sn: ausentes[1] }),
        ...presentes.map((n) => linhaBusca(n)),
      ]),
    );
    const rj = unica(await rodar(juntos));
    expect(rj).toMatchObject({ enfileiradosPedido: 2, enfileiradosPacote: 98 });
    expect(rj.naoConsultadosPeloLimite).toBe(1);
    expect(rj.truncadaPor).toBe(TRUNCAGEM_ARRANJO.enfileirados);

    const exato = cenario();
    semearConta(exato, INT_A);
    semearPedido(exato, INT_A, ORDER_SN);
    const cem = Array.from({ length: 100 }, (_, i) => pacoteN(i + 1));
    for (const n of cem) naShopee(exato, n);
    exato.busca.mockResolvedValueOnce(pagina(cem.map((n) => linhaBusca(n))));
    const re = unica(await rodar(exato));
    expect(re.enfileiradosPacote).toBe(100);
    expect(re.truncada).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  a contenção                                */
/* -------------------------------------------------------------------------- */

describe('a contenção por conta', () => {
  function duasContas(): Cenario {
    const c = cenario();
    semearConta(c, INT_A, SHOP_A);
    semearConta(c, INT_B, SHOP_B);
    semearPedido(c, INT_B, ORDER_SN);
    naShopee(c, PACOTE);
    return c;
  }

  /** Conta B's own client: one candidate, answered by the shared truth. */
  function clienteB(c: Cenario): { client: ShopeeClient; busca: BuscaMock } {
    const busca: BuscaMock = vi.fn<
      (p: SearchPackageListParams) => Promise<ShopeeSearchPackageList>
    >(() => Promise.resolve(pagina([linhaBusca(PACOTE)])));
    return {
      client: { searchPackageList: busca, getPackageDetail: c.detalhe } as unknown as ShopeeClient,
      busca,
    };
  }

  it.each<[string, () => Error, 'busca' | 'detalhe' | 'enqueue', string]>([
    ['ShopeeApiError', () => apiError('error_server'), 'busca', 'ShopeeApiError: error_server'],
    [
      'ShopeeReauthRequiredError',
      () =>
        new ShopeeReauthRequiredError('reauth', {
          code: 'invalid_access_token',
          kind: SHOPEE_ERROR_KIND.reauth,
          httpStatus: 403,
          path: '/api/v2/order/search_package_list',
        }),
      'busca',
      'ShopeeReauthRequiredError: invalid_access_token',
    ],
    [
      'ShopeeNetworkError',
      () => new ShopeeNetworkError('Falha de rede.'),
      'detalhe',
      'ShopeeNetworkError: Falha de rede.',
    ],
    [
      'ShopeeSchemaError',
      () => new ShopeeSchemaError('formato inesperado', { httpStatus: 200, path: '/x' }),
      'detalhe',
      'ShopeeSchemaError: formato inesperado',
    ],
    // ⚠️ The REAL enqueue failures (S1-1): STRING codes, which the shared
    // gRPC check does not recognise — a numeric `grpc(14)` stand-in here once
    // passed while the real class killed the tick.
    [
      'FirebaseFunctionsError unknown-error no enqueue (503/429 do Cloud Tasks)',
      () => falhaDoFunctions('unknown-error'),
      'enqueue',
      'EnfileiramentoTransitorioError: FirebaseFunctionsError functions/unknown-error',
    ],
    [
      'FirebaseFunctionsError internal-error no enqueue',
      () => falhaDoFunctions('internal-error'),
      'enqueue',
      'EnfileiramentoTransitorioError: FirebaseFunctionsError functions/internal-error',
    ],
    [
      'FirebaseFunctionsError aborted no enqueue',
      () => falhaDoFunctions('aborted'),
      'enqueue',
      'EnfileiramentoTransitorioError: FirebaseFunctionsError functions/aborted',
    ],
    [
      'FirebaseAppError network-error no enqueue (socket)',
      () => falhaDoApp(AppErrorCode.NETWORK_ERROR),
      'enqueue',
      'EnfileiramentoTransitorioError: FirebaseAppError app/network-error',
    ],
    [
      'FirebaseAppError network-timeout no enqueue',
      () => falhaDoApp(AppErrorCode.NETWORK_TIMEOUT),
      'enqueue',
      'EnfileiramentoTransitorioError: FirebaseAppError app/network-timeout',
    ],
    [
      'ShopeeTasksDisabledError no enqueue',
      () => new ShopeeTasksDisabledError(),
      'enqueue',
      'ShopeeTasksDisabledError',
    ],
  ])(
    '%s na conta A é CONTIDO: A registra o erro, B ainda é varrida',
    async (_nome, erro, onde, descricao) => {
      const c = duasContas();
      semearPedido(c, INT_A, ORDER_SN);
      const b = clienteB(c);
      c.clientPor.set(INT_B, b.client);
      if (onde === 'busca') c.busca.mockRejectedValueOnce(erro());
      else c.busca.mockResolvedValueOnce(pagina([linhaBusca(PACOTE)]));
      if (onde === 'detalhe') c.detalhe.mockRejectedValueOnce(erro());
      if (onde === 'enqueue') c.enqueue.mockRejectedValueOnce(erro());

      const r = await rodar(c);

      expect(r.contas.map((x) => x.integracaoId)).toEqual([INT_A, INT_B]);
      expect(r.contas[0]?.error).toContain(descricao);
      expect(r.contas[1]?.error).toBeNull();
      expect(b.busca).toHaveBeenCalledTimes(1);
      expect(r.interrompidoPorLimite).toBeNull();
      expect(c.logs.map((l) => l.msg)).toContain(
        '[shopee/arranjo-automatico] conta contida após falha',
      );
    },
  );

  it('a falha REAL do enqueue é descrita por classe e código — nunca pela mensagem do SDK, que pode citar o corpo', async () => {
    const c = duasContas();
    semearPedido(c, INT_A, ORDER_SN);
    c.clientPor.set(INT_B, clienteB(c).client);
    c.busca.mockResolvedValueOnce(pagina([linhaBusca(PACOTE)]));
    const erro = falhaDoFunctions('unknown-error');
    // The positive control: the real class, the real string code, and a message that DOES leak.
    expect(erro.code).toBe('functions/unknown-error');
    expect(erro.message).toContain(PACOTE);
    c.enqueue.mockRejectedValueOnce(erro);

    const r = await rodar(c);

    expect(r.contas.map((x) => [x.integracaoId, x.error])).toEqual([
      [INT_A, 'EnfileiramentoTransitorioError: FirebaseFunctionsError functions/unknown-error'],
      [INT_B, null],
    ]);
    // The failed enqueue is not counted as one.
    expect(r.contas[0]).toMatchObject({ fases: { programar: 1 }, enfileiradosPacote: 0 });
    const texto = JSON.stringify([c.logs, r]);
    for (const segredo of [ORDER_SN, PACOTE]) expect(texto).not.toContain(segredo);
  });

  // ⚠️ The near-misses: the same two CLASSES carrying a deploy-shaped code, the
  // transient code on a look-alike that is not the class, and the class raised
  // somewhere other than the enqueue — each fails the tick, and B is never walked.
  it.each<[string, () => Error, 'busca' | 'enqueue']>([
    [
      'functions/permission-denied (falta o IAM)',
      () => falhaDoFunctions('permission-denied'),
      'enqueue',
    ],
    ['functions/not-found (sem fila nessa região)', () => falhaDoFunctions('not-found'), 'enqueue'],
    ['functions/invalid-argument', () => falhaDoFunctions('invalid-argument'), 'enqueue'],
    ['functions/unauthenticated', () => falhaDoFunctions('unauthenticated'), 'enqueue'],
    ['functions/failed-precondition', () => falhaDoFunctions('failed-precondition'), 'enqueue'],
    ['app/invalid-credential', () => falhaDoApp(AppErrorCode.INVALID_CREDENTIAL), 'enqueue'],
    ['app/internal-error', () => falhaDoApp(AppErrorCode.INTERNAL_ERROR), 'enqueue'],
    [
      'um Error comum com o MESMO código (a forma, não a classe)',
      () => Object.assign(new Error('503'), { code: 'functions/unknown-error' }),
      'enqueue',
    ],
    [
      'app/network-error FORA do enqueue (na busca)',
      () => falhaDoApp(AppErrorCode.NETWORK_ERROR),
      'busca',
    ],
  ])('%s NÃO é contido: o tick falha alto e B nunca é varrida', async (_nome, erro, onde) => {
    const c = duasContas();
    semearPedido(c, INT_A, ORDER_SN);
    const b = clienteB(c);
    c.clientPor.set(INT_B, b.client);
    const lancado = erro();
    if (onde === 'busca') c.busca.mockRejectedValueOnce(lancado);
    else {
      c.busca.mockResolvedValueOnce(pagina([linhaBusca(PACOTE)]));
      c.enqueue.mockRejectedValueOnce(lancado);
    }

    await expect(rodar(c)).rejects.toBe(lancado);
    expect(b.busca).not.toHaveBeenCalled();
  });

  it('gRPC do Firestore ao carregar o contexto da conta A (o caminho padrão) é CONTIDO; B ainda é varrida', async () => {
    const c = duasContas();
    const b = clienteB(c);
    h.loadCtx
      .mockRejectedValueOnce(grpc(14, 'UNAVAILABLE'))
      .mockResolvedValueOnce({ createShopClient: () => b.client });

    const r = await runShopeeArranjoAutomaticoSweep(asDb(c.db), {
      scheduler: { enqueue: c.enqueue },
      nowMs: AGORA_MS,
      logger: { warn: () => {} },
    });

    expect(r.contas.map((x) => [x.integracaoId, x.error])).toEqual([
      [INT_A, 'Error: UNAVAILABLE'],
      [INT_B, null],
    ]);
    expect(b.busca).toHaveBeenCalledTimes(1);
  });

  it('`ShopeeConfigError` NÃO é contido: o tick falha alto e B nunca é tocada', async () => {
    const c = duasContas();
    const b = clienteB(c);
    c.clientPor.set(INT_B, b.client);
    c.busca.mockRejectedValueOnce(new ShopeeConfigError('SHOPEE_PARTNER_ID ausente'));

    await expect(rodar(c)).rejects.toBeInstanceOf(ShopeeConfigError);
    expect(b.busca).not.toHaveBeenCalled();
  });

  it('um bug (TypeError) também NÃO é contido', async () => {
    const c = duasContas();
    c.busca.mockRejectedValueOnce(new TypeError('undefined is not a function'));

    await expect(rodar(c)).rejects.toBeInstanceOf(TypeError);
  });

  it.each(['burst', 'daily'] as const)(
    'limite `%s` na conta A ⇒ o tick PARA: B nunca é construída, `interrompidoPorLimite` diz qual',
    async (kind) => {
      const c = duasContas();
      const clientFor = vi.fn((_db: Firestore, id: string) =>
        Promise.resolve(id === INT_B ? clienteB(c).client : c.client),
      );
      c.busca.mockRejectedValueOnce(limite(kind));

      const r = await rodar(c, { clientFor });

      expect(r.interrompidoPorLimite).toBe(kind);
      expect(clientFor.mock.calls.map(([, id]) => id)).toEqual([INT_A]);
      expect(r.contas).toHaveLength(1);
      expect(r.contas[0]).toMatchObject({
        integracaoId: INT_A,
        error: `ShopeeRateLimitError: ${kind === 'burst' ? 'error_rate_limit' : 'error_limit'}`,
      });
      expect(c.logs).toContainEqual({
        msg: '[shopee/arranjo-automatico] limite da Shopee — tick interrompido',
        meta: { integracaoId: INT_A, limite: kind, contasNaoVarridas: 1 },
      });
    },
  );

  it('um limite no DETALHE (no meio da conta) também para o tick — e o que já rodou fica contado', async () => {
    const c = duasContas();
    c.clientPor.set(INT_B, clienteB(c).client);
    c.busca.mockResolvedValueOnce(pagina([linhaBusca(PACOTE)]));
    c.detalhe.mockRejectedValueOnce(limite('burst'));

    const r = await rodar(c);

    expect(r.contas).toHaveLength(1);
    expect(r.contas[0]).toMatchObject({ paginasLidas: 1, linhas: 1, enfileiradosPacote: 0 });
    expect(c.enqueue).not.toHaveBeenCalled();
  });

  it('uma conta sem `shop_id` é CONTADA, nunca chamada, e não entra em `contas`', async () => {
    const c = cenario();
    semearConta(c, INT_A, SHOP_A);
    semearConta(c, INT_SEM_SHOP, null);
    semearConta(c, INT_B, SHOP_B);
    const clientFor = vi.fn((_db: Firestore, _id: string) => Promise.resolve(c.client));

    const r = await rodar(c, { clientFor });

    expect(r.semShopId).toBe(1);
    expect(r.contas.map((x) => x.integracaoId)).toEqual([INT_A, INT_B]);
    expect(clientFor.mock.calls.map(([, id]) => id)).toEqual([INT_A, INT_B]);
  });

  it('cada conta usa o SEU shop_id no sintético', async () => {
    const c = cenario();
    semearConta(c, INT_B, SHOP_B);
    semearPedido(c, INT_B, ORDER_SN);
    naShopee(c, PACOTE);
    c.busca.mockResolvedValueOnce(pagina([linhaBusca(PACOTE)]));

    await rodar(c);

    expect(enfileirado(c, 0).shopId).toBe(SHOP_B);
  });

  it('sem `clientFor`, o cliente vem do contexto da conta (loadShopeeContext + createShopClient)', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    const createShopClient = vi.fn(() => c.client);
    h.loadCtx.mockResolvedValue({ createShopClient });
    const scheduler: ShopeeTaskScheduler = { enqueue: c.enqueue };

    const r = await runShopeeArranjoAutomaticoSweep(asDb(c.db), {
      scheduler,
      nowMs: AGORA_MS,
      logger: { warn: () => {} },
    });

    expect(h.loadCtx).toHaveBeenCalledTimes(1);
    expect(h.loadCtx.mock.calls[0]?.[1]).toBe(INT_A);
    expect(createShopClient).toHaveBeenCalledTimes(1);
    expect(c.busca).toHaveBeenCalledTimes(1);
    expect(r.contas[0]?.error).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                         a autorização morta (S1-2)                          */
/* -------------------------------------------------------------------------- */

describe('a conta cuja renovação o token store carimbou TERMINAL (S1-2)', () => {
  it('é CONTADA em `reconexaoPendente`, sem cliente e sem chamada — e fora de `contas`; as outras seguem', async () => {
    const c = cenario();
    semearConta(c, INT_A, SHOP_A);
    semearConta(c, INT_B, SHOP_B);
    semearCredencial(c, INT_A, { em: 1_000, codigo: 'refresh_token_expired', terminal: true });
    const clientFor = vi.fn((_db: Firestore, _id: string) => Promise.resolve(c.client));

    const r = await rodar(c, { clientFor });

    expect(r.reconexaoPendente).toBe(1);
    expect(clientFor.mock.calls.map(([, id]) => id)).toEqual([INT_B]);
    expect(r.contas.map((x) => x.integracaoId)).toEqual([INT_B]);
    expect(c.busca).toHaveBeenCalledTimes(1);
    // ONE read of the fixed `current` document, and no write: the sweep never touches the stamp.
    expect(c.db.opLog.filter((o) => o.path === caminhoDaCredencial(INT_A))).toEqual([
      { op: 'get', path: caminhoDaCredencial(INT_A) },
    ]);
    expect(c.db.writes).toEqual([]);
    expect(c.logs).toEqual([]);
  });

  it('o caminho PADRÃO também: o contexto da conta morta nem é carregado', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    semearCredencial(c, INT_A, { em: 1_000, codigo: 'refresh_token_expired', terminal: true });

    const r = await runShopeeArranjoAutomaticoSweep(asDb(c.db), {
      scheduler: { enqueue: c.enqueue },
      nowMs: AGORA_MS,
      logger: { warn: () => {} },
    });

    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(r).toMatchObject({ reconexaoPendente: 1, contas: [] });
  });

  // ⚠️ The near-misses go through the token store's OWN reader (`falhaRefreshOf`):
  // a transient stamp, a malformed one and none at all are all WALKED.
  it.each<[string, unknown]>([
    ['NÃO terminal (um limite)', { em: 1_000, codigo: 'error_rate_limit', terminal: false }],
    [
      'malformado (`terminal: "true"`)',
      { em: 1_000, codigo: 'refresh_token_expired', terminal: 'true' },
    ],
    ['ausente (`null`, o que um reconsentimento grava)', null],
  ])('quase-igual: um carimbo %s ⇒ a conta é varrida', async (_caso, carimbo) => {
    const c = cenario();
    semearConta(c, INT_A);
    semearCredencial(c, INT_A, carimbo);

    const r = await rodar(c);

    expect(r.reconexaoPendente).toBe(0);
    expect(r.contas.map((x) => x.integracaoId)).toEqual([INT_A]);
    expect(c.busca).toHaveBeenCalledTimes(1);
  });

  it('sem documento de credencial a conta é varrida (o cliente decide — `ShopeeSemCredencialError` é contido)', async () => {
    const c = cenario();
    semearConta(c, INT_A);

    const r = await rodar(c);

    expect(r.reconexaoPendente).toBe(0);
    expect(c.busca).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                            o prazo do tick (S1-6)                           */
/* -------------------------------------------------------------------------- */

describe('o prazo do tick (S1-6) — no relógio DECORRIDO, injetado', () => {
  /** Three contas with a shop id, A → B → C in enumeration order. */
  function tresContas(): Cenario {
    const c = cenario();
    semearConta(c, INT_A, SHOP_A);
    semearConta(c, INT_B, SHOP_B);
    semearConta(c, INT_C, SHOP_C);
    return c;
  }

  /** An elapsed clock answering `leituras` in order — and failing loudly past them. */
  function relogio(leituras: number[]): () => number {
    const fila = [...leituras];
    return () => {
      const v = fila.shift();
      if (v === undefined)
        throw new Error('o relógio decorrido foi lido mais vezes que o previsto');
      return v;
    };
  }

  it('é 200 s — abaixo dos 240 s do `timeoutSeconds`', () => {
    expect(PRAZO_DO_TICK_ARRANJO_MS).toBe(200_000);
  });

  it('a 199 999 ms uma conta ainda COMEÇA (o quase-igual); a EXATAMENTE 200 000 nenhuma mais — truncado, um warn, e o resto nem é lido', async () => {
    const c = tresContas();
    const clientFor = vi.fn((_db: Firestore, _id: string) => Promise.resolve(c.client));
    // ⚠️ Far from `nowMs` on purpose: the budget is ELAPSED time, never `nowMs + budget`.
    const BASE = 9_000_000_000_000;

    const r = await rodar(c, {
      clientFor,
      agoraMs: relogio([BASE, BASE, BASE + 199_999, BASE + 200_000]),
    });

    expect(clientFor.mock.calls.map(([, id]) => id)).toEqual([INT_A, INT_B]);
    expect(r.contas.map((x) => x.integracaoId)).toEqual([INT_A, INT_B]);
    expect(r.interrompidoPorPrazo).toBe(true);
    expect(r.interrompidoPorLimite).toBeNull();
    expect(c.logs).toEqual([
      {
        msg: '[shopee/arranjo-automatico] prazo do tick esgotado — contas restantes não varridas',
        meta: { decorridoMs: 200_000, contasNaoVarridas: 1 },
      },
    ]);
    // C was never STARTED: not even its credential was read.
    expect(c.db.caminhos).not.toContain(caminhoDaCredencial(INT_C));
  });

  it('dentro do prazo, todas as contas são varridas e nada é truncado', async () => {
    const c = tresContas();
    const BASE = 9_000_000_000_000;

    const r = await rodar(c, {
      agoraMs: relogio([BASE, BASE + 1, BASE + 2, BASE + 199_999]),
    });

    expect(r.contas).toHaveLength(3);
    expect(r.interrompidoPorPrazo).toBe(false);
    expect(c.logs).toEqual([]);
  });

  it('o prazo NUNCA é medido contra `nowMs`: um `nowMs` de meses atrás não trunca nada (o relógio padrão)', async () => {
    const c = tresContas();

    // `nowMs` is AGORA_MS (2025-12-29); the default elapsed clock is the real one.
    const r = await rodar(c, { nowMs: AGORA_MS - 365 * DIA_MS });

    expect(r.contas).toHaveLength(3);
    expect(r.interrompidoPorPrazo).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                     linhas ilegíveis não são silêncio (S1-3)                 */
/* -------------------------------------------------------------------------- */

describe('linhas ilegíveis ou ausentes ⇒ UM warn por conta, só contagens (S1-3)', () => {
  it('busca ilegível + detalhe ilegível + ausente + canal desconhecido ⇒ exatamente um warn, sem id de pacote', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);
    naShopee(c, pacoteN(3), { logistics_channel_id: null });
    // The detail answers TWO rows that name no package — the schema's sentinel
    // and a `-` number (this wire's absence sentinel) — omits both PACOTE and
    // PACOTE_2 by name, and names OFG…3 with no channel.
    c.detalhe.mockImplementationOnce(() =>
      Promise.resolve(
        shopeePackageDetailPayloadSchema.parse({
          package_list: [
            { order_sn: '' },
            { ...c.pacotes.get(pacoteN(3)), package_number: '-' },
            c.pacotes.get(pacoteN(3)),
          ],
        }),
      ),
    );
    c.busca.mockResolvedValueOnce(
      pagina([null, linhaBusca(PACOTE), linhaBusca(PACOTE_2), linhaBusca(pacoteN(3))]),
    );

    const r = unica(await rodar(c));

    expect(c.enqueue).not.toHaveBeenCalled();
    expect(c.logs).toEqual([
      {
        msg: '[shopee/arranjo-automatico] linhas ilegíveis ou ausentes — pacotes não avaliados',
        meta: {
          integracaoId: INT_A,
          ilegiveisNaBusca: 1,
          ilegiveisNoDetalhe: 2,
          ausentesNoDetalhe: 2,
          canalDesconhecidoNoDetalhe: 1,
        },
      },
    ]);
    expect(JSON.stringify(c.logs)).not.toContain('OFG');
    esperarParticao(r);
  });

  it('quase-igual: um tick de linhas todas legíveis não loga nada', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);
    naShopee(c, PACOTE);
    c.busca.mockResolvedValueOnce(pagina([linhaBusca(PACOTE)]));

    await rodar(c);

    expect(c.enqueue).toHaveBeenCalledTimes(1);
    expect(c.logs).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                            zero escritas, zero PII                          */
/* -------------------------------------------------------------------------- */

describe('o que o tick NUNCA faz', () => {
  it('escreve NADA no Firestore — só lê (contas e existência de pedido)', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);
    naShopee(c, PACOTE);
    naShopee(c, PACOTE_2, { order_sn: ORDER_SN_2 });
    c.busca.mockResolvedValueOnce(
      pagina([linhaBusca(PACOTE), linhaBusca(PACOTE_2, { order_sn: ORDER_SN_2 })]),
    );

    await rodar(c);

    expect(c.enqueue).toHaveBeenCalledTimes(2);
    expect(c.db.writes).toEqual([]);
    expect(c.db.patches).toEqual([]);
    expect(c.db.opLog.every((o) => o.op === 'get')).toBe(true);
  });

  it('nenhum order_sn nem package number chega a um argumento de log ou ao resultado — nem o texto da Shopee', async () => {
    const c = cenario();
    semearConta(c, INT_A, SHOP_A);
    semearConta(c, INT_B, SHOP_B);
    semearPedido(c, INT_B, ORDER_SN_2);
    naShopee(c, PACOTE_2, { order_sn: ORDER_SN_2 });
    // Conta A: a detail refusal whose Shopee message QUOTES the package and the
    // order — a contained failure, and a warn.
    const recusa = apiError('error_param', {
      providerMessage: `package_number ${PACOTE} of order ${ORDER_SN} is invalid`,
    });
    // The positive control: the thrown error really does carry both ids.
    expect(recusa.message).toContain(PACOTE);
    expect(recusa.message).toContain(ORDER_SN);
    c.busca.mockResolvedValueOnce(pagina([linhaBusca(PACOTE)]));
    c.detalhe.mockRejectedValueOnce(recusa);
    // Conta B: a `more` without a cursor (a warn), an off-channel row (a warn)
    // and a real enqueue.
    c.busca.mockResolvedValueOnce(
      pagina(
        [
          linhaBusca(PACOTE_2, { order_sn: ORDER_SN_2 }),
          linhaBusca(PACOTE, { logistics_channel_id: CANAL_FORA }),
        ],
        { total_count: 9, more: true, next_cursor: '' },
      ),
    );

    const r = await rodar(c);

    expect(c.logs.map((l) => l.msg)).toEqual([
      '[shopee/arranjo-automatico] conta contida após falha',
      '[shopee/arranjo-automatico] more=true sem next_cursor — conta truncada',
      '[shopee/arranjo-automatico] linhas FORA do filtro de canal',
    ]);
    expect(c.enqueue).toHaveBeenCalledTimes(1);
    expect(r.contas[0]?.error).toBe('ShopeeApiError: error_param');
    const texto = JSON.stringify([c.logs, r]);
    for (const segredo of [ORDER_SN, ORDER_SN_2, PACOTE, PACOTE_2]) {
      expect(texto).not.toContain(segredo);
    }
  });

  it('o logger PADRÃO (console.warn) também só recebe ids e contagens', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = cenario();
    semearConta(c, INT_A);
    c.busca.mockResolvedValueOnce(
      pagina([linhaBusca(PACOTE, { logistics_channel_id: CANAL_FORA })], {
        total_count: 1,
        more: true,
        next_cursor: null,
      }),
    );
    const scheduler: ShopeeTaskScheduler = { enqueue: c.enqueue };

    await runShopeeArranjoAutomaticoSweep(asDb(c.db), {
      scheduler,
      nowMs: AGORA_MS,
      clientFor: () => Promise.resolve(c.client),
    });

    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PACOTE);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(ORDER_SN);
  });

  it('as partições dos contadores fecham num tick misto — com TODOS os contadores, os novos incluídos', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);
    naShopee(c, pacoteN(1));
    naShopee(c, pacoteN(2), { invoice_pending: { status: 'pending', pending_reason: 'x' } });
    naShopee(c, pacoteN(3), { logistics_channel_id: 90025 });
    naShopee(c, pacoteN(5), { logistics_channel_id: null });
    // An order with NO pedido whose import already failed today.
    naShopee(c, pacoteN(6), { order_sn: ORDER_SN_2 });
    c.db.seed(caminhoDaFalhaDoPedido(ORDER_SN_2, DIA_DE_AGORA_MS), { status: 'parked' });
    c.busca
      .mockResolvedValueOnce(
        pagina(
          [
            null,
            linhaBusca(pacoteN(1)),
            linhaBusca(pacoteN(1)),
            linhaBusca(pacoteN(9), { is_shipment_arranged: true }),
            linhaBusca(pacoteN(8), { logistics_channel_id: CANAL_FORA }),
          ],
          { total_count: 10, more: true, next_cursor: 'p2' },
        ),
      )
      .mockResolvedValueOnce(
        pagina([
          linhaBusca(pacoteN(2)),
          linhaBusca(pacoteN(3), { logistics_channel_id: null }),
          linhaBusca(pacoteN(4)),
          linhaBusca(pacoteN(5)),
          linhaBusca(pacoteN(6), { order_sn: ORDER_SN_2 }),
        ]),
      );

    const r = unica(await rodar(c));

    expect(r).toEqual({
      integracaoId: INT_A,
      paginasLidas: 2,
      totalInformado: 10,
      linhas: 10,
      ilegiveisNaBusca: 1,
      duplicadas: 1,
      jaArranjadosNaBusca: 1,
      foraDoCanal: 1,
      consultadosNoDetalhe: 6,
      ausentesNoDetalhe: 1,
      ilegiveisNoDetalhe: 0,
      foraDoCanalNoDetalhe: 1,
      canalDesconhecidoNoDetalhe: 1,
      naoConsultadosPeloLimite: 0,
      fases: { ...FASES_ZERO, programar: 2, 'nfe-pendente': 1 },
      nfePendenteNaBusca: 1,
      enfileiradosPacote: 1,
      enfileiradosPedido: 0,
      pedidosComFalhaHoje: 1,
      pacotesComFalhaHoje: 0,
      truncada: false,
      truncadaPor: null,
      error: null,
    });
    esperarParticao(r);
  });
});

/* -------------------------------------------------------------------------- */
/*                         uma cópia só da elegibilidade                        */
/* -------------------------------------------------------------------------- */

describe('o sweep não reimplementa nada (pinos de texto cru)', () => {
  const fonte = readFileSync(
    fileURLToPath(new URL('./arranjoAutomaticoSweep.ts', import.meta.url)),
    'utf8',
  );
  // The CODE alone: the docblocks may (and do) name the wire fields they explain.
  const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('decide pela elegibilidade COMPARTILHADA, sobre a projeção compartilhada — e por nada além dela', () => {
    const chamada = 'elegibilidadeDoArranjoAutomatico(observacaoDoPacoteShopee(linha))';
    expect(codigo.split(chamada).length - 1).toBe(1);
    // Non-vacuity: the stripping kept the code it is about to scan.
    expect(codigo).toContain('client.getPackageDetail(');
    // None of the ladder's own parts appears in the code: no phase function, no
    // invoice fold, no token, no hold (mutant 99).
    for (const proibido of [
      'fasePacote(',
      'faseDoTokenShopee(',
      'faseTemPortaoDeNfe(',
      'invoice_pending',
      'pending_terms',
      'fulfillment_status',
      "'LOGISTICS_",
      'decidirArranjoAutomatico(',
    ]) {
      expect(codigo).not.toContain(proibido);
    }
  });

  it('lê UMA variável de ambiente (a sua) e importa as outras duas válvulas pelos seus leitores', () => {
    expect(codigo.split('process.env').length - 1).toBe(1);
    expect(fonte).toContain("import { arranjoAutomaticoDesligado } from './arranjoAutomatico';");
    expect(fonte).toMatch(
      /import \{ shopeeTasksDesabilitado, type ShopeeTaskScheduler \} from '\.\.\/shopeeTasks';/,
    );
  });

  it('UM relógio só — o decorrido do prazo, INJETÁVEL, nunca chamado direto — e sem a API de transação', () => {
    // The stamp is `deps.nowMs`; the one clock the module may hold is the
    // DEFAULT of the injected elapsed reader (S1-6), never a call of its own.
    expect(fonte).not.toContain('Date.now(');
    expect(codigo.split('Date.now').length - 1).toBe(1);
    expect(codigo).toContain('deps.agoraMs ?? Date.now');
    expect(fonte).not.toContain('runTransaction');
  });
});

/* -------------------------------------------------------------------------- */
/*                 RT1 — fixture → schema → cliente REAL → sweep               */
/* -------------------------------------------------------------------------- */

describe('RT1 — a amostra da documentação pelo cliente REAL, até UMA tarefa', () => {
  it('doc fixture (canal reescrito numa CÓPIA) → página 2 pelo cursor composto → resposta vazia do SG → detalhe → um code 30', async () => {
    // The doc sample, parsed by the corpus loader only to READ its ids.
    const doc = lerBuscaDePacotes(FIXTURE_SEARCH_PACKAGE_LIST_DOC).response;
    const linhaDoc = doc.packages_list[0];
    const cursorDoc = doc.pagination?.next_cursor;
    if (linhaDoc == null || cursorDoc == null)
      throw new Error('a amostra mudou: sem linha ou sem cursor');
    expect(doc.pagination?.more).toBe(true);

    // ⚠️ A COPY with the VN channel rewritten to a Turbo one — never the file.
    const original = JSON.stringify(lerFixture(FIXTURE_SEARCH_PACKAGE_LIST_DOC));
    const copia = original.replace('"logistics_channel_id":50021', '"logistics_channel_id":90011');
    expect(copia).not.toBe(original);
    const pagina1: unknown = JSON.parse(copia);
    const pagina2: unknown = lerFixture(FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_TURBO);
    const detalhe = {
      error: '',
      message: '',
      response: {
        package_list: [
          {
            order_sn: linhaDoc.order_sn,
            package_number: linhaDoc.package_number,
            fulfillment_status: 'LOGISTICS_READY',
            logistics_channel_id: 90011,
            is_shipment_arranged: false,
            pending_terms: [],
            invoice_pending: { status: 'valid', pending_reason: '' },
          },
        ],
      },
    };

    const { client, caminhos, corpos, corposBrutos } = clienteReal([pagina1, pagina2, detalhe]);

    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, linhaDoc.order_sn);
    const r = unica(await rodar(c, { clientFor: () => Promise.resolve(client) }));

    expect(caminhos).toEqual([
      '/api/v2/order/search_package_list',
      '/api/v2/order/search_package_list',
      '/api/v2/order/get_package_detail',
    ]);
    // Page 1 carries no cursor; page 2 carries the doc's composite one VERBATIM.
    // ⚠️ The BYTES, not only the shape: `toEqual` ignores key order, and the
    // reconcile (§2.10) freezes the sweep's request byte for byte — this is the
    // sweep's own request object through the real serialiser, end to end.
    expect(corposBrutos[0]).toBe(
      '{"filter":{"package_status":2,"fulfillment_type":2,"invoice_pending":false,"logistics_channel_ids":[90011,90012,90026]},"pagination":{"page_size":100},"sort":{"sort_type":1,"ascending":true}}',
    );
    expect(corpos[0]).toEqual({
      filter: {
        package_status: 2,
        fulfillment_type: 2,
        invoice_pending: false,
        logistics_channel_ids: [90011, 90012, 90026],
      },
      pagination: { page_size: 100 },
      sort: { sort_type: 1, ascending: true },
    });
    expect(corpos[1]).toMatchObject({ pagination: { page_size: 100, cursor: cursorDoc } });
    // …and page 2 BYTE for byte too (S2-4): the same request with the doc's
    // composite cursor VERBATIM inside `pagination`, after `page_size`.
    expect(cursorDoc).toBe('1730437200,184066343203459');
    expect(corposBrutos[1]).toBe(
      '{"filter":{"package_status":2,"fulfillment_type":2,"invoice_pending":false,"logistics_channel_ids":[90011,90012,90026]},"pagination":{"page_size":100,"cursor":"1730437200,184066343203459"},"sort":{"sort_type":1,"ascending":true}}',
    );
    expect(c.enqueue).toHaveBeenCalledTimes(1);
    expect(enfileirado(c, 0)).toEqual({
      code: 30,
      shopId: SHOP_A,
      timestamp: DIA_DE_AGORA_MS,
      data: {
        ordersn: linhaDoc.order_sn,
        package_number: linhaDoc.package_number,
        origem: 'arranjo-automatico',
      },
    });
    expect(r).toMatchObject({ paginasLidas: 2, totalInformado: 320, truncada: false });
  });
});

/* -------------------------------------------------------------------------- */
/*            as lacunas da mutação (review 3b S4: R07, R13, R14, R27, R35)     */
/* -------------------------------------------------------------------------- */

describe('as lacunas da mutação do review 3b', () => {
  // R07: first-wins AGREES with the handler, whose lookup is a `.find` (the
  // first match) — the pin keeps the two from deciding on different rows.
  it('G1 — o MESMO pacote duas vezes na resposta do detalhe: a PRIMEIRA linha decide', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);
    naShopee(c, PACOTE);
    const fresca = c.pacotes.get(PACOTE);
    c.detalhe.mockImplementationOnce(() =>
      Promise.resolve(
        shopeePackageDetailPayloadSchema.parse({
          package_list: [fresca, { ...fresca, is_shipment_arranged: true }],
        }),
      ),
    );
    c.busca.mockResolvedValueOnce(pagina([linhaBusca(PACOTE)]));

    const r = unica(await rodar(c));

    expect(c.enqueue).toHaveBeenCalledTimes(1);
    expect(r.fases).toMatchObject({ programar: 1, arranjado: 0 });
    esperarParticao(r);
  });

  // R13: the OUTER cap's `??=` — a page cap that already cut the list stays the cause.
  it('G2 — o teto de PÁGINAS que já cortou a lista continua a causa quando o de ENFILEIRADOS chega ENTRE lotes', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);
    let n = 0;
    c.busca.mockImplementation(() => {
      const linhas = Array.from({ length: 31 }, () => {
        n += 1;
        naShopee(c, pacoteN(n));
        return linhaBusca(pacoteN(n));
      });
      return Promise.resolve(
        pagina(linhas, { total_count: 999, more: true, next_cursor: `c${String(n)}` }),
      );
    });

    const r = unica(await rodar(c));

    expect(c.busca).toHaveBeenCalledTimes(5);
    expect(lotesDoDetalhe(c).map((l) => l.length)).toEqual([50, 50]);
    expect(c.enqueue).toHaveBeenCalledTimes(100);
    expect(r.truncadaPor).toBe(TRUNCAGEM_ARRANJO.paginas);
    esperarParticao(r);
  });

  // R14: the INNER cap's `??=`, the same promise one level down.
  it('G3 — …e quando o de ENFILEIRADOS chega NO MEIO de um lote', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);
    let n = 0;
    c.busca.mockImplementation(() => {
      const linhas = Array.from({ length: 30 }, () => {
        n += 1;
        // The first 10 are arranged on the FRESH row: the 100th enqueue lands mid-lot.
        naShopee(c, pacoteN(n), { is_shipment_arranged: n <= 10 });
        return linhaBusca(pacoteN(n));
      });
      return Promise.resolve(
        pagina(linhas, { total_count: 999, more: true, next_cursor: `c${String(n)}` }),
      );
    });

    const r = unica(await rodar(c));

    expect(lotesDoDetalhe(c).map((l) => l.length)).toEqual([50, 50, 50]);
    expect(c.enqueue).toHaveBeenCalledTimes(100);
    expect(r.truncadaPor).toBe(TRUNCAGEM_ARRANJO.paginas);
    esperarParticao(r);
  });

  // R27: every unread lot is counted, not only the next one.
  it('G4 — DOIS ou mais lotes não lidos depois do teto: todos contam em naoConsultadosPeloLimite', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);
    const numeros = Array.from({ length: 250 }, (_, i) => pacoteN(i + 1));
    for (const n of numeros) naShopee(c, n);
    c.busca.mockResolvedValueOnce(pagina(numeros.map((n) => linhaBusca(n))));

    const r = unica(await rodar(c));

    expect(lotesDoDetalhe(c).map((l) => l.length)).toEqual([50, 50]);
    expect(r.naoConsultadosPeloLimite).toBe(150);
    esperarParticao(r);
  });

  // R35: the truncation was asserted, its warn was not.
  it('G5 — linhas sem `pagination` ⇒ UM warn, com id e contagens só', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    c.busca.mockResolvedValueOnce(
      paginaSemPaginacao([linhaBusca(PACOTE, { is_shipment_arranged: true })]),
    );

    await rodar(c);

    expect(c.logs).toEqual([
      {
        msg: '[shopee/arranjo-automatico] página sem paginação — conta truncada',
        meta: { integracaoId: INT_A, paginasLidas: 1 },
      },
    ]);
  });
});
