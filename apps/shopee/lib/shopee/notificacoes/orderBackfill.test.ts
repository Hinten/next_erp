import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_ORDER_LIST_MAX_WINDOW_SECONDS,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeSchemaError,
  type GetOrderListParams,
  type ShopeeClient,
  type ShopeeOrderList,
} from '@delfrance/integrations-shopee';

import { type DocData, FakeDb, asDb, grpc } from '../testing/fakeDb';
import { ShopeeCredencialInvalidaError } from '../core/credentialStore';
import { ShopeeContaNotConfiguredError } from '../core/shopee';
import {
  ShopeeContaSemShopIdError,
  ShopeeRefreshEmAndamentoError,
  ShopeeSemCredencialError,
} from '../core/tokenStore';
import { ShopeeTasksDisabledError, type ShopeeTaskScheduler } from '../shopeeTasks';
import {
  dedupKeyOf,
  docIdOf,
  type DestinoPush,
  type ShopeeNotificationPayload,
} from './notificacao';
import {
  INITIAL_LOOKBACK_MS,
  MAX_PAGES_PER_TICK,
  MOTIVO_CODE3_PARADO,
  MOTIVO_FLAG_DESLIGADA,
  MOTIVO_JANELA_DEGENERADA,
  MOTIVO_MORE_SEM_CURSOR,
  MOTIVO_SEM_SHOP_ID,
  OVERLAP_MS,
  PAGE_SIZE,
  SHOPEE_ORDER_BACKFILL_FLAG_ENV,
  runShopeeOrderBackfill,
} from './orderBackfill';

/* -------------------------------------------------------------------------- */
/*  The structural gate is MOCKED, not neutralised                            */
/*                                                                            */
/*  `runShopeeOrderBackfill` refuses while `destinoDoCodigo(3) === 'parado'`,  */
/*  which is the table's state TODAY — so almost every test here has to say    */
/*  "pretend step 5 landed". The mock is PARTIAL: `dedupKeyOf`/`docIdOf` and   */
/*  every other export stay the real ones, because the identity of the         */
/*  synthesized push is exactly what several tests assert.                    */
/*                                                                            */
/*  ⚠️ ONE test deliberately does NOT override it and reads the REAL table.   */
/* -------------------------------------------------------------------------- */

let destinoDoCodigo3: DestinoPush | null = null;

vi.mock('./notificacao', async () => {
  const real = await vi.importActual<typeof import('./notificacao')>('./notificacao');
  return {
    ...real,
    destinoDoCodigo: (code: number): DestinoPush =>
      code === 3 && destinoDoCodigo3 !== null ? destinoDoCodigo3 : real.destinoDoCodigo(code),
  };
});

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented values only. No real partner id, key or shop id.      */
/* -------------------------------------------------------------------------- */

const AGORA_MS = 1_760_000_000_000;
const SEGUNDO_MS = 1000;
const MINUTO_MS = 60 * SEGUNDO_MS;
const HORA_MS = 60 * MINUTO_MS;
const DIA_MS = 24 * HORA_MS;

const INTEGRACAO_PATH = integracaoCollection.resolvePath({});
const CURSOR_PATH = 'backfillPedidosShopee';
const INT_A = 'int-1';
const INT_B = 'int-2';
const SHOP_A = 987654;
const SHOP_B = 987655;

function contaDoc(over: DocData = {}): DocData {
  return { tipo: INTEGRACAO_TIPO.shopee, ativo: true, nome: 'Loja BR', shop_id: SHOP_A, ...over };
}

/** One `get_order_list` page. `next_cursor` defaults to Shopee's drained `''`. */
function pagina(
  ordens: (string | { order_sn: string; order_status?: string | null })[],
  more: boolean,
  nextCursor = '',
): ShopeeOrderList {
  return {
    more,
    next_cursor: nextCursor,
    order_list: ordens.map((o) =>
      typeof o === 'string'
        ? { order_sn: o, order_status: null, booking_sn: null }
        : { order_sn: o.order_sn, order_status: o.order_status ?? null, booking_sn: null },
    ),
  } as ShopeeOrderList;
}

function apiError(code: string): ShopeeApiError {
  return new ShopeeApiError(`shopee recusou: ${code}`, {
    code,
    kind: SHOPEE_ERROR_KIND.other,
    httpStatus: 200,
    path: '/api/v2/order/get_order_list',
  });
}

type GetOrderListMock = Mock<(p: GetOrderListParams) => Promise<ShopeeOrderList>>;
type EnqueueMock = Mock<(p: ShopeeNotificationPayload) => Promise<void>>;

interface Cenario {
  db: FakeDb;
  getOrderList: GetOrderListMock;
  /** Per-conta client override — the default answers `getOrderList` above. */
  clientPor: Map<string, ShopeeClient>;
  enqueue: EnqueueMock;
}

function cenario(): Cenario {
  const db = new FakeDb();
  const getOrderList: GetOrderListMock = vi.fn();
  const enqueue: EnqueueMock = vi.fn(() => Promise.resolve());
  const clientPor = new Map<string, ShopeeClient>();
  return { db, getOrderList, enqueue, clientPor };
}

