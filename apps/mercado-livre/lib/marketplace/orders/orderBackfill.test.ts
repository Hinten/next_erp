import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreHttpError,
  type MercadoLivreApi,
  type MlOrder,
  type MlOrderSearch,
} from '@delfrance/integrations-mercado-livre';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import {
  backfillPedidosMercadoLivreCollection,
  integracaoCollection,
} from '@delfrance/data/admin/collections';

import { MlTasksDisabledError, type MlTaskScheduler } from '../tasks/mlTasks';

const h = vi.hoisted(() => ({
  loadCtx: vi.fn(),
  createApi: vi.fn(),
}));

// The sweep builds its ML API via the exact `runOrderImport` chain
// (loadMercadoLivreContext → resolveChannelContext → createMercadoLivreApi);
// both seams are mocked partially so the error classes stay real.
vi.mock('../core/mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('../core/mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadCtx };
});
vi.mock('@delfrance/integrations-mercado-livre', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/integrations-mercado-livre')>();
  return { ...actual, createMercadoLivreApi: h.createApi };
});

import {
  INITIAL_LOOKBACK_US,
  MAX_PAGES_PER_TICK,
  ORDER_BACKFILL_FLAG_ENV,
  OVERLAP_US,
  PAGE_LIMIT,
  runOrderBackfillSweep,
} from './orderBackfill';

/* ------------------------------ fake Firestore ---------------------------- */
// Trimmed copy of orderPaymentImport.test.ts's FakeDb: chained
// `where().where().get()` on a collection (the integração enumeration) + doc
// get/set — extended with `{ merge: true }` support on `set` (the admin
// handle's `merge()` writes via `docRef.set(patch, { merge: true })`).

type DocData = Record<string, unknown>;
type OpKind = 'get' | 'set';

interface FakeSnap {
  exists: boolean;
  id: string;
  data: () => DocData | undefined;
}

interface FakeDocRef {
  id: string;
  get: () => Promise<FakeSnap>;
  set: (data: DocData, opts?: { merge?: boolean }) => void;
}

interface FakeQueryDoc {
  id: string;
  data: () => DocData;
  exists: true;
}

interface FakeQuery {
  where: (field: string, op: string, value: unknown) => FakeQuery;
  limit: (n: number) => FakeQuery;
  get: () => Promise<{ docs: FakeQueryDoc[]; empty: boolean }>;
}

interface FakeCollection {
  doc: (id?: string) => FakeDocRef;
  where: (field: string, op: string, value: unknown) => FakeQuery;
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly opLog: Array<{ op: OpKind; path: string }> = [];
  private autoN = 0;

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }

  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }
  docs(path: string): Map<string, DocData> {
    return this.col(path);
  }

  private makeQuery(entries: Array<{ id: string; data: DocData }>): FakeQuery {
    const clauses: Array<[string, unknown]> = [];
    let lim: number | null = null;
    const self = this;
    const q: FakeQuery = {
      where(field, _op, value) {
        clauses.push([field, value]);
        return q;
      },
      limit(n) {
        lim = n;
        return q;
      },
      async get() {
        self.opLog.push({ op: 'get', path: 'query' });
        let rows = entries.filter((e) => clauses.every(([f, v]) => e.data[f] === v));
        if (lim != null) rows = rows.slice(0, lim);
        return {
          docs: rows.map((e) => ({ id: e.id, data: () => e.data, exists: true as const })),
          empty: rows.length === 0,
        };
      },
    };
    return q;
  }

  private makeDocRef(path: string, id: string): FakeDocRef {
    const self = this;
    const col = this.col(path);
    return {
      id,
      get: async () => {
        self.opLog.push({ op: 'get', path: `${path}/${id}` });
        return { exists: col.has(id), id, data: () => col.get(id) };
      },
      set: (data: DocData, opts?: { merge?: boolean }) => {
        self.opLog.push({ op: 'set', path: `${path}/${id}` });
        if (opts?.merge) col.set(id, { ...(col.get(id) ?? {}), ...data });
        else col.set(id, { ...data });
      },
    };
  }

  collection(path: string): FakeCollection {
    const self = this;
    const col = this.col(path);
    return {
      doc(id?: string) {
        return self.makeDocRef(path, id ?? `auto-${++self.autoN}`);
      },
      where(field, op, value) {
        const entries = [...col.entries()].map(([id, d]) => ({ id, data: d }));
        return self.makeQuery(entries).where(field, op, value);
      },
    };
  }
}

