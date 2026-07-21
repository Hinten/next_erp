import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

import {
  MAX_TENTATIVAS,
  TASK_MAX_ATTEMPTS,
  handleNotificationTask,
  isKnownTopic,
  parseNotificationBody,
  reprocessNotifications,
  resolveIntegracaoByUserId,
} from './notificacao';

// #441 default migration-runner wiring (`notificacao.ts`'s `runUptinMigration`)
// is mocked at its three seams — `handleUptinMigration` itself, the ML-context
// loader, and the API factory — so "default wiring" tests below prove the wire-
// up (loadMercadoLivreContext → createMercadoLivreApi → handleUptinMigration)
// runs with NO real network/Firestore-token dependency. Everything else these
// modules export stays real (spread from `importActual`).
const h = vi.hoisted(() => ({
  handleUptinMigration: vi.fn(async () => {}),
  loadMercadoLivreContext: vi.fn(),
  createMercadoLivreApi: vi.fn(() => ({}) as never),
}));
vi.mock('./importMigration', () => ({ handleUptinMigration: h.handleUptinMigration }));
vi.mock('./mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('./mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadMercadoLivreContext };
});
vi.mock('@delfrance/integrations-mercado-livre', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/integrations-mercado-livre')>();
  return { ...actual, createMercadoLivreApi: h.createMercadoLivreApi };
});

/* ----------------------------- fake Firestore ---------------------------- */
// Supports the access shapes the admin handles use: doc get/set/create/delete,
// and chained where/orderBy/limit/get queries (ops: '==', '<', 'in'). Fault
// injection: an `integracao` query for a user_id in `failIntegracaoUserIds`
// throws (models a transient Firestore failure during account resolution).

type DocData = Record<string, unknown>;
type Clause = { field: string; op: string; value: unknown };

