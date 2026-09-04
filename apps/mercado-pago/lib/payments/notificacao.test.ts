import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { READ_CACHE_TTL, __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { __setMercadoPagoCacheClockForTests } from './metodoCache';
import type { Firestore } from 'firebase-admin/firestore';
import { PedidoReconcileNotFoundError } from '@delfrance/data/admin';
import { ESTADO_PEDIDO } from '@delfrance/schemas';
import {
  MercadoPagoHttpError,
  MercadoPagoNetworkError,
  MercadoPagoReauthRequiredError,
  type MpPayment,
} from '@delfrance/integrations-mercado-pago';

import {
  MAX_TENTATIVAS,
  TASK_MAX_ATTEMPTS,
  handleNotificationTask,
  isPaymentTopic,
  parseNotificationBody,
  reprocessNotifications,
  resolveMetodoByCollector,
  type ProcessDeps,
} from './notificacao';

/* ----------------------------- fake Firestore ---------------------------- */
// Supports the access shapes the admin handles use: doc get/set/create/delete,
// and chained where/orderBy/limit/get queries (ops: '==', '<'). Fault injection:
// a `metodo_pgto` query for a collector in `failMetodoUserIds` throws (models a
// transient Firestore failure), and a `.create()` at a doc id in `failCreateIds`
// throws (models Firestore down while persisting a failure).

type DocData = Record<string, unknown>;
type Clause = { field: string; op: string; value: unknown };

function matches(data: DocData, clauses: Clause[]): boolean {
  return clauses.every((c) => {
    const v = data[c.field];
    if (c.op === '==') return v === c.value;
    if (c.op === '<') return typeof v === 'number' && v < (c.value as number);
    return false;
  });
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly failMetodoUserIds = new Set<number>();
  readonly failCreateIds = new Set<string>();
  /** Queries executed. On Enterprise this is the read whose scanned bytes bill. */
  queryCount = 0;
  private autoN = 0;

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) {
      c = new Map();
      this.cols.set(path, c);
    }
    return c;
  }
  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }
  docs(path: string): Map<string, DocData> {
    return this.col(path);
  }

  collection(path: string) {
    const col = this.col(path);
    const self = this;
    const query = (clauses: Clause[], orderField: string | null, lim: number | null) => ({
      where: (field: string, op: string, value: unknown) =>
        query([...clauses, { field, op, value }], orderField, lim),
      orderBy: (field: string) => query(clauses, field, lim),
      limit: (n: number) => query(clauses, orderField, n),
      get: async () => {
        self.queryCount += 1;
        if (path === 'metodo_pgto') {
          const uid = clauses.find((c) => c.field === 'user_id' && c.op === '==');
          if (uid && self.failMetodoUserIds.has(uid.value as number)) {
            throw new Error('firestore unavailable');
          }
        }
        let rows = [...col.entries()].filter(([, d]) => matches(d, clauses));
        if (orderField) {
          rows.sort(
            (a, b) => ((a[1][orderField] as number) ?? 0) - ((b[1][orderField] as number) ?? 0),
          );
        }
        if (lim != null) rows = rows.slice(0, lim);
        return { docs: rows.map(([id, d]) => ({ id, data: () => d, exists: true })) };
      },
    });
    return {
      doc: (id?: string) => {
        const docId = id ?? `auto-${++self.autoN}`;
        return {
          id: docId,
          get: async () => ({ exists: col.has(docId), id: docId, data: () => col.get(docId) }),
          set: async (data: DocData, opts?: { merge?: boolean }) => {
            col.set(docId, opts?.merge ? { ...(col.get(docId) ?? {}), ...data } : { ...data });
          },
          create: async (data: DocData) => {
            if (self.failCreateIds.has(docId)) {
              throw Object.assign(new Error('create unavailable'), { code: 14 });
            }
            if (col.has(docId)) throw Object.assign(new Error('already exists'), { code: 6 });
            col.set(docId, { ...data });
          },
          delete: async () => {
            col.delete(docId);
          },
        };
      },
      where: (field: string, op: string, value: unknown) =>
        query([{ field, op, value }], null, null),
      orderBy: (field: string) => query([], field, null),
      limit: (n: number) => query([], null, n),
      get: async () => ({
        docs: [...col.entries()].map(([id, d]) => ({ id, data: () => d, exists: true })),
      }),
    };
  }
}