function rodar(c: Cenario, over: { nowMs?: number } = {}) {
  const scheduler: ShopeeTaskScheduler = { enqueue: c.enqueue };
  return runShopeeOrderBackfill(asDb(c.db), {
    scheduler,
    nowMs: over.nowMs ?? AGORA_MS,
    logger: { warn: () => {} },
    clientFor: (_db, integracaoId) =>
      Promise.resolve(
        c.clientPor.get(integracaoId) ??
          ({ getOrderList: c.getOrderList } as unknown as ShopeeClient),
      ),
  });
}

/** The `getOrderList` params of call `n` (0-based). Throws rather than reading
 *  `undefined` fields off a call that never happened — a vacuous pass. */
function chamada(c: Cenario, n: number): GetOrderListParams {
  const p = c.getOrderList.mock.calls[n]?.[0];
  if (p === undefined) throw new Error(`getOrderList não foi chamado ${String(n + 1)} vez(es)`);
  return p;
}

/** The payload of enqueue call `n` (0-based), or a loud failure. */
function enfileirado(c: Cenario, n: number): ShopeeNotificationPayload {
  const p = c.enqueue.mock.calls[n]?.[0];
  if (p === undefined) throw new Error(`enqueue não foi chamado ${String(n + 1)} vez(es)`);
  return p;
}

/** The last patch merged onto a conta's cursor document. */
function ultimoPatch(db: FakeDb, integracaoId: string): DocData | undefined {
  const path = `${CURSOR_PATH}/${integracaoId}`;
  const meus = db.writes.filter((w) => w.path === path);
  return meus[meus.length - 1]?.patch;
}

beforeEach(() => {
  destinoDoCodigo3 = 'conta'; // "pretend step 5 landed" — see the block above.
  process.env[SHOPEE_ORDER_BACKFILL_FLAG_ENV] = '1';
});

afterEach(() => {
  destinoDoCodigo3 = null;
  delete process.env[SHOPEE_ORDER_BACKFILL_FLAG_ENV];
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */

describe('runShopeeOrderBackfill — a flag', () => {
  it('flag desligada ⇒ nada é lido (nem Firestore, nem Shopee) e motivo é "flag-desligada"', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    delete process.env[SHOPEE_ORDER_BACKFILL_FLAG_ENV];

    const r = await rodar(c);

    expect(r).toEqual({ enabled: false, motivo: MOTIVO_FLAG_DESLIGADA, semShopId: 0, contas: [] });
    expect(c.db.caminhos).toEqual([]);
    expect(c.getOrderList).not.toHaveBeenCalled();
    expect(c.enqueue).not.toHaveBeenCalled();
  });

  it('qualquer valor diferente do literal "1" mantém a varredura desligada', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());

    for (const valor of ['', ' ', '0', 'true', 'TRUE', 'yes', '1 ', '01']) {
      process.env[SHOPEE_ORDER_BACKFILL_FLAG_ENV] = valor;
      const r = await rodar(c);
      expect(r.enabled, `valor ${JSON.stringify(valor)}`).toBe(false);
      expect(r.motivo).toBe(MOTIVO_FLAG_DESLIGADA);
    }
    expect(c.db.caminhos).toEqual([]);
  });
});