function matches(data: DocData, clauses: Clause[]): boolean {
  return clauses.every((c) => {
    const v = data[c.field];
    if (c.op === '==') return v === c.value;
    if (c.op === '<') return typeof v === 'number' && v < (c.value as number);
    if (c.op === 'in') return Array.isArray(c.value) && c.value.includes(v);
    return false;
  });
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  /** Fault injection: an `integracao` resolve query for these user_ids throws. */
  readonly failIntegracaoUserIds = new Set<number>();
  /** Fault injection: a `.create()` at one of these doc ids throws (Firestore down). */
  readonly failCreateIds = new Set<string>();
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
        if (path === 'integracao') {
          const uid = clauses.find((c) => c.field === 'user_id' && c.op === '==');
          if (uid && self.failIntegracaoUserIds.has(uid.value as number)) {
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

  /** collectionGroup over cols whose leaf name matches — the `items` status-sync's
   * link lookup goes through it; the deep sync behavior is in itemsStatusSync.test. */
  collectionGroup(groupId: string) {
    const entries: Array<[string, DocData, string]> = [];
    for (const [path, col] of this.cols) {
      if (path.split('/').pop() === groupId) {
        for (const [id, d] of col) entries.push([id, d, path]);
      }
    }
    const clauses: Clause[] = [];
    const q = {
      where: (field: string, op: string, value: unknown) => {
        clauses.push({ field, op, value });
        return q;
      },
      get: async () => ({
        docs: entries
          .filter(([, d]) => matches(d, clauses))
          .map(([id, d, colPath]) => {
            const segs = colPath.split('/').filter(Boolean);
            return {
              id,
              data: () => d,
              exists: true,
              ref: { parent: { parent: { id: segs[segs.length - 2] ?? '' } } },
            };
          }),
      }),
    };
    return q;
  }
}

const NOTIF = 'notificacoesMercadoLivre';
const asDb = (db: FakeDb) => db as unknown as Firestore;

function seedConta(db: FakeDb, id: string, userId: number, ativo = true): void {
  db.seed('integracao', id, { tipo: 1, user_id: userId, ativo, nome: id });
}
/** A lean ML-wire payload (what the receiver enqueues / the sweep rebuilds). */
function payloadOf(over: DocData = {}): DocData {
  return {
    id: 'N1',
    resource: '/orders/123',
    topic: 'orders_v2',
    user_id: 55,
    application_id: 999,
    attempts: 1,
    sent: 1_700_000_000_000,
    received: 1_700_000_000_000,
    ...over,
  };
}
/** A persisted `failed` notification doc (what the sweep re-drives). */
function seedFailed(db: FakeDb, id: string, over: DocData = {}): void {
  db.seed(NOTIF, id, {
    id,
    resource: '/orders/1',
    topic: 'orders_v2',
    user_id: 55,
    application_id: 999,
    attempts: 1,
    sent: 1_700_000_000_000,
    received: 1_700_000_000_000,
    status: 'failed',
    tentativas: 0,
    erro: 'earlier failure',
    processedAt: 1_000,
    ...over,
  });
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.handleUptinMigration.mockClear();
  h.loadMercadoLivreContext.mockReset(); // per-test mockResolvedValue must not leak
  h.createMercadoLivreApi.mockClear();
});

/* ------------------------------ parse + topics --------------------------- */

describe('parseNotificationBody', () => {
  it('extracts a well-formed notification into a lean payload (accepts _id and id)', () => {
    const a = parseNotificationBody({
      _id: 'N1',
      resource: '/orders/123',
      topic: 'orders_v2',
      user_id: 55,
      application_id: 7,
      attempts: 2,
      sent: '2025-03-05T20:27:20.218Z',
      received: 1_741_196_520_060,
    });
    expect(a?.id).toBe('N1');
    expect(a?.payload).toMatchObject({
      id: 'N1',
      resource: '/orders/123',
      topic: 'orders_v2',
      user_id: 55,
    });
    // sent/received are normalized to epoch millis at the source
    expect(a?.payload.sent).toBe(Date.parse('2025-03-05T20:27:20.218Z'));
    expect(a?.payload.received).toBe(1_741_196_520_060);
    // the lean payload carries NO local resilience fields (those belong only to
    // a persisted failure doc)
    expect(a?.payload).not.toHaveProperty('status');
    expect(a?.payload).not.toHaveProperty('tentativas');
    expect(parseNotificationBody({ id: 'N2', resource: '/items/MLB1', topic: 'items' })?.id).toBe(
      'N2',
    );
  });

  it('normalizes an empty/unparseable sent/received to null (never a strict-write reject)', () => {
    const p = parseNotificationBody({
      resource: '/orders/1',
      topic: 'orders_v2',
      sent: '',
      received: 'not-a-date',
    });
    expect(p?.payload.sent).toBeNull();
    expect(p?.payload.received).toBeNull();
    const n = parseNotificationBody({ resource: '/orders/1', topic: 'orders_v2', sent: 42 });
    expect(n?.payload.sent).toBe(42);
  });

  it('rejects noise: non-object, arrays, missing topic/resource', () => {
    expect(parseNotificationBody(null)).toBeNull();
    expect(parseNotificationBody('x')).toBeNull();
    expect(parseNotificationBody([1, 2])).toBeNull();
    expect(parseNotificationBody({ topic: 'orders_v2' })).toBeNull();
    expect(parseNotificationBody({ resource: '/orders/1' })).toBeNull();
  });
});

describe('isKnownTopic', () => {
  it('knows the ML topics; unknown ones are not', () => {
    expect(isKnownTopic('orders_v2')).toBe(true);
    expect(isKnownTopic('payments')).toBe(true);
    expect(isKnownTopic('public_offers')).toBe(false);
    expect(isKnownTopic('nonsense')).toBe(false);
  });
});

/* -------------------------------- resolver ------------------------------- */

describe('resolveIntegracaoByUserId', () => {
  it('finds the active ML account for the seller id', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    seedConta(db, 'conta-B', 66);
    expect(await resolveIntegracaoByUserId(asDb(db), 55)).toBe('conta-A');
  });

  it('ignores inactive accounts and returns null on no match / null id', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55, false); // inactive
    expect(await resolveIntegracaoByUserId(asDb(db), 55)).toBeNull();
    expect(await resolveIntegracaoByUserId(asDb(db), 999)).toBeNull();
    expect(await resolveIntegracaoByUserId(asDb(db), null)).toBeNull();
  });
});

/* ----------------------------- handleNotificationTask -------------------- */

