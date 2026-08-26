import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { MercadoLivreHttpError, type MlOrder } from '@delfrance/integrations-mercado-livre';
import { ESTADO_PEDIDO, ESTADOS_PEDIDO_RESERVA, STATUS_PAGAMENTO } from '@delfrance/schemas';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';

import type { MlTaskScheduler } from '../notificacoes/mlTasks';

/* --------------------------- module seams (mocked) ------------------------- */
// Only the two that reach the network are mocked; everything else is the real
// module, including the decision function and the transaction body.
const h = vi.hoisted(() => ({
  loadMercadoLivreContext: vi.fn(),
  createMercadoLivreApi: vi.fn(),
}));
vi.mock('../core/mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('../core/mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadMercadoLivreContext };
});
vi.mock('@delfrance/integrations-mercado-livre', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/integrations-mercado-livre')>();
  return { ...actual, createMercadoLivreApi: h.createMercadoLivreApi };
});

const {
  ESTADOS_PEDIDO_TRAVADO,
  PAGE_LIMIT,
  PEDIDO_TRAVADO_DRY_RUN_ENV,
  PEDIDO_TRAVADO_FLAG_ENV,
  decidirPedidoTravado,
  integracaoIdDoPedido,
  pedidoTravadoMaxIdadeDias,
  runPedidoTravadoSweep,
} = await import('./pedidoTravadoSweep');

/* ------------------------------ fake Firestore ----------------------------- */

type DocData = Record<string, unknown>;

interface FakeQuery {
  where: (f: string, op: string, v: unknown) => FakeQuery;
  orderBy: (f: string, dir?: string) => FakeQuery;
  limit: (n: number) => FakeQuery;
  get: () => Promise<{ docs: Array<{ id: string; data: () => DocData }> }>;
}

/**
 * Records every clause so a test can assert the QUERY SHAPE — the shape is what
 * rides the declared composite index, and getting it wrong is a silent
 * full-scan on Enterprise rather than an error.
 */
class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly opLog: Array<{ op: string; path: string }> = [];
  readonly clauses: Array<[string, string, unknown]> = [];
  readonly orders: Array<[string, string | undefined]> = [];
  /** Writes applied by a committed transaction. */
  readonly writes: Array<{ path: string; patch: DocData }> = [];
  /** Set to mutate a pedido right before the transaction reads it. */
  beforeTx: ((db: FakeDb) => void) | null = null;

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

  private query(path: string): FakeQuery {
    const self = this;
    const local: Array<[string, string, unknown]> = [];
    let lim: number | null = null;
    const q: FakeQuery = {
      where(f, op, v) {
        local.push([f, op, v]);
        self.clauses.push([f, op, v]);
        return q;
      },
      orderBy(f, dir) {
        self.orders.push([f, dir]);
        return q;
      },
      limit(n) {
        lim = n;
        return q;
      },
      async get() {
        self.opLog.push({ op: 'get', path });
        let rows = [...self.col(path).entries()].map(([id, data]) => ({ id, data }));
        for (const [f, op, v] of local) {
          rows = rows.filter((r) => {
            if (op === '<') return Number(r.data[f]) < Number(v);
            if (op === 'in') return Array.isArray(v) && v.includes(r.data[f]);
            return r.data[f] === v;
          });
        }
        if (lim != null) rows = rows.slice(0, lim);
        return { docs: rows.map((r) => ({ id: r.id, data: () => r.data })) };
      },
    };
    return q;
  }

  collection(path: string): FakeQuery & { doc: (id: string) => unknown } {
    const self = this;
    const q = this.query(path);
    return Object.assign(q, {
      doc(id: string) {
        return {
          id,
          path: `${path}/${id}`,
          async get() {
            self.opLog.push({ op: 'get', path: `${path}/${id}` });
            const d = self.col(path).get(id);
            return { exists: d != null, id, data: () => d };
          },
        };
      },
    });
  }

  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    this.beforeTx?.(this);
    const self = this;
    const tx = {
      async get(refOrQuery: { get: () => Promise<unknown> }) {
        return refOrQuery.get();
      },
      update(ref: { path: string }, patch: DocData) {
        self.writes.push({ path: ref.path, patch });
        const cut = ref.path.lastIndexOf('/');
        const col = self.col(ref.path.slice(0, cut));
        const id = ref.path.slice(cut + 1);
        col.set(id, { ...(col.get(id) ?? {}), ...patch });
      },
    };
    return fn(tx);
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