describe('runShopeeOrderBackfill — o guarda estrutural do code 3', () => {
  it('flag ligada mas code 3 PARADO ⇒ nada é lido, motivo "code 3 sem handler"', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    destinoDoCodigo3 = 'parado';

    const r = await rodar(c);

    expect(r).toEqual({ enabled: false, motivo: MOTIVO_CODE3_PARADO, semShopId: 0, contas: [] });
    expect(c.db.caminhos).toEqual([]);
    expect(c.getOrderList).not.toHaveBeenCalled();
  });

  it('⚠️ o guarda É o DISPATCH: hoje destinoDoCodigo(3) === "parado" — ESTE TESTE VIRA NO PASSO 5', async () => {
    // ⚠️ When step 5 gives push code 3 a handler, `DISPATCH[3]` stops being
    // `'parado'` and this assertion INVERTS — the sweep starts running on the
    // real table. Flip it (and `MOTIVO_PARADO[3]`) in that same commit; do NOT
    // delete this test: it is the only thing that reads the REAL dispatch
    // table here, and without it the mock above would let the guard rot into a
    // constant `false`.
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    destinoDoCodigo3 = null; // the real table, unmocked

    const r = await rodar(c);

    expect(r.enabled).toBe(false);
    expect(r.motivo).toBe(MOTIVO_CODE3_PARADO);
    expect(c.getOrderList).not.toHaveBeenCalled();
  });

  it('com um handler para o code 3, a varredura roda normalmente', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.getOrderList.mockResolvedValue(pagina(['SN1'], false));

    const r = await rodar(c);

    expect(r.enabled).toBe(true);
    expect(r.motivo).toBeNull();
    expect(c.getOrderList).toHaveBeenCalledTimes(1);
    expect(c.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('runShopeeOrderBackfill — enumeração', () => {
  it('enumera apenas integrações shopee ATIVAS (tipo + ativo) — o índice já existe', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.db.seed(`${INTEGRACAO_PATH}/inativa`, contaDoc({ ativo: false, shop_id: SHOP_B }));
    c.db.seed(
      `${INTEGRACAO_PATH}/outro-canal`,
      contaDoc({ tipo: INTEGRACAO_TIPO.mercadoLivre, shop_id: SHOP_B }),
    );
    c.getOrderList.mockResolvedValue(pagina(['SN1'], false));

    const r = await rodar(c);

    expect(r.contas.map((x) => x.integracaoId)).toEqual([INT_A]);
  });

  it('uma conta sem shop_id é PULADA com motivo nomeado: nenhuma chamada Shopee e NENHUM documento de cursor escrito', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc({ shop_id: null }));

    const r = await rodar(c);

    expect(r.semShopId).toBe(1);
    expect(r.contas).toEqual([
      expect.objectContaining({
        integracaoId: INT_A,
        shopId: null,
        pulada: MOTIVO_SEM_SHOP_ID,
        error: null,
      }),
    ]);
    expect(c.getOrderList).not.toHaveBeenCalled();
    expect(c.db.writes).toEqual([]);
    // Not even a READ of the cursor doc: it can never get a cursor.
    expect(c.db.caminhos.filter((p) => p.startsWith(CURSOR_PATH))).toEqual([]);
  });

  it('nenhuma conta ativa ⇒ enabled com resumo vazio', async () => {
    const c = cenario();

    const r = await rodar(c);

    expect(r).toEqual({ enabled: true, motivo: null, semShopId: 0, contas: [] });
    expect(c.db.writes).toEqual([]);
  });

  it('nada sob /credenciais/ é lido', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.getOrderList.mockResolvedValue(pagina(['SN1'], false));

    await rodar(c);

    expect(c.db.caminhos.filter((p) => p.includes('/credenciais'))).toEqual([]);
  });
});

describe('runShopeeOrderBackfill — a janela de 15 dias', () => {
  function comConta(c: Cenario, cursorDoc?: DocData): void {
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    if (cursorDoc) c.db.seed(`${CURSOR_PATH}/${INT_A}`, cursorDoc);
    c.getOrderList.mockResolvedValue(pagina([], false));
  }

  it('sem cursor, a primeira janela olha 24 h para trás', async () => {
    const c = cenario();
    comConta(c);

    await rodar(c);

    const p = chamada(c, 0);
    expect(p.timeFromS).toBe(Math.floor((AGORA_MS - INITIAL_LOOKBACK_MS) / 1000));
    expect(p.timeToS).toBe(Math.floor(AGORA_MS / 1000));
    expect(p.timeRangeField).toBe('update_time');
  });

  it('com cursor, a janela começa em cursorMs − OVERLAP_MS', async () => {
    const c = cenario();
    const cursorMs = AGORA_MS - 2 * HORA_MS;
    comConta(c, { cursorMs });

    await rodar(c);

    expect(chamada(c, 0).timeFromS).toBe(Math.floor((cursorMs - OVERLAP_MS) / 1000));
  });

  it('14 d 23 h cabem em UMA janela', async () => {
    const c = cenario();
    const cursorMs = AGORA_MS - (14 * DIA_MS + 23 * HORA_MS);
    comConta(c, { cursorMs });

    await rodar(c);

    const p = chamada(c, 0);
    expect(p.timeToS).toBe(Math.floor(AGORA_MS / 1000));
    expect(p.timeToS - p.timeFromS).toBeLessThan(SHOPEE_ORDER_LIST_MAX_WINDOW_SECONDS);
  });

  it('15 d 1 min é DIVIDIDO: o tick cobre exatamente 15 d (1 296 000 s) e o resto fica para o próximo', async () => {
    const c = cenario();
    const cursorMs = AGORA_MS - (15 * DIA_MS + MINUTO_MS);
    comConta(c, { cursorMs });

    await rodar(c);

    const p = chamada(c, 0);
    // ⚠️ EXACTLY the bound. `to = min(from + 15 d, now)` measured from `from`;
    // `cursor + 15 d` plus the overlap would be 1 296 300 s and Shopee would
    // answer `order.order_list_invalid_time`.
    expect(p.timeToS - p.timeFromS).toBe(1_296_000);
    expect(p.timeToS - p.timeFromS).toBe(SHOPEE_ORDER_LIST_MAX_WINDOW_SECONDS);
    expect(p.timeToS).toBeLessThan(Math.floor(AGORA_MS / 1000));
    // The remainder is what the NEXT tick picks up: the cursor advanced only
    // to this window's upper bound.
    expect(ultimoPatch(c.db, INT_A)?.cursorMs).toBe(cursorMs - OVERLAP_MS + 15 * DIA_MS);
  });

  it('time_from/time_to viajam em SEGUNDOS; o app é quem converte', async () => {
    const c = cenario();
    comConta(c, { cursorMs: AGORA_MS - HORA_MS });

    await rodar(c);

    const p = chamada(c, 0);
    for (const v of [p.timeFromS, p.timeToS]) {
      expect(Number.isInteger(v)).toBe(true);
      // A milliseconds value here would be ~1.76e12 — three orders out.
      expect(v).toBeGreaterThan(1_000_000_000);
      expect(v).toBeLessThan(100_000_000_000);
    }
    expect(p.pageSize).toBe(PAGE_SIZE);
    expect(p.requestOrderStatusPending).toBe(true);
    expect(p.responseOptionalFields).toBe('order_status');
  });

  it('uma janela degenerada (menos de 1 s após o floor) é pulada sem chamar a Shopee', async () => {
    const c = cenario();
    // A cursor from the FUTURE: `from` lands past `now`, so `to === from`.
    comConta(c, { cursorMs: AGORA_MS + OVERLAP_MS + HORA_MS });

    const r = await rodar(c);

    expect(r.contas[0]?.pulada).toBe(MOTIVO_JANELA_DEGENERADA);
    expect(c.getOrderList).not.toHaveBeenCalled();
    expect(c.db.writes).toEqual([]);
  });
});