describe('handleNotificationTask', () => {
  it('known topic + resolved account → done, and persists NOTHING (the cost win)', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const r = await handleNotificationTask(asDb(db), payloadOf(), 0);
    expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'orders_v2' });
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('unknown topic → parked (terminal), persisted', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const r = await handleNotificationTask(asDb(db), payloadOf({ topic: 'public_offers' }), 0);
    expect(r.outcome).toBe('parked');
    const doc = db.docs(NOTIF).get('N1')!;
    expect(doc.status).toBe('parked');
    expect(typeof doc.processedAt).toBe('number');
  });

  it('no active account → failed, persisted immediately (the sweep re-drives)', async () => {
    const db = new FakeDb();
    const r = await handleNotificationTask(asDb(db), payloadOf({ user_id: 999 }), 0);
    expect(r.outcome).toBe('failed');
    const doc = db.docs(NOTIF).get('N1')!;
    expect(doc.status).toBe('failed');
    expect(doc.tentativas).toBe(0);
    expect(doc.resource).toBe('/orders/123'); // ML wire fields persisted
  });

  it('transient failure re-throws while under the attempt cap (queue retries)', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    db.failIntegracaoUserIds.add(55);
    await expect(handleNotificationTask(asDb(db), payloadOf(), 0)).rejects.toThrow(
      'firestore unavailable',
    );
    expect(db.docs(NOTIF).size).toBe(0); // not persisted until the final attempt
  });

  it('transient failure on the FINAL attempt persists failed instead of throwing', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    db.failIntegracaoUserIds.add(55);
    const r = await handleNotificationTask(asDb(db), payloadOf(), TASK_MAX_ATTEMPTS - 1);
    expect(r.outcome).toBe('failed');
    const doc = db.docs(NOTIF).get('N1')!;
    expect(doc.status).toBe('failed');
    expect(doc.erro).toContain('firestore unavailable');
  });

  it('re-throws the ORIGINAL error (surfacing the loss) when the final-attempt persist also fails', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    db.failIntegracaoUserIds.add(55); // resolve throws (transient)
    db.failCreateIds.add('N1'); // the recovery persist ALSO fails (correlated outage)
    // the original resolve error surfaces (NOT the persist's 'create unavailable')
    await expect(
      handleNotificationTask(asDb(db), payloadOf(), TASK_MAX_ATTEMPTS - 1),
    ).rejects.toThrow('firestore unavailable');
    expect(db.docs(NOTIF).size).toBe(0); // nothing persisted — dropped, but observably re-thrown
  });

  it('malformed payload → dropped, no persist, no retry', async () => {
    const db = new FakeDb();
    const r = await handleNotificationTask(asDb(db), { topic: 'orders_v2' }, 0); // missing resource
    expect(r.outcome).toBe('dropped');
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('items topic + a linked produto → dispatches the status-sync (resolver built, item fetched), acks done', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    // A linked listing already at the item's status → the sync resolves 'unchanged'
    // after fetching, which still proves the link-first resolver + fetch ran.
    db.seed('produtos/prod1/produtoMercadoLivre', 'link1', {
      id: 'MLB1',
      contaOuterRef: 'documents/integracao/conta-A',
      title: 'x',
      estado: 'pa',
      status: 'paused',
      sub_status: null,
      isUserProductModel: false,
    });
    const getItem = vi.fn(async () => ({ id: 'MLB1', status: 'paused' }));
    const resolveItemsApi = vi.fn(async () => ({ getItem }) as never);
    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({ id: 'N9', resource: '/items/MLB1', topic: 'items' }),
      0,
      resolveItemsApi,
    );
    expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'items' });
    expect(resolveItemsApi).toHaveBeenCalledWith(asDb(db), 'conta-A');
    expect(getItem).toHaveBeenCalledWith('MLB1');
    expect(db.docs(NOTIF).size).toBe(0); // status-sync persists nothing
  });

  it('items topic + NO linked produto → link-first short-circuits (no ML call), acks done', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const resolveItemsApi = vi.fn(async () => ({ getItem: vi.fn() }) as never);
    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({ id: 'N10', resource: '/items/MLB404', topic: 'items' }),
      0,
      resolveItemsApi,
    );
    expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'items' });
    expect(resolveItemsApi).not.toHaveBeenCalled(); // no link → no external call
    expect(db.docs(NOTIF).size).toBe(0);
  });
});

/* ------------------ #441 migration takeover wiring (items topic) --------- */