/* --------------------------------- fixtures -------------------------------- */

const NOW_MS = Date.parse('2026-08-25T12:00:00.000Z');
const NOW_US = NOW_MS * 1000;
const DIA_US = 24 * 60 * 60 * 1000 * 1000;
const VELHO_US = NOW_US - 30 * DIA_US;

function seedPedidoTravado(db: FakeDb, id: string, over: DocData = {}): void {
  db.seed('pedidos', id, {
    ehSaida: true,
    estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    timestamp: VELHO_US,
    // The ML order clock — the real marketplace discriminator.
    lastMarketplaceUpdate: VELHO_US,
    integracaoPedidoOuterRef: 'documents/integracao/conta-A',
    ultimaModificacao: VELHO_US,
    ...over,
  });
  db.seed(`pedidos/${id}/orderML`, '424242', { id: 424242 });
}

function order(over: Partial<MlOrder> = {}): MlOrder {
  return { id: 424242, status: 'payment_in_process', ...over } as unknown as MlOrder;
}

function fakeScheduler() {
  const enqueue = vi.fn<MlTaskScheduler['enqueue']>(async () => {});
  return { scheduler: { enqueue } satisfies MlTaskScheduler, enqueue };
}

function armApi(result: MlOrder | Error): void {
  h.loadMercadoLivreContext.mockResolvedValue({
    conta: { user_id: 55 },
    resolveChannelContext: async () => ({ accessToken: 'AT', account: {} }),
  });
  h.createMercadoLivreApi.mockReturnValue({
    getOrder: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  });
}

function run(db: FakeDb, scheduler: MlTaskScheduler) {
  return runPedidoTravadoSweep(asDb(db), { scheduler, nowMs: NOW_MS });
}

beforeEach(() => {
  __resetAllReadCaches();
  h.loadMercadoLivreContext.mockReset();
  h.createMercadoLivreApi.mockReset();
  process.env[PEDIDO_TRAVADO_FLAG_ENV] = '1';
  delete process.env[PEDIDO_TRAVADO_DRY_RUN_ENV];
  delete process.env.MERCADO_LIVRE_PEDIDO_TRAVADO_MAX_IDADE_D;
  // ⚠️ NOT anchored to NOW_MS. Anchoring the system clock to the SAME instant as
  // the injected `nowMs` would hide a stray `Date.now()` — the exact bug the
  // injection exists to prevent. 12h wrong makes any accidental read visible.
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS + 12 * 3600_000);
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env[PEDIDO_TRAVADO_FLAG_ENV];
  delete process.env[PEDIDO_TRAVADO_DRY_RUN_ENV];
  delete process.env.MERCADO_LIVRE_PEDIDO_TRAVADO_MAX_IDADE_D;
});

/* ---------------------------------- tests ---------------------------------- */