/* --------------------------------- helpers -------------------------------- */

const INTEGRACAO_PATH = integracaoCollection.resolvePath({});
const BACKFILL_PATH = backfillPedidosMercadoLivreCollection.resolvePath({});

const NOW_MS = Date.parse('2026-07-24T12:00:00.000Z');
const NOW_US = NOW_MS * 1000;

type SearchParams = Parameters<MercadoLivreApi['searchOrders']>[0];

function seedConta(db: FakeDb, id: string, userId: number | null): void {
  db.seed(INTEGRACAO_PATH, id, {
    tipo: INTEGRACAO_TIPO.mercadoLivre,
    ativo: true,
    user_id: userId,
    nome: `Conta ${id}`,
  });
}

function makeScheduler() {
  const enqueue = vi.fn(async () => {});
  const scheduler: MlTaskScheduler = { enqueue };
  return { scheduler, enqueue };
}

/** Wire the mocked context→api chain to a fake `searchOrders`. */
function wireApi(searchOrders: MercadoLivreApi['searchOrders']): void {
  h.loadCtx.mockImplementation(async (_db: Firestore, integracaoId: string) => ({
    integracaoId,
    conta: {},
    channel: {},
    store: {},
    resolveChannelContext: async () => ({
      integracaoId,
      accessToken: `tok-${integracaoId}`,
      account: {},
    }),
    exchangeAndPersist: async () => {},
  }));
  h.createApi.mockReturnValue({ searchOrders } as unknown as MercadoLivreApi);
}

function order(id: number, lastUpdated: string | null): MlOrder {
  return { id, last_updated: lastUpdated };
}

function page(orders: MlOrder[], total: number | null = null): MlOrderSearch {
  return { results: orders, paging: { total, offset: null, limit: null } };
}

function run(db: FakeDb, scheduler: MlTaskScheduler) {
  return runOrderBackfillSweep(db as unknown as Firestore, { scheduler, nowMs: NOW_MS });
}

/** The exact synthetic notification the sweep must enqueue for an order id. */
function syntheticPayload(orderId: number, userId: number): Record<string, unknown> {
  return {
    id: null,
    resource: `/orders/${orderId}`,
    topic: 'orders_v2',
    user_id: userId,
    application_id: null,
    attempts: null,
    sent: null,
    received: NOW_MS,
  };
}

beforeEach(() => {
  process.env[ORDER_BACKFILL_FLAG_ENV] = '1';
  h.loadCtx.mockReset();
  h.createApi.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env[ORDER_BACKFILL_FLAG_ENV];
});

/* ---------------------------------- tests --------------------------------- */