const NOTIF = 'notificacoesMercadoPago';
const METODO = 'metodo_pgto';
const asDb = (db: FakeDb) => db as unknown as Firestore;

function seedMetodo(db: FakeDb, id: string, userId: number, tipo = 1): void {
  db.seed(METODO, id, { tipo, user_id: userId, nome: id, hasLinkPagamento: false });
}

/** A minimal-but-valid refetched MP payment. */
function paymentOf(over: Partial<MpPayment> = {}): MpPayment {
  return {
    id: 987,
    status: 'approved',
    live_mode: true,
    external_reference: 'pedido-1',
    transaction_amount: 100,
    payment_type_id: 'credit_card',
    date_created: '2025-03-05T20:27:20.000Z',
    date_last_updated: '2025-03-05T20:30:00.000Z',
    ...over,
  } as MpPayment;
}

/** A lean MP-wire task payload (what the receiver enqueues / the sweep rebuilds). */
function payloadOf(over: DocData = {}): DocData {
  return {
    id: 'N1',
    paymentId: '987',
    topic: 'payment',
    collectorUserId: 55,
    liveMode: true,
    dateCreated: 1_700_000_000_000,
    ...over,
  };
}

/** A persisted `failed` notification doc (what the sweep re-drives). */
function seedFailed(db: FakeDb, id: string, over: DocData = {}): void {
  db.seed(NOTIF, id, {
    id,
    paymentId: '987',
    topic: 'payment',
    collectorUserId: 55,
    liveMode: true,
    dateCreated: 1_700_000_000_000,
    status: 'failed',
    tentativas: 0,
    erro: 'earlier failure',
    processedAt: 1_000,
    ...over,
  });
}

/** Deps whose fetch returns a fixed payment and whose reconcile is a no-op success. */
function fakeDeps(over: Partial<ProcessDeps> = {}): ProcessDeps {
  return {
    fetchPayment: vi.fn(async () => paymentOf()),
    reconcile: vi.fn(async () => ({ transition: 'pago' as const, skippedStale: false })) as never,
    ...over,
  };
}

let now = 1_700_000_000_000;

beforeEach(() => {
  // The collector cache and the metodo reader are module-scope, and the reader
  // is keyed by the document PATH — so a fresh `FakeDb` per test does NOT
  // isolate either, and `metodo-A` / collector 55 recur throughout this file
  // with deliberately different seeded state.
  __resetAllReadCaches();
  now = 1_700_000_000_000;
  __setMercadoPagoCacheClockForTests(() => now);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  __resetAllReadCaches();
  __setMercadoPagoCacheClockForTests();
});

/* ------------------------------ parse + topics --------------------------- */

describe('parseNotificationBody', () => {
  const noQuery = new URLSearchParams();

  it('extracts a v2 JSON webhook body (type/data.id/user_id/live_mode)', () => {
    const p = parseNotificationBody(
      {
        id: 'notif-1',
        type: 'payment',
        action: 'payment.updated',
        live_mode: true,
        user_id: 55,
        date_created: '2025-03-05T20:27:20.218Z',
        data: { id: 987 },
      },
      noQuery,
    );
    expect(p).toMatchObject({
      id: 'notif-1',
      paymentId: '987', // number coerced to string
      topic: 'payment',
      collectorUserId: 55,
      liveMode: true,
    });
    expect(p?.dateCreated).toBe(Date.parse('2025-03-05T20:27:20.218Z'));
  });

  it('extracts a v1 IPN via the query string (topic + id)', () => {
    const p = parseNotificationBody(
      { topic: 'payment' },
      new URLSearchParams('topic=payment&id=987'),
    );
    expect(p).toMatchObject({ paymentId: '987', topic: 'payment', id: null });
  });

  it('falls back to the ?data.id= query when the body has no data.id', () => {
    const p = parseNotificationBody({ type: 'payment' }, new URLSearchParams('data.id=555'));
    expect(p?.paymentId).toBe('555');
  });

  it('surfaces a merchant_order body (topic kept; dropped later, not at parse)', () => {
    const p = parseNotificationBody({ topic: 'merchant_order', data: { id: 42 } }, noQuery);
    expect(p).toMatchObject({ topic: 'merchant_order', paymentId: '42' });
  });

  it('normalizes an unparseable date_created to null', () => {
    const p = parseNotificationBody(
      { type: 'payment', data: { id: 1 }, date_created: 'not-a-date' },
      noQuery,
    );
    expect(p?.dateCreated).toBeNull();
  });

  it('rejects noise: non-object, arrays, missing topic or payment id', () => {
    expect(parseNotificationBody(null, noQuery)).toBeNull();
    expect(parseNotificationBody('x', noQuery)).toBeNull();
    expect(parseNotificationBody([1, 2], noQuery)).toBeNull();
    expect(parseNotificationBody({ type: 'payment' }, noQuery)).toBeNull(); // no id
    expect(parseNotificationBody({ data: { id: 9 } }, noQuery)).toBeNull(); // no topic
  });
});