describe('runShopeeOrderBackfill — paginação por cursor', () => {
  function comConta(c: Cenario, cursorDoc?: DocData): void {
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    if (cursorDoc) c.db.seed(`${CURSOR_PATH}/${INT_A}`, cursorDoc);
  }

  it('pagina enquanto more === true, mandando o next_cursor da página anterior', async () => {
    const c = cenario();
    comConta(c);
    c.getOrderList
      .mockResolvedValueOnce(pagina(['SN1'], true, 'cur-1'))
      .mockResolvedValueOnce(pagina(['SN2'], true, 'cur-2'))
      .mockResolvedValueOnce(pagina(['SN3'], false));

    const r = await rodar(c);

    expect(c.getOrderList).toHaveBeenCalledTimes(3);
    expect(chamada(c, 1).cursor).toBe('cur-1');
    expect(chamada(c, 2).cursor).toBe('cur-2');
    expect(r.contas[0]?.drenada).toBe(true);
    expect(r.contas[0]?.paginas).toBe(3);
  });

  it('NUNCA decide pelo número de linhas: 3 linhas com more === true buscam a próxima página', async () => {
    const c = cenario();
    comConta(c);
    // Three rows for a PAGE_SIZE of 50 — a row-count rule would stop here.
    c.getOrderList
      .mockResolvedValueOnce(pagina(['SN1', 'SN2', 'SN3'], true, 'cur-1'))
      .mockResolvedValueOnce(pagina(['SN4'], false));

    await rodar(c);

    expect(c.getOrderList).toHaveBeenCalledTimes(2);
  });

  it('uma página VAZIA com more === true continua paginando — o contrário do missedFeedsSweep do ML', async () => {
    const c = cenario();
    comConta(c);
    c.getOrderList
      .mockResolvedValueOnce(pagina([], true, 'cur-1'))
      .mockResolvedValueOnce(pagina(['SN1'], false));

    const r = await rodar(c);

    expect(c.getOrderList).toHaveBeenCalledTimes(2);
    expect(r.contas[0]?.enqueued).toBe(1);
  });

  it('a primeira página vai SEM o parâmetro cursor — o literal "" nunca é enviado', async () => {
    const c = cenario();
    comConta(c);
    c.getOrderList.mockResolvedValue(pagina(['SN1'], false));

    await rodar(c);

    const p = chamada(c, 0);
    expect('cursor' in p).toBe(false);
    expect(p.cursor).toBeUndefined();
  });

  it('more === false ⇒ cursorMs avança para o time_to da JANELA, nunca para nowMs', async () => {
    const c = cenario();
    const cursorMs = AGORA_MS - (15 * DIA_MS + HORA_MS);
    comConta(c, { cursorMs });
    c.getOrderList.mockResolvedValue(pagina([], false));

    await rodar(c);

    const patch = ultimoPatch(c.db, INT_A);
    const ateMs = cursorMs - OVERLAP_MS + 15 * DIA_MS;
    expect(patch?.cursorMs).toBe(ateMs);
    expect(patch?.cursorMs).not.toBe(AGORA_MS);
    // `[ateMs, nowMs]` was never queried — claiming it would skip it.
    expect(patch?.cursorMs).toBeLessThan(AGORA_MS);
    expect(patch?.pendingCursor).toBeNull();
    expect(patch?.pendingWindowFromMs).toBeNull();
    expect(patch?.pendingWindowToMs).toBeNull();
    expect(patch?.lastError).toBeNull();
  });

  it('o cursor é MONÓTONO: uma janela que termina antes do cursor guardado não o puxa para trás', async () => {
    const c = cenario();
    // A stored cursor AHEAD of this window's upper bound (two overlapping
    // ticks interleaving); `max` is what keeps it from moving backwards.
    const cursorMs = AGORA_MS - HORA_MS;
    comConta(c, {
      cursorMs,
      pendingCursor: 'cur-x',
      pendingWindowFromMs: AGORA_MS - 5 * HORA_MS,
      pendingWindowToMs: AGORA_MS - 4 * HORA_MS,
    });
    c.getOrderList.mockResolvedValue(pagina([], false));

    await rodar(c);

    expect(ultimoPatch(c.db, INT_A)?.cursorMs).toBe(cursorMs);
  });
});