describe('runOrderBackfillSweep — flag gate', () => {
  it('flag off → { enabled: false }, zero Firestore/API calls', async () => {
    delete process.env[ORDER_BACKFILL_FLAG_ENV];
    const db = new FakeDb();
    seedConta(db, 'INT-A', 111);
    const searchOrders = vi.fn(async (_params: SearchParams) => page([]));
    wireApi(searchOrders);
    const { scheduler, enqueue } = makeScheduler();

    const result = await run(db, scheduler);

    expect(result).toEqual({ enabled: false, contas: [] });
    expect(db.opLog).toHaveLength(0);
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(searchOrders).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('flag set to anything but "1" stays off', async () => {
    process.env[ORDER_BACKFILL_FLAG_ENV] = 'true';
    const db = new FakeDb();
    const { scheduler } = makeScheduler();
    expect(await run(db, scheduler)).toEqual({ enabled: false, contas: [] });
    expect(db.opLog).toHaveLength(0);
  });
});

describe('runOrderBackfillSweep — account enumeration', () => {
  it('no active ML contas → enabled with an empty summary', async () => {
    const db = new FakeDb();
    // Inactive ML conta + active conta of another tipo — both filtered out.
    db.seed(INTEGRACAO_PATH, 'INT-OFF', {
      tipo: INTEGRACAO_TIPO.mercadoLivre,
      ativo: false,
      user_id: 111,
    });
    db.seed(INTEGRACAO_PATH, 'INT-SHOPEE', { tipo: INTEGRACAO_TIPO.shopee, ativo: true });
    const searchOrders = vi.fn(async (_params: SearchParams) => page([]));
    wireApi(searchOrders);
    const { scheduler } = makeScheduler();

    const result = await run(db, scheduler);

    expect(result).toEqual({ enabled: true, contas: [] });
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(searchOrders).not.toHaveBeenCalled();
  });

  it('conta without user_id → error entry, NO API calls, cursor untouched', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', null);
    const searchOrders = vi.fn(async (_params: SearchParams) => page([]));
    wireApi(searchOrders);
    const { scheduler, enqueue } = makeScheduler();

    const result = await run(db, scheduler);

    expect(result.contas).toEqual([
      {
        integracaoId: 'INT-A',
        ordersFound: 0,
        enqueued: 0,
        truncated: false,
        error: 'integração sem user_id — reconecte a conta',
      },
    ]);
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(searchOrders).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    // lastError stamped, cursorUs NOT created/advanced.
    expect(db.docs(BACKFILL_PATH).get('INT-A')).toEqual({
      lastSweepAtUs: NOW_US,
      lastError: 'integração sem user_id — reconecte a conta',
    });
  });
});

describe('runOrderBackfillSweep — happy path', () => {
  it('no cursor → 24h lookback, exact params + payloads, cursor advanced', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', 111);
    const searchOrders = vi.fn(async (_params: SearchParams) =>
      page(
        [order(1001, '2026-07-24T10:00:00.000Z'), order(1002, '2026-07-24T11:00:00.000Z')],
        2, // total covered by this single page → stop
      ),
    );
    wireApi(searchOrders);
    const { scheduler, enqueue } = makeScheduler();

    const result = await run(db, scheduler);

    expect(result).toEqual({
      enabled: true,
      contas: [
        { integracaoId: 'INT-A', ordersFound: 2, enqueued: 2, truncated: false, error: null },
      ],
    });

    // Window start = now - 24h (µs→ms→ISO only at the API boundary).
    const isoFrom = new Date(Math.floor((NOW_US - INITIAL_LOOKBACK_US) / 1000)).toISOString();
    expect(isoFrom).toBe('2026-07-23T12:00:00.000Z');
    expect(searchOrders).toHaveBeenCalledTimes(1);
    expect(searchOrders).toHaveBeenCalledWith({
      seller: 111,
      'order.date_last_updated.from': isoFrom,
      sort: 'date_asc',
      limit: PAGE_LIMIT,
      offset: 0,
    });

    // EVERY order enqueued with the EXACT synthetic orders_v2 payload, and NO
    // enqueue options (no scheduleDelaySeconds — backfilled orders are settled).
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenNthCalledWith(1, syntheticPayload(1001, 111));
    expect(enqueue).toHaveBeenNthCalledWith(2, syntheticPayload(1002, 111));
    expect(enqueue.mock.calls[0]).toHaveLength(1);

    // Cursor = max order.last_updated in µs; lastError cleared.
    expect(db.docs(BACKFILL_PATH).get('INT-A')).toEqual({
      cursorUs: Date.parse('2026-07-24T11:00:00.000Z') * 1000,
      lastSweepAtUs: NOW_US,
      lastError: null,
    });
  });

  it('existing cursor → window starts at cursorUs - 5min overlap', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', 111);
    const cursorUs = Date.parse('2026-07-24T08:00:00.000Z') * 1000;
    db.seed(BACKFILL_PATH, 'INT-A', { cursorUs, lastSweepAtUs: cursorUs, lastError: null });
    const searchOrders = vi.fn(async (_params: SearchParams) => page([])); // empty window
    wireApi(searchOrders);
    const { scheduler, enqueue } = makeScheduler();

    const result = await run(db, scheduler);

    const isoFrom = new Date(Math.floor((cursorUs - OVERLAP_US) / 1000)).toISOString();
    expect(isoFrom).toBe('2026-07-24T07:55:00.000Z');
    expect(searchOrders).toHaveBeenCalledWith({
      seller: 111,
      'order.date_last_updated.from': isoFrom,
      sort: 'date_asc',
      limit: PAGE_LIMIT,
      offset: 0,
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(result.contas).toEqual([
      { integracaoId: 'INT-A', ordersFound: 0, enqueued: 0, truncated: false, error: null },
    ]);
    // Fully drained empty window → cursor advances to now.
    expect(db.docs(BACKFILL_PATH).get('INT-A')).toEqual({
      cursorUs: NOW_US,
      lastSweepAtUs: NOW_US,
      lastError: null,
    });
  });
});

describe('runOrderBackfillSweep — pagination', () => {
  it('pages with advancing offsets until an empty page stops the loop', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', 111);
    const pages = [
      page([order(1, '2026-07-24T01:00:00.000Z'), order(2, '2026-07-24T02:00:00.000Z')]),
      page([order(3, '2026-07-24T03:00:00.000Z')]),
      page([]),
    ];
    let call = 0;
    const searchOrders = vi.fn(async (_params: SearchParams) => {
      call += 1;
      return pages[call - 1] ?? page([]);
    });
    wireApi(searchOrders);
    const { scheduler, enqueue } = makeScheduler();

    const result = await run(db, scheduler);

    expect(searchOrders).toHaveBeenCalledTimes(3);
    expect(searchOrders).toHaveBeenNthCalledWith(1, expect.objectContaining({ offset: 0 }));
    expect(searchOrders).toHaveBeenNthCalledWith(2, expect.objectContaining({ offset: 2 }));
    expect(searchOrders).toHaveBeenNthCalledWith(3, expect.objectContaining({ offset: 3 }));
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(result.contas[0]).toEqual({
      integracaoId: 'INT-A',
      ordersFound: 3,
      enqueued: 3,
      truncated: false,
      error: null,
    });
    expect(db.docs(BACKFILL_PATH).get('INT-A')).toEqual({
      cursorUs: Date.parse('2026-07-24T03:00:00.000Z') * 1000,
      lastSweepAtUs: NOW_US,
      lastError: null,
    });
  });

  it('page cap → truncated, loud warn, cursor STILL advanced to max fetched', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', 111);
    // Endless backlog: every page returns one order (monotonic last_updated),
    // total unknown — the cap is the only thing that stops the loop.
    let call = 0;
    const searchOrders = vi.fn(async (_params: SearchParams) => {
      call += 1;
      const minute = String(call).padStart(2, '0');
      return page([order(9000 + call, `2026-07-24T08:${minute}:00.000Z`)]);
    });
    wireApi(searchOrders);
    const { scheduler, enqueue } = makeScheduler();
    const warnSpy = vi.spyOn(console, 'warn').mockClear();

    const result = await run(db, scheduler);

    expect(searchOrders).toHaveBeenCalledTimes(MAX_PAGES_PER_TICK);
    expect(enqueue).toHaveBeenCalledTimes(MAX_PAGES_PER_TICK);
    expect(result.contas[0]).toEqual({
      integracaoId: 'INT-A',
      ordersFound: MAX_PAGES_PER_TICK,
      enqueued: MAX_PAGES_PER_TICK,
      truncated: true,
      error: null,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('order-backfill TRUNCADO'),
      expect.objectContaining({ integracaoId: 'INT-A', pages: MAX_PAGES_PER_TICK }),
    );
    // Cursor advanced to the max last_updated fetched (page 10's order).
    expect(db.docs(BACKFILL_PATH).get('INT-A')).toEqual({
      cursorUs: Date.parse('2026-07-24T08:10:00.000Z') * 1000,
      lastSweepAtUs: NOW_US,
      lastError: null,
    });
  });
});