describe('isPaymentTopic', () => {
  it('recognizes only the payment topic', () => {
    expect(isPaymentTopic('payment')).toBe(true);
    expect(isPaymentTopic('merchant_order')).toBe(false);
    expect(isPaymentTopic('subscription')).toBe(false);
  });
});

/* -------------------------------- resolver ------------------------------- */

describe('resolveMetodoByCollector', () => {
  it('resolves the metodo_pgto account for a known collector id', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    seedMetodo(db, 'metodo-B', 66);
    expect(await resolveMetodoByCollector(asDb(db), 55)).toEqual({
      kind: 'resolved',
      metodoId: 'metodo-A',
      userId: 55,
    });
  });

  it('parks a known collector with no matching account (may connect later)', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-X', 55, 2); // wrong tipo — filtered out
    expect((await resolveMetodoByCollector(asDb(db), 55)).kind).toBe('failed');
  });

  it('parks an ambiguous collector (two accounts share the denorm)', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    seedMetodo(db, 'metodo-B', 55);
    expect((await resolveMetodoByCollector(asDb(db), 55)).kind).toBe('failed');
  });

  it('v1 (null collector) falls back to the single connected MP account', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    expect(await resolveMetodoByCollector(asDb(db), null)).toEqual({
      kind: 'resolved',
      metodoId: 'metodo-A',
      userId: 55,
    });
  });

  // ⚠️ Split from one `it` into two. Both halves used the SAME input-independent
  // v1 key against different FakeDbs, so as a single test it only passed because
  // `negativeTtlMs: 0` refuses to cache either failure — a latent false pass that
  // would have started lying the moment that setting changed.
  it('v1 parks when ZERO MP accounts are connected', async () => {
    const empty = new FakeDb();
    expect((await resolveMetodoByCollector(asDb(empty), null)).kind).toBe('failed');
  });

  it('v1 parks when MULTIPLE MP accounts are connected', async () => {
    const many = new FakeDb();
    seedMetodo(many, 'metodo-A', 55);
    seedMetodo(many, 'metodo-B', 66);
    expect((await resolveMetodoByCollector(asDb(many), null)).kind).toBe('failed');
  });
});