describe('handleNotificationTask — #441 migration takeover wiring', () => {
  const LINK_PATH = 'produtos/prod1/produtoMercadoLivre';

  function seedMigrationLink(db: FakeDb): void {
    db.seed(LINK_PATH, 'link1', {
      id: 'MLB1',
      contaOuterRef: 'documents/integracao/conta-A',
      title: 'x',
      estado: 'p',
      status: 'active',
      sub_status: null,
      isUserProductModel: false,
    });
  }
  /** A resolver whose `getItem` returns a closed, migration-source-tagged listing. */
  function migrationResolveItemsApi() {
    const getItem = vi.fn(async () => ({
      id: 'MLB1',
      status: 'closed',
      tags: ['variations_migration_source'],
    }));
    return vi.fn(async () => ({ getItem }) as never);
  }

  it('default wiring (no override): resolves the ML context + api and calls handleUptinMigration', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    seedMigrationLink(db);
    h.loadMercadoLivreContext.mockResolvedValue({
      integracaoId: 'conta-A',
      conta: {
        user_id: 999,
        tabelaNormalOuterRef: 'documents/listaDePrecos/l1',
        tabelaPromocionalOuterRef: null,
        depositoOuterRef: null,
      },
      resolveChannelContext: async () => ({
        integracaoId: 'conta-A',
        accessToken: 'AT',
        account: {},
      }),
    });

    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({ id: 'N20', resource: '/items/MLB1', topic: 'items' }),
      0,
      migrationResolveItemsApi(),
      // migrationRunner OMITTED — the production default must be used.
    );

    expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'items' });
    expect(h.loadMercadoLivreContext).toHaveBeenCalledWith(asDb(db), 'conta-A');
    expect(h.createMercadoLivreApi).toHaveBeenCalled();
    expect(h.handleUptinMigration).toHaveBeenCalledWith(
      expect.objectContaining({ integracaoId: 'conta-A', sellerUserId: 999 }),
      'MLB1',
      expect.objectContaining({ produtoId: 'prod1', linkDocId: 'link1' }),
    );
  });

  it('an injected migrationRunner is threaded instead of the default, which is never invoked', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    seedMigrationLink(db);
    const migrationRunner = vi.fn(async () => {});

    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({ id: 'N21', resource: '/items/MLB1', topic: 'items' }),
      0,
      migrationResolveItemsApi(),
      migrationRunner,
    );

    expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'items' });
    expect(migrationRunner).toHaveBeenCalledWith(
      asDb(db),
      'conta-A',
      'MLB1',
      expect.objectContaining({ produtoId: 'prod1', linkDocId: 'link1' }),
    );
    expect(h.handleUptinMigration).not.toHaveBeenCalled(); // default bypassed entirely
    expect(h.loadMercadoLivreContext).not.toHaveBeenCalled();
  });

  it('a non-migration items notification is unaffected by the #441 wiring (no runner call at all)', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    db.seed(LINK_PATH, 'link1', {
      id: 'MLB1',
      contaOuterRef: 'documents/integracao/conta-A',
      title: 'x',
      estado: 'pa',
      status: 'paused',
      sub_status: null,
      isUserProductModel: false,
    });
    const getItem = vi.fn(async () => ({ id: 'MLB1', status: 'paused' }));
    const resolveItemsApi = vi.fn(async () => ({ getItem }) as never);

    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({ id: 'N22', resource: '/items/MLB1', topic: 'items' }),
      0,
      resolveItemsApi,
    );

    expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'items' });
    expect(h.handleUptinMigration).not.toHaveBeenCalled();
    expect(h.loadMercadoLivreContext).not.toHaveBeenCalled();
  });
});

/* ----------------------------- reprocess sweep --------------------------- */

describe('reprocessNotifications', () => {
  it('re-drives failed docs older than the window, deduped by resource, deletes on success', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    seedFailed(db, 'N1', { processedAt: 1_000, resource: '/orders/1' });
    seedFailed(db, 'N2', { processedAt: 1_000, resource: '/orders/1' }); // dup resource
    seedFailed(db, 'N3', { processedAt: 1_000, resource: '/orders/2' });
    seedFailed(db, 'N4', { processedAt: 9_999_999_999_999, resource: '/orders/3' }); // too new
    seedFailed(db, 'N5', { processedAt: 1_000, resource: '/orders/4', status: 'parked' }); // terminal

    const res = await reprocessNotifications(asDb(db), { now: 10_000, olderThanMs: 100 });
    // N1 + N3 processed (N2 deduped, N4 too new, N5 parked/excluded by query)
    expect(res.processed).toBe(2);
    expect(res.outcomes.done).toBe(2);
    expect(res.errors).toEqual([]);
    expect(db.docs(NOTIF).has('N1')).toBe(false); // deleted on success
    expect(db.docs(NOTIF).has('N3')).toBe(false);
    expect(db.docs(NOTIF).has('N2')).toBe(true); // dup left for a later run
  });

  it('keeps a still-unresolvable doc failed (tentativas++) under the cap; parks at the cap', async () => {
    const db = new FakeDb();
    // no conta → unresolvable
    seedFailed(db, 'N1', { processedAt: 1_000, resource: '/orders/1', user_id: 77, tentativas: 0 });
    seedFailed(db, 'N2', {
      processedAt: 1_000,
      resource: '/orders/2',
      user_id: 77,
      tentativas: MAX_TENTATIVAS - 1,
    });
    const res = await reprocessNotifications(asDb(db), { now: 10_000, olderThanMs: 100 });
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

  it('isolates a per-doc transient failure — one throw does not abort the batch', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    seedFailed(db, 'N1', { processedAt: 1_000, resource: '/orders/1', user_id: 55 });
    seedFailed(db, 'N2', { processedAt: 1_000, resource: '/orders/2', user_id: 66 });
    db.failIntegracaoUserIds.add(66); // N2's resolve throws (transient Firestore)

    const res = await reprocessNotifications(asDb(db), { now: 10_000, olderThanMs: 100 });
    expect(res.processed).toBe(1); // N1 done
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.message).toContain('firestore unavailable');
    expect(db.docs(NOTIF).has('N1')).toBe(false); // N1 deleted on success
    const n2 = db.docs(NOTIF).get('N2')!; // N2 bumped, not aborted
    expect(n2.status).toBe('failed');
    expect(n2.tentativas).toBe(1);
  });
});