describe('runOrderBackfillSweep — per-conta failure isolation', () => {
  it('MercadoLivreError on conta A is contained — conta B still fully runs', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', 111);
    seedConta(db, 'INT-B', 222);
    const cursorA = Date.parse('2026-07-24T06:00:00.000Z') * 1000;
    db.seed(BACKFILL_PATH, 'INT-A', { cursorUs: cursorA, lastSweepAtUs: cursorA, lastError: null });
    const searchOrders = vi.fn(async (params: SearchParams) => {
      if (params.seller === 111) throw new MercadoLivreHttpError('ML caiu (500)', 500, {});
      return page([order(2001, '2026-07-24T10:30:00.000Z')], 1);
    });
    wireApi(searchOrders);
    const { scheduler, enqueue } = makeScheduler();
    const errorSpy = vi.spyOn(console, 'error').mockClear();

    const result = await run(db, scheduler);

    expect(result.contas).toEqual([
      {
        integracaoId: 'INT-A',
        ordersFound: 0,
        enqueued: 0,
        truncated: false,
        error: 'ML caiu (500)',
      },
      { integracaoId: 'INT-B', ordersFound: 1, enqueued: 1, truncated: false, error: null },
    ]);
    // A: error stamped, cursorUs UNCHANGED (next tick retries the same window).
    expect(db.docs(BACKFILL_PATH).get('INT-A')).toEqual({
      cursorUs: cursorA,
      lastSweepAtUs: NOW_US,
      lastError: 'ML caiu (500)',
    });
    // B: fully processed with the exact synthetic payload + advanced cursor.
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(syntheticPayload(2001, 222));
    expect(db.docs(BACKFILL_PATH).get('INT-B')).toEqual({
      cursorUs: Date.parse('2026-07-24T10:30:00.000Z') * 1000,
      lastSweepAtUs: NOW_US,
      lastError: null,
    });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('enqueue throwing MlTasksDisabledError is contained (cursor not advanced)', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', 111);
    const searchOrders = vi.fn(async (_params: SearchParams) =>
      page([order(1001, '2026-07-24T10:00:00.000Z')], 1),
    );
    wireApi(searchOrders);
    const enqueue = vi.fn(async () => {
      throw new MlTasksDisabledError();
    });
    const scheduler: MlTaskScheduler = { enqueue };

    const result = await run(db, scheduler);

    expect(result.contas).toHaveLength(1);
    expect(result.contas[0]).toMatchObject({
      integracaoId: 'INT-A',
      enqueued: 0,
      truncated: false,
    });
    expect(result.contas[0]!.error).toContain('MERCADO_LIVRE_TASKS_DISABLED');
    const doc = db.docs(BACKFILL_PATH).get('INT-A');
    expect(doc?.cursorUs).toBeUndefined();
    expect(doc?.lastSweepAtUs).toBe(NOW_US);
    expect(typeof doc?.lastError).toBe('string');
  });

  it('an unclassifiable error (plain Error — a coding bug) RETHROWS', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', 111);
    const searchOrders = vi.fn(async (_params: SearchParams) => {
      throw new Error('boom — coding bug');
    });
    wireApi(searchOrders);
    const { scheduler } = makeScheduler();

    await expect(run(db, scheduler)).rejects.toThrow('boom — coding bug');
    // Nothing recorded for the conta — the tick failed loudly.
    expect(db.docs(BACKFILL_PATH).has('INT-A')).toBe(false);
  });

  it('a gRPC-coded transport error (integer code 1–16) is contained', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', 111);
    const searchOrders = vi.fn(async (_params: SearchParams) => {
      // gRPC 14 UNAVAILABLE — the Admin-SDK transport failure shape.
      throw Object.assign(new Error('14 UNAVAILABLE: connection dropped'), { code: 14 });
    });
    wireApi(searchOrders);
    const { scheduler } = makeScheduler();

    const result = await run(db, scheduler);

    expect(result.contas[0]!.error).toContain('UNAVAILABLE');
    const doc = db.docs(BACKFILL_PATH).get('INT-A');
    expect(doc?.cursorUs).toBeUndefined();
    expect(doc?.lastSweepAtUs).toBe(NOW_US);
  });

  it('an Error with a numeric code OUTSIDE the gRPC status range (1–16) RETHROWS', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', 111);
    const searchOrders = vi.fn(async (_params: SearchParams) => {
      // e.g. an HTTP-status-shaped code on a non-plugin error — a coding bug,
      // NOT a gRPC transport failure; must not be swallowed by the containment.
      throw Object.assign(new Error('unexpected: 404-coded non-plugin error'), { code: 404 });
    });
    wireApi(searchOrders);
    const { scheduler } = makeScheduler();

    await expect(run(db, scheduler)).rejects.toThrow('404-coded');
    expect(db.docs(BACKFILL_PATH).has('INT-A')).toBe(false);
  });
});