describe('runShopeeOrderBackfill — truncagem', () => {
  function comConta(c: Cenario, cursorDoc?: DocData): void {
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    if (cursorDoc) c.db.seed(`${CURSOR_PATH}/${INT_A}`, cursorDoc);
  }

  /** Every page says `more: true` — the tick can only end on the page cap. */
  function paginasInfinitas(c: Cenario): void {
    let n = 0;
    c.getOrderList.mockImplementation(() => {
      n += 1;
      return Promise.resolve(pagina([`SN${String(n)}`], true, `cur-${String(n)}`));
    });
  }

  it('no cap de páginas o cursor NÃO avança; o next_cursor fica pendente com a janela dele', async () => {
    const c = cenario();
    const cursorMs = AGORA_MS - 10 * DIA_MS;
    comConta(c, { cursorMs });
    paginasInfinitas(c);

    const r = await rodar(c);

    expect(c.getOrderList).toHaveBeenCalledTimes(MAX_PAGES_PER_TICK);
    expect(r.contas[0]?.truncada).toBe(true);
    const patch = ultimoPatch(c.db, INT_A);
    expect(patch).not.toHaveProperty('cursorMs');
    expect(patch?.pendingCursor).toBe(`cur-${String(MAX_PAGES_PER_TICK)}`);
    expect(patch?.pendingWindowFromMs).toBe(cursorMs - OVERLAP_MS);
    expect(patch?.pendingWindowToMs).toBe(AGORA_MS);
  });

  it('o tick seguinte retoma a MESMA janela (mesmos time_from/time_to) mesmo com o relógio adiantado', async () => {
    const c = cenario();
    const deMs = AGORA_MS - 10 * DIA_MS;
    const ateMs = AGORA_MS - HORA_MS;
    comConta(c, { pendingCursor: 'cur-7', pendingWindowFromMs: deMs, pendingWindowToMs: ateMs });
    c.getOrderList.mockResolvedValue(pagina(['SN9'], false));

    // The clock has moved a full hour since the truncated tick.
    const r = await rodar(c, { nowMs: AGORA_MS + HORA_MS });

    const p = chamada(c, 0);
    expect(p.timeFromS).toBe(Math.floor(deMs / 1000));
    expect(p.timeToS).toBe(Math.floor(ateMs / 1000));
    expect(p.cursor).toBe('cur-7');
    expect(r.contas[0]?.retomada).toBe(true);
  });

  it('a janela retomada, ao drenar, avança para o time_to GUARDADO', async () => {
    const c = cenario();
    const deMs = AGORA_MS - 10 * DIA_MS;
    const ateMs = AGORA_MS - HORA_MS;
    comConta(c, { pendingCursor: 'cur-7', pendingWindowFromMs: deMs, pendingWindowToMs: ateMs });
    c.getOrderList.mockResolvedValue(pagina(['SN9'], false));

    await rodar(c, { nowMs: AGORA_MS + HORA_MS });

    const patch = ultimoPatch(c.db, INT_A);
    expect(patch?.cursorMs).toBe(ateMs);
    expect(patch?.pendingCursor).toBeNull();
    expect(patch?.pendingWindowFromMs).toBeNull();
    expect(patch?.pendingWindowToMs).toBeNull();
  });

  it('um cursor pendente SEM as duas bordas é ignorado: a janela é recalculada do zero', async () => {
    const c = cenario();
    // The three fields are written and cleared together; a lone cursor is a
    // corrupted row, and applying it to a RECOMPUTED window is undefined
    // behaviour at Shopee.
    comConta(c, { cursorMs: AGORA_MS - HORA_MS, pendingCursor: 'cur-orfao' });
    c.getOrderList.mockResolvedValue(pagina([], false));

    const r = await rodar(c);

    expect(chamada(c, 0).cursor).toBeUndefined();
    expect(r.contas[0]?.retomada).toBe(false);
  });

  it('more === true sem next_cursor: nada avança, lastError nomeado, nenhum cursor pendente', async () => {
    const c = cenario();
    comConta(c, { cursorMs: AGORA_MS - HORA_MS });
    c.getOrderList.mockResolvedValue(pagina(['SN1'], true, ''));

    const r = await rodar(c);

    expect(c.getOrderList).toHaveBeenCalledTimes(1);
    expect(r.contas[0]?.truncada).toBe(true);
    const patch = ultimoPatch(c.db, INT_A);
    expect(patch).not.toHaveProperty('cursorMs');
    expect(patch).not.toHaveProperty('pendingCursor');
    expect(patch?.lastError).toBe(MOTIVO_MORE_SEM_CURSOR);
  });

  it('uma conta 40 dias atrasada drena em 3 ticks; nenhuma janela passa de 15 d e o cursor nunca pula um intervalo', async () => {
    const c = cenario();
    const inicioMs = AGORA_MS - 40 * DIA_MS;
    comConta(c, { cursorMs: inicioMs });
    c.getOrderList.mockResolvedValue(pagina([], false));

    const janelas: { de: number; ate: number }[] = [];
    let nowMs = AGORA_MS;
    for (let tick = 0; tick < 3; tick += 1) {
      c.getOrderList.mockClear();
      await rodar(c, { nowMs });
      const p = chamada(c, 0);
      janelas.push({ de: p.timeFromS, ate: p.timeToS });
      nowMs += 15 * MINUTO_MS;
    }

    // No window exceeds Shopee's bound…
    for (const j of janelas) {
      expect(j.ate - j.de).toBeLessThanOrEqual(SHOPEE_ORDER_LIST_MAX_WINDOW_SECONDS);
    }
    // …the first two ride the bound exactly…
    expect((janelas[0]?.ate ?? 0) - (janelas[0]?.de ?? 0)).toBe(1_296_000);
    expect((janelas[1]?.ate ?? 0) - (janelas[1]?.de ?? 0)).toBe(1_296_000);
    // …each window STARTS before the previous one ended (the overlap), so no
    // interval is ever skipped…
    expect(janelas[1]?.de ?? 0).toBeLessThan(janelas[0]?.ate ?? 0);
    expect(janelas[2]?.de ?? 0).toBeLessThan(janelas[1]?.ate ?? 0);
    // …and the third one closes the gap on `now`.
    expect(janelas[2]?.ate).toBe(Math.floor((AGORA_MS + 30 * MINUTO_MS) / 1000));
    expect(ultimoPatch(c.db, INT_A)?.cursorMs).toBe(AGORA_MS + 30 * MINUTO_MS);
  });

  it('um cursor pendente recusado com error_param é DESCARTADO; uma falha de rede o PRESERVA', async () => {
    const pendente = {
      pendingCursor: 'cur-7',
      pendingWindowFromMs: AGORA_MS - 10 * DIA_MS,
      pendingWindowToMs: AGORA_MS - HORA_MS,
    };

    // (a) Shopee LOOKED at our cursor and refused it.
    const recusa = cenario();
    recusa.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    recusa.db.seed(`${CURSOR_PATH}/${INT_A}`, { ...pendente });
    recusa.getOrderList.mockRejectedValue(apiError('error_param'));

    await rodar(recusa);

    const patchRecusa = ultimoPatch(recusa.db, INT_A);
    expect(patchRecusa?.pendingCursor).toBeNull();
    expect(patchRecusa?.pendingWindowFromMs).toBeNull();
    expect(patchRecusa?.pendingWindowToMs).toBeNull();
    expect(patchRecusa).not.toHaveProperty('cursorMs');

    // (b) We never got an OPINION about the cursor — dropping it on every tick
    // of a Shopee outage is how a truncated conta starves.
    const rede = cenario();
    rede.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    rede.db.seed(`${CURSOR_PATH}/${INT_A}`, { ...pendente });
    rede.getOrderList.mockRejectedValue(new ShopeeNetworkError('ECONNRESET'));

    await rodar(rede);

    const patchRede = ultimoPatch(rede.db, INT_A);
    expect(patchRede).not.toHaveProperty('pendingCursor');
    expect(patchRede).not.toHaveProperty('pendingWindowFromMs');
    expect(patchRede).not.toHaveProperty('cursorMs');
    expect(rede.db.store[`${CURSOR_PATH}/${INT_A}`]?.data.pendingCursor).toBe('cur-7');
  });
});