describe('resolveMetodoByCollector — the collector read cache', () => {
  it('resolves a repeated collector from cache', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);

    await resolveMetodoByCollector(asDb(db), 55);
    const before = db.queryCount;
    await resolveMetodoByCollector(asDb(db), 55);

    expect(before).toBeGreaterThan(0);
    expect(db.queryCount).toBe(before);
  });

  it('re-queries after ttlMs — the staleness contract, not just the hit', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);

    await resolveMetodoByCollector(asDb(db), 55);
    const before = db.queryCount;
    now += READ_CACHE_TTL.volatile;
    await resolveMetodoByCollector(asDb(db), 55);

    expect(db.queryCount).toBeGreaterThan(before);
  });

  it('never caches a park — a seller who connects moments later resolves at once', async () => {
    // A `failed` outcome PERSISTS a notificacoesMercadoPago doc that only the
    // 30-minute sweep re-drives, past its own staleness window. Caching it would
    // cost a write plus well over an hour of delay.
    const db = new FakeDb();
    expect((await resolveMetodoByCollector(asDb(db), 55)).kind).toBe('failed');

    seedMetodo(db, 'metodo-A', 55);
    expect(await resolveMetodoByCollector(asDb(db), 55)).toMatchObject({
      kind: 'resolved',
      metodoId: 'metodo-A',
    });
  });

  it('namespaces the v1 branch apart from a keyed collector', async () => {
    // The v1 key is input-independent, so it must not be satisfiable by — or
    // satisfy — a collector-keyed lookup.
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);

    expect(await resolveMetodoByCollector(asDb(db), 55)).toMatchObject({ metodoId: 'metodo-A' });
    seedMetodo(db, 'metodo-B', 66);
    // Two connected accounts now ⇒ the v1 branch is ambiguous, and it must see
    // that rather than reusing the collector-55 entry.
    expect((await resolveMetodoByCollector(asDb(db), null)).kind).toBe('failed');
  });
});

/* ----------------------------- handleNotificationTask -------------------- */