describe('flag gating', () => {
  it('flag off → ZERO Firestore reads, zero enqueues', async () => {
    delete process.env[PEDIDO_TRAVADO_FLAG_ENV];
    const db = new FakeDb();
    seedPedidoTravado(db, 'ped-1');
    const { scheduler, enqueue } = fakeScheduler();

    const res = await run(db, scheduler);

    expect(res.enabled).toBe(false);
    expect(db.opLog).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it.each(['0', 'true', 'yes', ''])('flag set to %o stays off', async (value) => {
    process.env[PEDIDO_TRAVADO_FLAG_ENV] = value;
    const db = new FakeDb();
    seedPedidoTravado(db, 'ped-1');
    const res = await run(db, fakeScheduler().scheduler);
    expect(res.enabled).toBe(false);
    expect(db.opLog).toHaveLength(0);
  });
});

describe('the candidate query rides the declared index', () => {
  it('filters ehSaida + estado(in) + timestamp(<) and sorts timestamp desc', async () => {
    // ⚠️ The shape IS the index contract. `pedidos (ehSaida ASC, estado ASC,
    // timestamp DESC)` is declared; Firestore Enterprise does not error on an
    // unindexed query, it silently full-scans and bills data scanned — so a
    // reordered or extra clause is a cost regression with no failure signal.
    const db = new FakeDb();
    armApi(order());
    await run(db, fakeScheduler().scheduler);

    expect(db.clauses).toEqual([
      ['ehSaida', '==', true],
      ['estado', 'in', [...ESTADOS_PEDIDO_TRAVADO]],
      ['timestamp', '<', NOW_US - 7 * DIA_US],
    ]);
    expect(db.orders).toEqual([['timestamp', 'desc']]);
  });

  it('examines only the reserva-holding pre-payment estados', () => {
    // Every candidate estado must actually hold stock — otherwise the sweep is
    // ending sales for no stock benefit.
    for (const e of ESTADOS_PEDIDO_TRAVADO) {
      expect(ESTADOS_PEDIDO_RESERVA.has(e)).toBe(true);
    }
    expect([...ESTADOS_PEDIDO_TRAVADO]).not.toContain(ESTADO_PEDIDO.carrinho);
  });

  it('the estado it WRITES releases the reservation', () => {
    // The whole point of the sweep, pinned against the set rather than assumed.
    expect(ESTADOS_PEDIDO_RESERVA.has(ESTADO_PEDIDO.pagamentoNaoRealizado)).toBe(false);
  });
});

describe('the safety gates', () => {
  it('NEVER touches a pedido the ML importer did not write', async () => {
    // ⚠️ The gate is `lastMarketplaceUpdate`, NOT `integracaoPedidoOuterRef` — a
    // human-created pedido is REQUIRED by the form to set the latter, so gating
    // on it would sweep manual sales.
    const db = new FakeDb();
    seedPedidoTravado(db, 'ped-humano', { lastMarketplaceUpdate: null });
    const { scheduler, enqueue } = fakeScheduler();
    armApi(order());

    const res = await run(db, scheduler);

    expect(res.veredictos).toEqual({ 'nao-marketplace': 1 });
    expect(db.writes).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('leaves a pedido a human has SAVED alone', async () => {
    const db = new FakeDb();
    seedPedidoTravado(db, 'ped-1', { hasUserInteraction: true });
    armApi(order());
    const res = await run(db, fakeScheduler().scheduler);
    expect(res.veredictos).toEqual({ 'interacao-humana': 1 });
    expect(db.writes).toEqual([]);
  });

  it('refuses while any pagamento is aprovado — a partially-paid sale is live', async () => {
    const db = new FakeDb();
    seedPedidoTravado(db, 'ped-1');
    db.seed('pedidos/ped-1/pagamentos', 'pag-1', {
      valor: 40,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
    });
    armApi(order());
    const res = await run(db, fakeScheduler().scheduler);
    expect(res.veredictos).toEqual({ 'pagamento-aprovado': 1 });
    expect(db.writes).toEqual([]);
  });

  it('skips a pedido with no orderML mirror', async () => {
    const db = new FakeDb();
    seedPedidoTravado(db, 'ped-1');
    db.docs('pedidos/ped-1/orderML').clear();
    armApi(order());
    const res = await run(db, fakeScheduler().scheduler);
    expect(res.veredictos).toEqual({ 'sem-order-ml': 1 });
  });
});

describe('the decision table', () => {
  it('still pre-payment past the horizon → RELEASED to pagamentoNaoRealizado', async () => {
    const db = new FakeDb();
    seedPedidoTravado(db, 'ped-1');
    armApi(order({ status: 'payment_in_process' }));

    const res = await run(db, fakeScheduler().scheduler);

    expect(res.veredictos).toEqual({ liberado: 1 });
    expect(db.docs('pedidos').get('ped-1')).toMatchObject({
      estado: ESTADO_PEDIDO.pagamentoNaoRealizado,
    });
  });

  it.each(['paid', 'cancelled', 'invalid', 'pending_cancel'])(
    'ML says %s → RE-DRIVEN, never released here',
    async (status) => {
      const db = new FakeDb();
      seedPedidoTravado(db, 'ped-1');
      const { scheduler, enqueue } = fakeScheduler();
      armApi(order({ status }));

      const res = await run(db, scheduler);

      expect(res.veredictos).toEqual({ redirecionado: 1 });
      expect(db.writes).toEqual([]);
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'orders_v2', resource: '/orders/424242', user_id: 55 }),
      );
    },
  );

  it('an ML status this port does not know is NOT released', async () => {
    // Maps to `iniciado`, which is off the pre-payment ladder, so it re-drives
    // (a no-op) rather than ending a sale on a status we cannot interpret.
    const db = new FakeDb();
    seedPedidoTravado(db, 'ped-1');
    armApi(order({ status: 'quantum_pending' }));
    const res = await run(db, fakeScheduler().scheduler);
    expect(res.veredictos).toEqual({ redirecionado: 1 });
    expect(db.writes).toEqual([]);
  });

  it('a 404 order re-drives (the import owns the pack fallback)', async () => {
    const db = new FakeDb();
    seedPedidoTravado(db, 'ped-1');
    armApi(new MercadoLivreHttpError('gone', 404, null));
    const res = await run(db, fakeScheduler().scheduler);
    expect(res.veredictos).toEqual({ redirecionado: 1 });
    expect(db.writes).toEqual([]);
  });

  it.each([
    ['a 5xx', new MercadoLivreHttpError('boom', 503, null)],
    ['a dead grant', new MercadoLivreHttpError('unauthorized', 403, null)],
  ])('%s is UNVERIFIABLE — never releases', async (_label, err) => {
    const db = new FakeDb();
    seedPedidoTravado(db, 'ped-1');
    armApi(err);
    const res = await run(db, fakeScheduler().scheduler);
    expect(res.veredictos).toEqual({ 'nao-verificavel': 1 });
    expect(db.writes).toEqual([]);
  });

  it('decidirPedidoTravado is pure', () => {
    expect(decidirPedidoTravado(order({ status: 'payment_in_process' }))).toBe('liberar');
    expect(decidirPedidoTravado(order({ status: 'partially_paid' }))).toBe('liberar');
    expect(decidirPedidoTravado(order({ status: 'paid' }))).toBe('redirecionar');
    expect(decidirPedidoTravado(order({ status: 'cancelled' }))).toBe('redirecionar');
  });
});

describe('the in-transaction re-check (rule 7)', () => {
  it('does NOT release a pedido that got paid during the ML round trip', async () => {
    // The window is real: an ML API call sits between the candidate query and
    // the write, and a `payments` notification can approve the sale inside it.
    const db = new FakeDb();
    seedPedidoTravado(db, 'ped-1');
    armApi(order({ status: 'payment_in_process' }));
    db.beforeTx = (self) => {
      const p = self.docs('pedidos').get('ped-1')!;
      self.docs('pedidos').set('ped-1', { ...p, estado: ESTADO_PEDIDO.pago });
    };

    const res = await run(db, fakeScheduler().scheduler);

    expect(res.veredictos).toEqual({ 'mudou-durante': 1 });
    expect(db.writes).toEqual([]);
    expect(db.docs('pedidos').get('ped-1')).toMatchObject({ estado: ESTADO_PEDIDO.pago });
  });

  it('does NOT release when a payment landed during the round trip', async () => {
    const db = new FakeDb();
    seedPedidoTravado(db, 'ped-1');
    armApi(order({ status: 'payment_in_process' }));
    db.beforeTx = (self) => {
      self.seed('pedidos/ped-1/pagamentos', 'pag-tardio', {
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
      });
    };

    const res = await run(db, fakeScheduler().scheduler);

    expect(res.veredictos).toEqual({ 'pagamento-aprovado': 1 });
    expect(db.writes).toEqual([]);
  });

  it('does NOT release when a human saved the pedido during the round trip', async () => {
    const db = new FakeDb();
    seedPedidoTravado(db, 'ped-1');
    armApi(order({ status: 'payment_in_process' }));
    db.beforeTx = (self) => {
      const p = self.docs('pedidos').get('ped-1')!;
      self.docs('pedidos').set('ped-1', { ...p, hasUserInteraction: true });
    };

    const res = await run(db, fakeScheduler().scheduler);

    expect(res.veredictos).toEqual({ 'mudou-durante': 1 });
    expect(db.writes).toEqual([]);
  });
});

describe('dry run', () => {
  it('decides and counts identically but writes and enqueues NOTHING', async () => {
    process.env[PEDIDO_TRAVADO_DRY_RUN_ENV] = '1';
    const db = new FakeDb();
    seedPedidoTravado(db, 'ped-1');
    seedPedidoTravado(db, 'ped-2');
    db.seed('pedidos/ped-2/orderML', '999', { id: 999 });
    const { scheduler, enqueue } = fakeScheduler();
    armApi(order({ status: 'payment_in_process' }));

    const res = await run(db, scheduler);

    expect(res.dryRun).toBe(true);
    expect(res.veredictos).toEqual({ liberado: 2 });
    expect(db.writes).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
    expect(db.docs('pedidos').get('ped-1')).toMatchObject({
      estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    });
  });
});

describe('constants and bounds', () => {
  it('pins the default horizon at 7 days and honours the override', () => {
    expect(pedidoTravadoMaxIdadeDias()).toBe(7);
    process.env.MERCADO_LIVRE_PEDIDO_TRAVADO_MAX_IDADE_D = '30';
    expect(pedidoTravadoMaxIdadeDias()).toBe(30);
    process.env.MERCADO_LIVRE_PEDIDO_TRAVADO_MAX_IDADE_D = 'nonsense';
    expect(pedidoTravadoMaxIdadeDias()).toBe(7);
  });

  it('bounds the page', () => {
    expect(PAGE_LIMIT).toBe(200);
  });

  it('parses the integração id out of an outer ref', () => {
    expect(integracaoIdDoPedido({ integracaoPedidoOuterRef: 'documents/integracao/c1' })).toBe(
      'c1',
    );
    expect(integracaoIdDoPedido({})).toBeNull();
    expect(integracaoIdDoPedido({ integracaoPedidoOuterRef: '' })).toBeNull();
  });

  it('a fresh pedido is never a candidate', async () => {
    const db = new FakeDb();
    seedPedidoTravado(db, 'ped-novo', { timestamp: NOW_US - 1 * DIA_US });
    armApi(order());
    const res = await run(db, fakeScheduler().scheduler);
    expect(res.examinados).toBe(0);
    expect(res.veredictos).toEqual({});
  });
});

describe('failure isolation', () => {
  it('one bad candidate never aborts the batch', async () => {
    const db = new FakeDb();
    seedPedidoTravado(db, 'ped-1');
    seedPedidoTravado(db, 'ped-2');
    db.seed('pedidos/ped-2/orderML', '999', { id: 999 });
    let first = true;
    h.loadMercadoLivreContext.mockImplementation(async () => {
      if (first) {
        first = false;
        throw new TypeError('boom');
      }
      return {
        conta: { user_id: 55 },
        resolveChannelContext: async () => ({ accessToken: 'AT', account: {} }),
      };
    });
    h.createMercadoLivreApi.mockReturnValue({ getOrder: async () => order({ status: 'paid' }) });

    const res = await run(db, fakeScheduler().scheduler);

    expect(res.erros).toHaveLength(1);
    expect(res.veredictos).toEqual({ redirecionado: 1 });
  });
});