describe('runShopeeOrderBackfill — o push sintético', () => {
  function comConta(c: Cenario): void {
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
  }

  it('sintetiza exatamente um code 3 por order_sn e enfileira cada um', async () => {
    const c = cenario();
    comConta(c);
    c.getOrderList.mockResolvedValue(pagina(['SN1', 'SN2', 'SN3'], false));

    const r = await rodar(c);

    expect(c.enqueue).toHaveBeenCalledTimes(3);
    expect(r.contas[0]?.ordersFound).toBe(3);
    expect(r.contas[0]?.enqueued).toBe(3);
    for (const [payload] of c.enqueue.mock.calls) {
      expect(payload).toMatchObject({ code: 3, shopId: SHOP_A, timestamp: AGORA_MS });
    }
  });

  it('o doc id é 3:<loja>:<ordersn>:<carimbo em ms> e a chave de dedup é 3:<loja>:<ordersn>', async () => {
    const c = cenario();
    comConta(c);
    c.getOrderList.mockResolvedValue(pagina(['SN1'], false));

    await rodar(c);

    const payload = enfileirado(c, 0);
    expect(docIdOf(payload)).toBe(`3:${String(SHOP_A)}:SN1:${String(AGORA_MS)}`);
    expect(dedupKeyOf(payload)).toBe(`3:${String(SHOP_A)}:SN1`);
  });

  it('order_status vira data.status quando a Shopee o devolve, e é OMITIDO quando não', async () => {
    const c = cenario();
    comConta(c);
    c.getOrderList.mockResolvedValue(
      pagina([{ order_sn: 'SN1', order_status: 'READY_TO_SHIP' }, { order_sn: 'SN2' }], false),
    );

    await rodar(c);

    expect(enfileirado(c, 0).data).toHaveProperty('status', 'READY_TO_SHIP');
    expect(Object.keys(enfileirado(c, 1).data ?? {})).not.toContain('status');
  });

  it('não carrega update_time, items nem completed_scenario', async () => {
    const c = cenario();
    comConta(c);
    c.getOrderList.mockResolvedValue(pagina([{ order_sn: 'SN1', order_status: 'SHIPPED' }], false));

    await rodar(c);

    const data = enfileirado(c, 0).data ?? {};
    expect(Object.keys(data).sort()).toEqual(['ordersn', 'origem', 'status']);
    expect(data).toHaveProperty('origem', 'backfill');
  });

  it('o mesmo pedido em duas páginas (a sobreposição) é enfileirado UMA vez — enfileirados < encontrados', async () => {
    const c = cenario();
    comConta(c);
    c.getOrderList
      .mockResolvedValueOnce(pagina(['SN1', 'SN2'], true, 'cur-1'))
      .mockResolvedValueOnce(pagina(['SN2', 'SN3'], false));

    const r = await rodar(c);

    expect(r.contas[0]?.ordersFound).toBe(4);
    expect(r.contas[0]?.enqueued).toBe(3);
    expect(r.contas[0]?.duplicadas).toBe(1);
    expect(c.enqueue).toHaveBeenCalledTimes(3);
  });
});