describe('handleNotificationTask', () => {
  it('payment fetched + reconciled → done, and persists NOTHING (the cost win)', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    const deps = fakeDeps();
    const r = await handleNotificationTask(asDb(db), payloadOf(), 0, deps);
    expect(r).toMatchObject({ outcome: 'done', metodoId: 'metodo-A', pedidoId: 'pedido-1' });
    expect(db.docs(NOTIF).size).toBe(0);
    expect(deps.fetchPayment).toHaveBeenCalledWith(asDb(db), 'metodo-A', '987');
    // The reconcile receives the mapped pagamento at the gateway-stable id.
    expect(deps.reconcile).toHaveBeenCalledWith(
      asDb(db),
      expect.objectContaining({ pedidoId: 'pedido-1', pagamentoId: '987' }),
    );
    const reconcileArg = (deps.reconcile as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![1] as { pagamento: { metodoPagamentoOuterRef: string } };
    expect(reconcileArg.pagamento.metodoPagamentoOuterRef).toBe('documents/metodo_pgto/metodo-A');
  });

  /**
   * ⚠️ The regression these guard against is INVISIBLE without them.
   *
   * `done` is a disposition, not a claim that work happened: a reconcile that
   * moved the pedido to `pago`, one that wrote a pagamento and moved no estado,
   * and one that wrote NOTHING because the delivery was stale all resolve to it.
   * On Mercado Livre's first live run (#1087) the task handler logged a bare
   * success for every delivery while nothing was being written, and no field
   * could say which had occurred.
   *
   * The property under test is not "detail is present" — it is that runs which
   * DID different things REPORT differently. Dropping `kind` or `detail` again
   * would restore the blindness while leaving every other assertion in this file
   * green, so they are asserted here rather than trusted.
   */
  describe('reports what it actually did (#1087)', () => {
    /** Drive one delivery with a reconcile that returns exactly this. */
    async function runReconcile(ret: {
      transition: string | null;
      skippedStale: boolean;
    }): Promise<Awaited<ReturnType<typeof handleNotificationTask>>> {
      const db = new FakeDb();
      seedMetodo(db, 'metodo-A', 55);
      return handleNotificationTask(
        asDb(db),
        payloadOf(),
        0,
        fakeDeps({ reconcile: vi.fn(async () => ret) as never }),
      );
    }

    it('an estado transition reports the estado it moved to', async () => {
      const r = await runReconcile({ transition: ESTADO_PEDIDO.pago, skippedStale: false });
      expect(r).toMatchObject({
        outcome: 'done',
        kind: 'reconciled',
        detail: ESTADO_PEDIDO.pago,
      });
    });

    it('a STALE redelivery wrote nothing, and does not report as a transition', async () => {
      const r = await runReconcile({ transition: null, skippedStale: true });
      expect(r).toMatchObject({ outcome: 'done', kind: 'reconciled', detail: 'stale-ignorado' });
    });

    it('a pagamento written with no estado change is its own outcome', async () => {
      const r = await runReconcile({ transition: null, skippedStale: false });
      expect(r).toMatchObject({ outcome: 'done', kind: 'reconciled', detail: 'sem-transicao' });
    });

    it('THE PROPERTY: the three reconcile outcomes share `done` and stay distinct', async () => {
      const details = [
        (await runReconcile({ transition: ESTADO_PEDIDO.pago, skippedStale: false })).detail,
        (await runReconcile({ transition: null, skippedStale: true })).detail,
        (await runReconcile({ transition: null, skippedStale: false })).detail,
      ];
      expect(new Set(details).size).toBe(3);
    });

    it('carries the success arm `kind` out to the caller', async () => {
      const db = new FakeDb();
      seedMetodo(db, 'metodo-A', 55);
      const r = await handleNotificationTask(asDb(db), payloadOf(), 0, fakeDeps());
      expect(r.kind).toBe('reconciled');
    });

    it('carries a NON-success arm `kind` out too — a drop is not a reconcile', async () => {
      const db = new FakeDb();
      seedMetodo(db, 'metodo-A', 55);
      const r = await handleNotificationTask(
        asDb(db),
        payloadOf({ liveMode: false }),
        0,
        fakeDeps(),
      );
      expect(r.kind).toBe('dropped');
    });

    it('the two pre-refetch drops are told apart — both were `dropped` alone before', async () => {
      const db = new FakeDb();
      seedMetodo(db, 'metodo-A', 55);
      const sandbox = await handleNotificationTask(
        asDb(db),
        payloadOf({ liveMode: false }),
        0,
        fakeDeps(),
      );
      const topico = await handleNotificationTask(
        asDb(db),
        payloadOf({ topic: 'merchant_order' }),
        0,
        fakeDeps(),
      );
      expect(sandbox.detail).toBe('sandbox');
      expect(topico.detail).toBe('topico-nao-suportado');
      expect(sandbox.detail).not.toBe(topico.detail);
    });

    it('a sandbox found only by the REFETCH is distinct — an MP call was spent', async () => {
      const db = new FakeDb();
      seedMetodo(db, 'metodo-A', 55);
      const r = await handleNotificationTask(
        asDb(db),
        payloadOf(),
        0,
        fakeDeps({ fetchPayment: vi.fn(async () => paymentOf({ live_mode: false })) }),
      );
      expect(r).toMatchObject({ outcome: 'dropped', kind: 'dropped', detail: 'sandbox-refetch' });
      // The account WAS resolved before the refetch, so the park names it.
      expect(r.metodoId).toBe('metodo-A');
    });

    it('a park that resolved an account carries `metodoId`, and no `detail`', async () => {
      const db = new FakeDb();
      seedMetodo(db, 'metodo-A', 55);
      const r = await handleNotificationTask(
        asDb(db),
        payloadOf(),
        0,
        fakeDeps({
          fetchPayment: vi.fn(async () => paymentOf({ external_reference: null })),
        }),
      );
      expect(r).toMatchObject({ outcome: 'failed', kind: 'failed', metodoId: 'metodo-A' });
      // `fail` writes a Firestore doc carrying the whole reason as `erro`, so it
      // deliberately gets no coarser second copy in the log.
      expect(r.detail).toBeUndefined();
    });

    it('the shared pipeline schema-parse drop carries NO kind — a coding bug, not ours', async () => {
      const db = new FakeDb();
      seedMetodo(db, 'metodo-A', 55);
      const r = await handleNotificationTask(asDb(db), { paymentId: '' }, 0, fakeDeps());
      expect(r.outcome).toBe('dropped');
      expect(r.kind).toBeUndefined();
    });
  });

  it('live_mode=false webhook → dropped, no refetch, no persist', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    const deps = fakeDeps();
    const r = await handleNotificationTask(asDb(db), payloadOf({ liveMode: false }), 0, deps);
    expect(r.outcome).toBe('dropped');
    expect(deps.fetchPayment).not.toHaveBeenCalled();
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('merchant_order topic → dropped, no persist', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    const deps = fakeDeps();
    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({ topic: 'merchant_order' }),
      0,
      deps,
    );
    expect(r.outcome).toBe('dropped');
    expect(deps.fetchPayment).not.toHaveBeenCalled();
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('known collector with no matching account → failed park (was dropped), no refetch', async () => {
    const db = new FakeDb();
    const deps = fakeDeps();
    const r = await handleNotificationTask(asDb(db), payloadOf({ collectorUserId: 999 }), 0, deps);
    expect(r.outcome).toBe('failed');
    const doc = db.docs(NOTIF).get('N1')!;
    expect(doc.status).toBe('failed');
    expect(deps.fetchPayment).not.toHaveBeenCalled();
  });

  it('ambiguous collector → failed, persisted', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    seedMetodo(db, 'metodo-B', 55);
    const deps = fakeDeps();
    const r = await handleNotificationTask(asDb(db), payloadOf(), 0, deps);
    expect(r.outcome).toBe('failed');
    const doc = db.docs(NOTIF).get('N1')!;
    expect(doc.status).toBe('failed');
    expect(doc.paymentId).toBe('987');
    expect(deps.fetchPayment).not.toHaveBeenCalled();
  });

  it('v1 IPN (no collector) → resolved via the single connected account → done', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    // The refetched payment's collector_id matches the resolved account — the
    // safety net passes and the delivery reconciles end-to-end.
    const deps = fakeDeps({ fetchPayment: vi.fn(async () => paymentOf({ collector_id: 55 })) });
    const r = await handleNotificationTask(asDb(db), payloadOf({ collectorUserId: null }), 0, deps);
    expect(r).toMatchObject({ outcome: 'done', metodoId: 'metodo-A', pedidoId: 'pedido-1' });
    expect(db.docs(NOTIF).size).toBe(0);
    expect(deps.fetchPayment).toHaveBeenCalledWith(asDb(db), 'metodo-A', '987');
  });

  it('v1 IPN with two connected accounts → failed park (ambiguous), no refetch', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    seedMetodo(db, 'metodo-B', 66);
    const deps = fakeDeps();
    const r = await handleNotificationTask(asDb(db), payloadOf({ collectorUserId: null }), 0, deps);
    expect(r.outcome).toBe('failed');
    expect(db.docs(NOTIF).get('N1')!.status).toBe('failed');
    expect(deps.fetchPayment).not.toHaveBeenCalled();
  });

  it('refetched collector_id disagreeing with the resolved account → failed park, no reconcile', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    const deps = fakeDeps({ fetchPayment: vi.fn(async () => paymentOf({ collector_id: 999 })) });
    const r = await handleNotificationTask(asDb(db), payloadOf(), 0, deps);
    expect(r.outcome).toBe('failed');
    const doc = db.docs(NOTIF).get('N1')!;
    expect(doc.status).toBe('failed');
    expect(String(doc.erro)).toContain('999');
    expect(deps.reconcile).not.toHaveBeenCalled();
  });

  it('reauth-required refetch error → failed park immediately (dead OAuth grant)', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    const deps = fakeDeps({
      fetchPayment: vi.fn(async () => {
        throw new MercadoPagoReauthRequiredError('refresh_failed', 'grant revoked');
      }),
    });
    const r = await handleNotificationTask(asDb(db), payloadOf(), 0, deps);
    expect(r.outcome).toBe('failed');
    expect(db.docs(NOTIF).get('N1')!.status).toBe('failed');
  });

  it('HTTP 404 refetch error → failed park (payment id does not exist)', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    const deps = fakeDeps({
      fetchPayment: vi.fn(async () => {
        throw new MercadoPagoHttpError('not found', 404, null);
      }),
    });
    const r = await handleNotificationTask(asDb(db), payloadOf(), 0, deps);
    expect(r.outcome).toBe('failed');
    expect(db.docs(NOTIF).get('N1')!.status).toBe('failed');
  });

  it('network error on refetch → transient rethrow (queue retries), no persist', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    const deps = fakeDeps({
      fetchPayment: vi.fn(async () => {
        throw new MercadoPagoNetworkError('econnreset');
      }),
    });
    await expect(handleNotificationTask(asDb(db), payloadOf(), 0, deps)).rejects.toThrow(
      'econnreset',
    );
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('HTTP 5xx refetch error → transient rethrow (queue retries), no persist', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    const deps = fakeDeps({
      fetchPayment: vi.fn(async () => {
        throw new MercadoPagoHttpError('bad gateway', 502, null);
      }),
    });
    await expect(handleNotificationTask(asDb(db), payloadOf(), 0, deps)).rejects.toThrow(
      'bad gateway',
    );
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('refetched payment with live_mode=false → dropped (authoritative recheck)', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    const deps = fakeDeps({ fetchPayment: vi.fn(async () => paymentOf({ live_mode: false })) });
    const r = await handleNotificationTask(asDb(db), payloadOf(), 0, deps);
    expect(r.outcome).toBe('dropped');
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('payment with no external_reference → failed park (no pedido to attach)', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    const deps = fakeDeps({
      fetchPayment: vi.fn(async () => paymentOf({ external_reference: null })),
    });
    const r = await handleNotificationTask(asDb(db), payloadOf(), 0, deps);
    expect(r.outcome).toBe('failed');
    expect(db.docs(NOTIF).get('N1')!.status).toBe('failed');
    expect(deps.reconcile).not.toHaveBeenCalled();
  });

  it('pedido not found (reconcile throws) → failed park, NOT a retry-throw', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    const deps = fakeDeps({
      reconcile: vi.fn(async () => {
        throw new PedidoReconcileNotFoundError('pedido-1');
      }) as never,
    });
    const r = await handleNotificationTask(asDb(db), payloadOf(), 0, deps);
    expect(r.outcome).toBe('failed');
    const doc = db.docs(NOTIF).get('N1')!;
    expect(doc.status).toBe('failed');
    expect(String(doc.erro)).toContain('pedido-1');
  });

  it('transient refetch failure re-throws while under the attempt cap (queue retries)', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    const deps = fakeDeps({
      fetchPayment: vi.fn(async () => {
        throw new Error('mp api unavailable');
      }),
    });
    await expect(handleNotificationTask(asDb(db), payloadOf(), 0, deps)).rejects.toThrow(
      'mp api unavailable',
    );
    expect(db.docs(NOTIF).size).toBe(0); // not persisted until the final attempt
  });

  it('transient failure on the FINAL attempt persists failed instead of throwing', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    const deps = fakeDeps({
      fetchPayment: vi.fn(async () => {
        throw new Error('mp api unavailable');
      }),
    });
    const r = await handleNotificationTask(asDb(db), payloadOf(), TASK_MAX_ATTEMPTS - 1, deps);
    expect(r.outcome).toBe('failed');
    const doc = db.docs(NOTIF).get('N1')!;
    expect(doc.status).toBe('failed');
    expect(String(doc.erro)).toContain('mp api unavailable');
  });

  it('re-throws the ORIGINAL error when the final-attempt persist also fails', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    db.failCreateIds.add('N1'); // the recovery persist ALSO fails (correlated outage)
    const deps = fakeDeps({
      fetchPayment: vi.fn(async () => {
        throw new Error('mp api unavailable');
      }),
    });
    await expect(
      handleNotificationTask(asDb(db), payloadOf(), TASK_MAX_ATTEMPTS - 1, deps),
    ).rejects.toThrow('mp api unavailable');
    expect(db.docs(NOTIF).size).toBe(0); // nothing persisted — dropped, but observably re-thrown
  });

  it('malformed payload → dropped, no persist, no retry', async () => {
    const db = new FakeDb();
    const r = await handleNotificationTask(asDb(db), { topic: 'payment' }, 0, fakeDeps()); // no paymentId
    expect(r.outcome).toBe('dropped');
    expect(db.docs(NOTIF).size).toBe(0);
  });
});

