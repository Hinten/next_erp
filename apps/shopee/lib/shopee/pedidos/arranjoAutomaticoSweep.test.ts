import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { integracaoCollection, pedidoCollection } from '@delfrance/data/admin/collections';
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
const INTEGRACAO_PATH = integracaoCollection.resolvePath({});
const PEDIDO_PATH = pedidoCollection.resolvePath({});
const INT_A = 'int-1';
const INT_B = 'int-2';
const INT_SEM_SHOP = 'int-sem-shop';
const SHOP_A = 987654;
const SHOP_B = 987655;
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
  expect(r.consultadosNoDetalhe).toBe(r.ausentesNoDetalhe + r.foraDoCanalNoDetalhe + somaFases);
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
        interrompidoPorLimite: null,
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

  it('o número é comparado APARADO (o par) — e um número diferente continua ausente (o quase-igual)', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);
    // Shopee pads the number on the DETAIL side too: still the same package.
    naShopee(c, PACOTE, { package_number: `  ${PACOTE} ` });
    // `' OFG…1 '` and `'OFG…1'` are ONE package (a duplicate); OFG…2 is not OFG…1.
    c.busca.mockResolvedValueOnce(
      pagina([linhaBusca(` ${PACOTE} `), linhaBusca(PACOTE), linhaBusca(PACOTE_2)]),
    );

    const r = unica(await rodar(c));

    expect(lotesDoDetalhe(c)).toEqual([[PACOTE, PACOTE_2]]);
    expect(r.duplicadas).toBe(1);
    expect(r.ausentesNoDetalhe).toBe(1);
    expect(r.enfileiradosPacote).toBe(1);
    // The code 30 carries the ONE trimmed spelling — its identity is a string.
    const p = enfileirado(c, 0);
    expect(p.data?.package_number).toBe(PACOTE);
    expect(dedupKeyOf(p)).toBe(`30:${String(SHOP_A)}:${PACOTE}`);
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
      timestamp: AGORA_MS,
      data: { ordersn: ORDER_SN, package_number: PACOTE, origem: 'arranjo-automatico' },
    });
    expect(Object.keys(p.data ?? {}).sort()).toEqual(['ordersn', 'origem', 'package_number']);
    expect(docIdOf(p)).toBe(`30:${String(SHOP_A)}:${PACOTE}:${String(AGORA_MS)}`);
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

    expect(c.enqueue.mock.calls.map(([p]) => p)).toEqual([
      {
        code: 3,
        shopId: SHOP_A,
        timestamp: AGORA_MS,
        data: { ordersn: ORDER_SN, origem: 'arranjo-automatico' },
      },
      {
        code: 3,
        shopId: SHOP_A,
        timestamp: AGORA_MS,
        data: { ordersn: ORDER_SN_2, origem: 'arranjo-automatico' },
      },
    ]);
    expect(r).toMatchObject({ enfileiradosPacote: 0, enfileiradosPedido: 2 });
    expect(r.fases.programar).toBe(3);
    const leituras = c.db.opLog.filter((o) => o.path === caminhoDoPedido(INT_A, ORDER_SN));
    expect(leituras).toEqual([{ op: 'get', path: caminhoDoPedido(INT_A, ORDER_SN) }]);
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
    [
      'gRPC no enqueue (Cloud Tasks)',
      () => grpc(14, 'UNAVAILABLE'),
      'enqueue',
      'Error: UNAVAILABLE',
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

  it('as partições dos contadores fecham num tick misto', async () => {
    const c = cenario();
    semearConta(c, INT_A);
    semearPedido(c, INT_A, ORDER_SN);
    naShopee(c, pacoteN(1));
    naShopee(c, pacoteN(2), { invoice_pending: { status: 'pending', pending_reason: 'x' } });
    naShopee(c, pacoteN(3), { logistics_channel_id: 90025 });
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
          { total_count: 8, more: true, next_cursor: 'p2' },
        ),
      )
      .mockResolvedValueOnce(
        pagina([
          linhaBusca(pacoteN(2)),
          linhaBusca(pacoteN(3), { logistics_channel_id: null }),
          linhaBusca(pacoteN(4)),
        ]),
      );

    const r = unica(await rodar(c));

    expect(r).toMatchObject({
      linhas: 8,
      ilegiveisNaBusca: 1,
      duplicadas: 1,
      jaArranjadosNaBusca: 1,
      foraDoCanal: 1,
      consultadosNoDetalhe: 4,
      ausentesNoDetalhe: 1,
      foraDoCanalNoDetalhe: 1,
      nfePendenteNaBusca: 1,
      enfileiradosPacote: 1,
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

  it('sem relógio próprio e sem a API de transação (o inventário lê o texto cru)', () => {
    expect(fonte).not.toContain('Date.now(');
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
    expect(c.enqueue).toHaveBeenCalledTimes(1);
    expect(enfileirado(c, 0)).toEqual({
      code: 30,
      shopId: SHOP_A,
      timestamp: AGORA_MS,
      data: {
        ordersn: linhaDoc.order_sn,
        package_number: linhaDoc.package_number,
        origem: 'arranjo-automatico',
      },
    });
    expect(r).toMatchObject({ paginasLidas: 2, totalInformado: 320, truncada: false });
  });
});