describe('runShopeeOrderBackfill — contenção por conta', () => {
  function duasContas(c: Cenario): void {
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.db.seed(`${INTEGRACAO_PATH}/${INT_B}`, contaDoc({ shop_id: SHOP_B }));
  }

  /** A client that fails for conta A and answers a drained page for conta B. */
  function falhaEmA(c: Cenario, err: unknown): void {
    const ruim = {
      getOrderList: () => Promise.reject(err),
    } as unknown as ShopeeClient;
    c.clientPor.set(INT_A, ruim);
    c.getOrderList.mockResolvedValue(pagina(['SN-B'], false));
  }

  it('um ShopeeApiError na conta A é contido; a conta B roda inteira', async () => {
    const c = cenario();
    duasContas(c);
    falhaEmA(c, apiError('error_server'));

    const r = await rodar(c);

    expect(r.contas[0]?.error).toContain('error_server');
    expect(r.contas[1]).toMatchObject({ integracaoId: INT_B, error: null, drenada: true });
    expect(c.enqueue).toHaveBeenCalledTimes(1);
  });

  it('a conta contida recebe { lastSweepAtMs, lastError } SEM cursorMs', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.db.seed(`${CURSOR_PATH}/${INT_A}`, { cursorMs: AGORA_MS - HORA_MS });
    c.getOrderList.mockRejectedValue(
      new ShopeeHttpError('502 do edge', { httpStatus: 502, path: '/api/v2/order/get_order_list' }),
    );

    await rodar(c);

    const patch = ultimoPatch(c.db, INT_A);
    expect(Object.keys(patch ?? {}).sort()).toEqual(['lastError', 'lastSweepAtMs']);
    expect(patch?.lastSweepAtMs).toBe(AGORA_MS);
    expect(c.db.store[`${CURSOR_PATH}/${INT_A}`]?.data.cursorMs).toBe(AGORA_MS - HORA_MS);
  });

  it('ShopeeContaSemShopIdError e ShopeeContaNotConfiguredError são contidos', async () => {
    for (const err of [
      new ShopeeContaSemShopIdError('consentimento de conta principal'),
      new ShopeeContaNotConfiguredError('documento ausente'),
    ]) {
      const c = cenario();
      duasContas(c);
      falhaEmA(c, err);

      const r = await rodar(c);

      expect(r.contas[0]?.error, err.name).toBe(err.message);
      expect(r.contas[1]?.error).toBeNull();
    }
  });

  it('as três falhas de CREDENCIAL são contidas — o token é resolvido dentro do getOrderList', async () => {
    // ⚠️ O client carrega o token como FUNÇÃO: `getOrRefreshAccessToken` roda
    // DENTRO de `client.getOrderList`, ou seja, dentro deste laço. Sem estas
    // três linhas, uma conta com o consentimento revogado (ou uma lease de
    // refresh segurada por outra instância) derrubaria a tick inteira e todas
    // as contas enumeradas depois dela ficariam sem varredura — sem `lastError`
    // em nenhuma.
    for (const err of [
      new ShopeeSemCredencialError('credencial ausente'),
      new ShopeeRefreshEmAndamentoError('lease em andamento', AGORA_MS + 30_000),
      new ShopeeCredencialInvalidaError('par inválido', ['access_token']),
    ]) {
      const c = cenario();
      duasContas(c);
      falhaEmA(c, err);

      const r = await rodar(c);

      expect(r.contas[0]?.error, err.name).toBe(err.message);
      expect(r.contas[1]?.error, err.name).toBeNull();
      expect(ultimoPatch(c.db, INT_A)?.lastError).toBe(err.message);
    }
  });

  it('ShopeeSchemaError é contido — a página não bateu com o schema, a conta seguinte roda', async () => {
    const c = cenario();
    duasContas(c);
    falhaEmA(
      c,
      new ShopeeSchemaError('campos inválidos', {
        campos: ['response.order_list.0.order_sn'],
        httpStatus: 200,
        path: '/api/v2/order/get_order_list',
      }),
    );

    const r = await rodar(c);

    expect(r.contas[0]?.error).toBe('campos inválidos');
    expect(r.contas[1]?.error).toBeNull();
  });

  it('ShopeeTasksDisabledError no enqueue é contido e o cursor não avança', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.getOrderList.mockResolvedValue(pagina(['SN1'], false));
    c.enqueue.mockRejectedValue(new ShopeeTasksDisabledError());

    const r = await rodar(c);

    expect(r.contas[0]?.error).toContain('SHOPEE_TASKS_DISABLED');
    expect(ultimoPatch(c.db, INT_A)).not.toHaveProperty('cursorMs');
  });

  it('um erro com code gRPC inteiro 1–16 é contido', async () => {
    const c = cenario();
    duasContas(c);
    falhaEmA(c, grpc(14, 'UNAVAILABLE'));

    const r = await rodar(c);

    expect(r.contas[0]?.error).toBe('UNAVAILABLE');
    expect(r.contas[1]?.error).toBeNull();
  });

  it('um Error com code numérico FORA de 1–16 é RELANÇADO', async () => {
    const c = cenario();
    duasContas(c);
    falhaEmA(c, grpc(17, 'código inventado'));

    await expect(rodar(c)).rejects.toThrow('código inventado');
  });

  it('um Error simples (bug de código) é RELANÇADO', async () => {
    const c = cenario();
    duasContas(c);
    falhaEmA(c, new TypeError('x.map is not a function'));

    await expect(rodar(c)).rejects.toThrow('x.map is not a function');
  });

  it('ShopeeConfigError é RELANÇADO — a nossa própria má configuração falha a execução que a nomeia', async () => {
    // ⚠️ It extends `ShopeeError`, so a boundary written as
    // `err instanceof ShopeeError` would CONTAIN it and turn a broken deploy
    // into N identical `lastError` strings behind a green tick (#778).
    const c = cenario();
    duasContas(c);
    falhaEmA(c, new ShopeeConfigError('SHOPEE_PARTNER_ID ausente'));

    await expect(rodar(c)).rejects.toBeInstanceOf(ShopeeConfigError);
  });

  it('nenhuma falha de enqueue escreve em notificacoesShopee', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.getOrderList.mockResolvedValue(pagina(['SN1', 'SN2'], false));
    c.enqueue.mockRejectedValue(grpc(4, 'DEADLINE_EXCEEDED'));

    await rodar(c);

    // A failure row would be re-driven by the reprocess sweep and then PARKED
    // — the exact terminal document the structural guard exists to prevent.
    expect(c.db.caminhos.filter((p) => p.startsWith('notificacoesShopee'))).toEqual([]);
    expect(c.db.writes.filter((w) => w.path.startsWith('notificacoesShopee'))).toEqual([]);
  });
});

describe('runShopeeOrderBackfill — as escritas', () => {
  it('a única escrita é um merge por conta em backfillPedidosShopee/{integracaoId} — nenhum runTransaction', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.db.seed(`${INTEGRACAO_PATH}/${INT_B}`, contaDoc({ shop_id: SHOP_B }));
    c.getOrderList
      .mockResolvedValueOnce(pagina(['SN1'], true, 'cur-1'))
      .mockResolvedValueOnce(pagina(['SN2'], false))
      .mockResolvedValue(pagina(['SN3'], false));

    await rodar(c);

    expect(c.db.writes.map((w) => w.path)).toEqual([
      `${CURSOR_PATH}/${INT_A}`,
      `${CURSOR_PATH}/${INT_B}`,
    ]);
    // ⚠️ This used to read `expect('runTransaction' in c.db).toBe(false)` — the
    // fake HAD no transaction runner, so a call would have been a TypeError.
    // Step 5's write path added one to the shared double, so the absence of the
    // METHOD stopped meaning anything; the property being asserted is unchanged
    // and now checked directly: this sweep opens no transaction, so the engine's
    // own attempt log is empty.
    expect(c.db.occ.txLog).toEqual([]);
  });
});