/* ----------------------------- reprocess sweep --------------------------- */

describe('reprocessNotifications', () => {
  it('re-drives failed docs older than the window, deduped by paymentId, deletes on success', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    seedFailed(db, 'N1', { processedAt: 1_000, paymentId: '111' });
    seedFailed(db, 'N2', { processedAt: 1_000, paymentId: '111' }); // dup paymentId
    seedFailed(db, 'N3', { processedAt: 1_000, paymentId: '222' });
    seedFailed(db, 'N4', { processedAt: 9_999_999_999_999, paymentId: '333' }); // too new
    seedFailed(db, 'N5', { processedAt: 1_000, paymentId: '444', status: 'parked' }); // terminal

    const res = await reprocessNotifications(
      asDb(db),
      { now: 10_000, olderThanMs: 100 },
      fakeDeps(),
    );
    // N1 + N3 processed (N2 deduped, N4 too new, N5 parked/excluded by query)
    expect(res.processed).toBe(2);
    expect(res.outcomes.reconciled).toBe(2);
    expect(res.errors).toEqual([]);
    expect(db.docs(NOTIF).has('N1')).toBe(false); // deleted on success
    expect(db.docs(NOTIF).has('N3')).toBe(false);
    expect(db.docs(NOTIF).has('N2')).toBe(true); // dup left for a later run
  });

  it('keeps a still-unresolvable doc failed (tentativas++) under the cap; parks at the cap', async () => {
    const db = new FakeDb();
    // no metodo → unknown collector would DROP; use pedido-not-found to stay `failed`.
    const deps = fakeDeps({
      reconcile: vi.fn(async () => {
        throw new PedidoReconcileNotFoundError('pedido-1');
      }) as never,
    });
    seedMetodo(db, 'metodo-A', 55);
    seedFailed(db, 'N1', { processedAt: 1_000, paymentId: '111', tentativas: 0 });
    seedFailed(db, 'N2', { processedAt: 1_000, paymentId: '222', tentativas: MAX_TENTATIVAS - 1 });

    const res = await reprocessNotifications(asDb(db), { now: 10_000, olderThanMs: 100 }, deps);
    expect(res.outcomes.failed).toBe(1);
    expect(res.outcomes.parked).toBe(1);
    const n1 = db.docs(NOTIF).get('N1')!;
    expect(n1.status).toBe('failed');
    expect(n1.tentativas).toBe(1);
    expect(n1.processedAt).toBe(10_000); // window advanced
    const n2 = db.docs(NOTIF).get('N2')!;
    expect(n2.status).toBe('parked');
    expect(n2.tentativas).toBe(MAX_TENTATIVAS);
  });

  it('deletes a doc that now resolves to dropped (sandbox on refetch)', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    // The refetched payment is authoritatively sandbox → dropped → doc removed.
    const deps = fakeDeps({ fetchPayment: vi.fn(async () => paymentOf({ live_mode: false })) });
    seedFailed(db, 'N1', { processedAt: 1_000, paymentId: '111', collectorUserId: 55 });
    const res = await reprocessNotifications(asDb(db), { now: 10_000, olderThanMs: 100 }, deps);
    expect(res.outcomes.dropped).toBe(1);
    expect(db.docs(NOTIF).has('N1')).toBe(false);
  });

  it('isolates a per-doc transient failure — one throw does not abort the batch', async () => {
    const db = new FakeDb();
    seedMetodo(db, 'metodo-A', 55);
    seedMetodo(db, 'metodo-B', 66);
    seedFailed(db, 'N1', { processedAt: 1_000, paymentId: '111', collectorUserId: 55 });
    seedFailed(db, 'N2', { processedAt: 1_000, paymentId: '222', collectorUserId: 66 });
    db.failMetodoUserIds.add(66); // N2's collector resolve throws (transient Firestore)

    const res = await reprocessNotifications(
      asDb(db),
      { now: 10_000, olderThanMs: 100 },
      fakeDeps(),
    );
    expect(res.processed).toBe(1); // N1 reconciled
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.message).toContain('firestore unavailable');
    expect(db.docs(NOTIF).has('N1')).toBe(false); // N1 deleted on success
    const n2 = db.docs(NOTIF).get('N2')!; // N2 bumped, not aborted
    expect(n2.status).toBe('failed');
    expect(n2.tentativas).toBe(1);
  });
});
