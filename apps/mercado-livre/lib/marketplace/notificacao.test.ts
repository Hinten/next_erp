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
// and the Step 9 default order/payment/shipment-import wiring (`runOrderImport`
// / `runPaymentImport` / `runShipmentImport`) are mocked at their shared seams
// — `handleUptinMigration` / `importPedidoMercadoLivre` /
// `importPagamentoMercadoLivre` / `importShipmentMercadoLivre` themselves, the
// ML-context loader, and the API factory — so "default wiring" tests below
// prove the wire-up (loadMercadoLivreContext → createMercadoLivreApi →
// handleUptinMigration/importPedidoMercadoLivre/importPagamentoMercadoLivre/
// importShipmentMercadoLivre) runs with NO real network/Firestore-token
// dependency. Everything else these modules export stays real (spread from
// `importActual`).
const h = vi.hoisted(() => ({
  handleUptinMigration: vi.fn(async () => {}),
  loadMercadoLivreContext: vi.fn(),
  createMercadoLivreApi: vi.fn(() => ({}) as never),
  importPedidoMercadoLivre: vi.fn(
    async (_deps: { nowUs: number; nowMs: number; integracaoId: string }, _resourceId: number) => ({
      pedidoId: 'ped1',
      created: true,
      skipped: null,
    }),
  ),
  importPagamentoMercadoLivre: vi.fn(
    async (_deps: { nowUs: number; contaId: string }, _resourceId: number) => ({
      pedidoId: 'ped1',
      skipped: null,
    }),
  ),
  importShipmentMercadoLivre: vi.fn(
    async (_deps: { nowUs: number; integracaoId: string }, _resourceId: number) => ({
      pedidoId: 'ped1',
      skipped: null,
    }),
  ),
  importClaimMercadoLivre: vi.fn(
    async (_deps: { nowUs: number; nowMs: number; integracaoId: string }, _resourceId: number) => ({
      pedidoId: 'ped1',
      incidenteId: 'inc1',
      conversaId: 'conv1',
      skipped: null,
    }),
  ),
  // The Step 14 default claim wiring resolves the Storage bucket via
  // `tryGetAdminBucket` — a sentinel here proves it is threaded verbatim.
  fakeBucket: { __bucket: true },
}));
vi.mock('./importMigration', () => ({ handleUptinMigration: h.handleUptinMigration }));
vi.mock('./orderImport', () => ({ importPedidoMercadoLivre: h.importPedidoMercadoLivre }));
vi.mock('./orderPaymentImport', () => ({
  importPagamentoMercadoLivre: h.importPagamentoMercadoLivre,
}));
vi.mock('./orderShipmentImport', () => ({
  importShipmentMercadoLivre: h.importShipmentMercadoLivre,
}));
vi.mock('./claimImport', () => ({ importClaimMercadoLivre: h.importClaimMercadoLivre }));
vi.mock('../firebase/admin', async (importActual) => {
  const actual = await importActual<typeof import('../firebase/admin')>();
  return { ...actual, tryGetAdminBucket: () => h.fakeBucket as never };
});
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
/**
 * A lean ML-wire payload (what the receiver enqueues / the sweep rebuilds).
 * Default topic is `questions` — a KNOWN but permanently-postponed topic (see
 * `notificacao.ts`'s module doc) — so a bare `payloadOf()` exercises the
 * generic no-op dispatch fallback, not the Step 9 order-import branch that now
 * owns `orders_v2`/`orders` (see the dedicated describe block below).
 */
function payloadOf(over: DocData = {}): DocData {
  return {
    id: 'N1',
    resource: '/questions/123',
    topic: 'questions',
    user_id: 55,
    application_id: 999,
    attempts: 1,
    sent: 1_700_000_000_000,
    received: 1_700_000_000_000,
    ...over,
  };
}
/**
 * A persisted `failed` notification doc (what the sweep re-drives). Same
 * generic-inert-topic default as `payloadOf` — tests below that only override
 * `resource` (for dedup/aging) keep exercising the no-op fallback, not order
 * import.
 */
function seedFailed(db: FakeDb, id: string, over: DocData = {}): void {
  db.seed(NOTIF, id, {
    id,
    resource: '/questions/1',
    topic: 'questions',
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
  h.importPedidoMercadoLivre.mockClear();
  h.importPagamentoMercadoLivre.mockClear();
  h.importShipmentMercadoLivre.mockClear();
  h.importClaimMercadoLivre.mockClear();
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
    expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'questions' });
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
    expect(doc.resource).toBe('/questions/123'); // ML wire fields persisted
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
      { resolveItemsApi },
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
      { resolveItemsApi },
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
      // migrationRunner OMITTED — the production default must be used.
      { resolveItemsApi: migrationResolveItemsApi() },
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
      { resolveItemsApi: migrationResolveItemsApi(), migrationRunner },
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
      { resolveItemsApi },
    );

    expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'items' });
    expect(h.handleUptinMigration).not.toHaveBeenCalled();
    expect(h.loadMercadoLivreContext).not.toHaveBeenCalled();
  });
});

/* --------------- orders_v2/orders order-import dispatch (Step 9) --------- */

describe('handleNotificationTask — orders_v2/orders order-import dispatch (Step 9)', () => {
  it('orders_v2: parses the numeric resource id and routes it to the injected runner, acks done with nothing persisted', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const orderImportRunner = vi.fn(async () => ({
      pedidoId: 'ped1',
      created: true,
      skipped: null,
    }));
    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({ id: 'N40', resource: '/orders/987654', topic: 'orders_v2' }),
      0,
      { orderImportRunner },
    );
    expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'orders_v2' });
    expect(orderImportRunner).toHaveBeenCalledWith(asDb(db), 'conta-A', 987654);
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('orders (legacy alias): dispatches exactly like orders_v2', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const orderImportRunner = vi.fn(async () => ({
      pedidoId: 'ped2',
      created: false,
      skipped: null,
    }));
    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({ id: 'N41', resource: '/orders/42', topic: 'orders' }),
      0,
      { orderImportRunner },
    );
    expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'orders' });
    expect(orderImportRunner).toHaveBeenCalledWith(asDb(db), 'conta-A', 42);
  });

  it('tolerates a bare numeric resource with no path segments', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const orderImportRunner = vi.fn(async () => ({
      pedidoId: null,
      created: false,
      skipped: null,
    }));
    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({ id: 'N42', resource: '2001', topic: 'orders_v2' }),
      0,
      { orderImportRunner },
    );
    expect(r.outcome).toBe('done');
    expect(orderImportRunner).toHaveBeenCalledWith(asDb(db), 'conta-A', 2001);
  });

  it('a skipped import (seller-mismatch/no-buyer) still acks done — nothing persisted, nothing thrown', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const orderImportRunner = vi.fn(async () => ({
      pedidoId: null,
      created: false,
      skipped: 'seller-mismatch' as const,
    }));
    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({ id: 'N43', resource: '/orders/5', topic: 'orders_v2' }),
      0,
      { orderImportRunner },
    );
    expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'orders_v2' });
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('a malformed (non-numeric) resource is dropped WITHOUT dispatching to the runner', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const orderImportRunner = vi.fn(async () => ({
      pedidoId: null,
      created: false,
      skipped: null,
    }));
    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({ id: 'N44', resource: '/orders/abc', topic: 'orders_v2' }),
      0,
      { orderImportRunner },
    );
    expect(r).toMatchObject({ outcome: 'dropped', integracaoId: 'conta-A', topic: 'orders_v2' });
    expect(orderImportRunner).not.toHaveBeenCalled();
    expect(db.docs(NOTIF).size).toBe(0); // dropped — no persist
  });

  it('the runner throwing on a non-final attempt propagates (queue retries)', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const orderImportRunner = vi.fn(async () => {
      throw new Error('ml api unavailable');
    });
    await expect(
      handleNotificationTask(
        asDb(db),
        payloadOf({ id: 'N45', resource: '/orders/7', topic: 'orders_v2' }),
        0,
        { orderImportRunner },
      ),
    ).rejects.toThrow('ml api unavailable');
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('the runner throwing on the FINAL attempt persists failed (reuses the existing final-attempt harness)', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const orderImportRunner = vi.fn(async () => {
      throw new Error('ml api unavailable');
    });
    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({ id: 'N46', resource: '/orders/8', topic: 'orders_v2' }),
      TASK_MAX_ATTEMPTS - 1,
      { orderImportRunner },
    );
    expect(r.outcome).toBe('failed');
    const doc = db.docs(NOTIF).get('N46')!;
    expect(doc.status).toBe('failed');
    expect(doc.erro).toContain('ml api unavailable');
  });

  it('default wiring (no override): resolves the ML context + api and calls importPedidoMercadoLivre with one clock read', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    h.loadMercadoLivreContext.mockResolvedValue({
      integracaoId: 'conta-A',
      conta: { user_id: 999 },
      resolveChannelContext: async () => ({
        integracaoId: 'conta-A',
        accessToken: 'AT',
        account: {},
      }),
    });
    h.importPedidoMercadoLivre.mockResolvedValue({
      pedidoId: 'ped9',
      created: true,
      skipped: null,
    });

    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({ id: 'N47', resource: '/orders/9', topic: 'orders_v2' }),
      0,
      // runners omitted entirely — the production defaults must be used.
    );

    expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'orders_v2' });
    expect(h.loadMercadoLivreContext).toHaveBeenCalledWith(asDb(db), 'conta-A');
    expect(h.createMercadoLivreApi).toHaveBeenCalled();
    expect(h.importPedidoMercadoLivre).toHaveBeenCalledWith(
      expect.objectContaining({ integracaoId: 'conta-A' }),
      9,
    );
    const [depsArg] = h.importPedidoMercadoLivre.mock.calls[0]!;
    // ONE clock read: nowUs is nowMs converted, not re-read independently.
    expect(depsArg.nowUs).toBe(depsArg.nowMs * 1000);
  });
});

/* ------------- payments/shipments import dispatch (Step 9 PR 3) ---------- */

describe('handleNotificationTask — payments/shipments import dispatch (Step 9 PR 3)', () => {
  describe('payments', () => {
    it('parses the numeric resource id and routes it to the injected paymentImportRunner (not order/shipment runners), acks done with nothing persisted', async () => {
      const db = new FakeDb();
      seedConta(db, 'conta-A', 55);
      const orderImportRunner = vi.fn(async () => ({
        pedidoId: 'ped-o',
        created: true,
        skipped: null,
      }));
      const paymentImportRunner = vi.fn(async () => ({ pedidoId: 'ped1', skipped: null }));
      const shipmentImportRunner = vi.fn(async () => ({ pedidoId: 'ped-s', skipped: null }));
      const r = await handleNotificationTask(
        asDb(db),
        payloadOf({ id: 'N60', resource: '/payments/123456', topic: 'payments' }),
        0,
        { orderImportRunner, paymentImportRunner, shipmentImportRunner },
      );
      expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'payments' });
      expect(paymentImportRunner).toHaveBeenCalledWith(asDb(db), 'conta-A', 123456);
      expect(orderImportRunner).not.toHaveBeenCalled();
      expect(shipmentImportRunner).not.toHaveBeenCalled();
      expect(db.docs(NOTIF).size).toBe(0);
    });

    it('a skipped payment import still acks done — nothing persisted, nothing thrown', async () => {
      const db = new FakeDb();
      seedConta(db, 'conta-A', 55);
      const paymentImportRunner = vi.fn(async () => ({
        pedidoId: null,
        skipped: 'payment-404' as const,
      }));
      const r = await handleNotificationTask(
        asDb(db),
        payloadOf({ id: 'N61', resource: '/payments/1', topic: 'payments' }),
        0,
        { paymentImportRunner },
      );
      expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'payments' });
      expect(db.docs(NOTIF).size).toBe(0);
    });

    it('a malformed (non-numeric) resource is dropped WITHOUT dispatching to the runner', async () => {
      const db = new FakeDb();
      seedConta(db, 'conta-A', 55);
      const paymentImportRunner = vi.fn(async () => ({ pedidoId: null, skipped: null }));
      const r = await handleNotificationTask(
        asDb(db),
        payloadOf({ id: 'N62', resource: '/payments/abc', topic: 'payments' }),
        0,
        { paymentImportRunner },
      );
      expect(r).toMatchObject({ outcome: 'dropped', integracaoId: 'conta-A', topic: 'payments' });
      expect(paymentImportRunner).not.toHaveBeenCalled();
      expect(db.docs(NOTIF).size).toBe(0);
    });

    it('the runner throwing on a non-final attempt propagates (queue retries)', async () => {
      const db = new FakeDb();
      seedConta(db, 'conta-A', 55);
      const paymentImportRunner = vi.fn(async () => {
        throw new Error('ml api unavailable');
      });
      await expect(
        handleNotificationTask(
          asDb(db),
          payloadOf({ id: 'N63', resource: '/payments/7', topic: 'payments' }),
          0,
          { paymentImportRunner },
        ),
      ).rejects.toThrow('ml api unavailable');
      expect(db.docs(NOTIF).size).toBe(0);
    });

    it('the runner throwing on the FINAL attempt persists failed (reuses the existing final-attempt harness)', async () => {
      const db = new FakeDb();
      seedConta(db, 'conta-A', 55);
      const paymentImportRunner = vi.fn(async () => {
        throw new Error('ml api unavailable');
      });
      const r = await handleNotificationTask(
        asDb(db),
        payloadOf({ id: 'N64', resource: '/payments/8', topic: 'payments' }),
        TASK_MAX_ATTEMPTS - 1,
        { paymentImportRunner },
      );
      expect(r.outcome).toBe('failed');
      const doc = db.docs(NOTIF).get('N64')!;
      expect(doc.status).toBe('failed');
      expect(doc.erro).toContain('ml api unavailable');
    });

    it('default wiring (no override): resolves the ML context + api and calls importPagamentoMercadoLivre with {db, api, contaId, nowUs}', async () => {
      const db = new FakeDb();
      seedConta(db, 'conta-A', 55);
      h.loadMercadoLivreContext.mockResolvedValue({
        integracaoId: 'conta-A',
        conta: { user_id: 999 },
        resolveChannelContext: async () => ({
          integracaoId: 'conta-A',
          accessToken: 'AT',
          account: {},
        }),
      });
      h.importPagamentoMercadoLivre.mockResolvedValue({ pedidoId: 'ped9', skipped: null });
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      try {
        const r = await handleNotificationTask(
          asDb(db),
          payloadOf({ id: 'N65', resource: '/payments/9', topic: 'payments' }),
          0,
          // runners omitted entirely — the production defaults must be used.
        );
        expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'payments' });
        expect(h.loadMercadoLivreContext).toHaveBeenCalledWith(asDb(db), 'conta-A');
        expect(h.createMercadoLivreApi).toHaveBeenCalled();
        expect(h.importPagamentoMercadoLivre).toHaveBeenCalledWith(
          expect.objectContaining({ contaId: 'conta-A', nowUs: 1_700_000_000_000 * 1000 }),
          9,
        );
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  describe('shipments', () => {
    it('parses the numeric resource id and routes it to the injected shipmentImportRunner (not order/payment runners), acks done with nothing persisted', async () => {
      const db = new FakeDb();
      seedConta(db, 'conta-A', 55);
      const orderImportRunner = vi.fn(async () => ({
        pedidoId: 'ped-o',
        created: true,
        skipped: null,
      }));
      const paymentImportRunner = vi.fn(async () => ({ pedidoId: 'ped-p', skipped: null }));
      const shipmentImportRunner = vi.fn(async () => ({ pedidoId: 'ped1', skipped: null }));
      const r = await handleNotificationTask(
        asDb(db),
        payloadOf({ id: 'N70', resource: '/shipments/987654', topic: 'shipments' }),
        0,
        { orderImportRunner, paymentImportRunner, shipmentImportRunner },
      );
      expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'shipments' });
      expect(shipmentImportRunner).toHaveBeenCalledWith(asDb(db), 'conta-A', 987654);
      expect(orderImportRunner).not.toHaveBeenCalled();
      expect(paymentImportRunner).not.toHaveBeenCalled();
      expect(db.docs(NOTIF).size).toBe(0);
    });

    it('a skipped shipment import (e.g. no freteInicial yet) still acks done — nothing persisted, nothing thrown', async () => {
      const db = new FakeDb();
      seedConta(db, 'conta-A', 55);
      const shipmentImportRunner = vi.fn(async () => ({
        pedidoId: 'ped1',
        skipped: 'sem-frete-inicial' as const,
      }));
      const r = await handleNotificationTask(
        asDb(db),
        payloadOf({ id: 'N71', resource: '/shipments/1', topic: 'shipments' }),
        0,
        { shipmentImportRunner },
      );
      expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'shipments' });
      expect(db.docs(NOTIF).size).toBe(0);
    });

    it('a malformed (non-numeric) resource is dropped WITHOUT dispatching to the runner', async () => {
      const db = new FakeDb();
      seedConta(db, 'conta-A', 55);
      const shipmentImportRunner = vi.fn(async () => ({ pedidoId: null, skipped: null }));
      const r = await handleNotificationTask(
        asDb(db),
        payloadOf({ id: 'N72', resource: '/shipments/abc', topic: 'shipments' }),
        0,
        { shipmentImportRunner },
      );
      expect(r).toMatchObject({ outcome: 'dropped', integracaoId: 'conta-A', topic: 'shipments' });
      expect(shipmentImportRunner).not.toHaveBeenCalled();
      expect(db.docs(NOTIF).size).toBe(0);
    });

    it('the runner throwing on a non-final attempt propagates (queue retries)', async () => {
      const db = new FakeDb();
      seedConta(db, 'conta-A', 55);
      const shipmentImportRunner = vi.fn(async () => {
        throw new Error('ml api unavailable');
      });
      await expect(
        handleNotificationTask(
          asDb(db),
          payloadOf({ id: 'N73', resource: '/shipments/7', topic: 'shipments' }),
          0,
          { shipmentImportRunner },
        ),
      ).rejects.toThrow('ml api unavailable');
      expect(db.docs(NOTIF).size).toBe(0);
    });

    it('the runner throwing on the FINAL attempt persists failed (reuses the existing final-attempt harness)', async () => {
      const db = new FakeDb();
      seedConta(db, 'conta-A', 55);
      const shipmentImportRunner = vi.fn(async () => {
        throw new Error('ml api unavailable');
      });
      const r = await handleNotificationTask(
        asDb(db),
        payloadOf({ id: 'N74', resource: '/shipments/8', topic: 'shipments' }),
        TASK_MAX_ATTEMPTS - 1,
        { shipmentImportRunner },
      );
      expect(r.outcome).toBe('failed');
      const doc = db.docs(NOTIF).get('N74')!;
      expect(doc.status).toBe('failed');
      expect(doc.erro).toContain('ml api unavailable');
    });

    it('default wiring (no override): resolves the ML context + api and calls importShipmentMercadoLivre with {db, api, integracaoId, nowUs}', async () => {
      const db = new FakeDb();
      seedConta(db, 'conta-A', 55);
      h.loadMercadoLivreContext.mockResolvedValue({
        integracaoId: 'conta-A',
        conta: { user_id: 999 },
        resolveChannelContext: async () => ({
          integracaoId: 'conta-A',
          accessToken: 'AT',
          account: {},
        }),
      });
      h.importShipmentMercadoLivre.mockResolvedValue({ pedidoId: 'ped9', skipped: null });
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      try {
        const r = await handleNotificationTask(
          asDb(db),
          payloadOf({ id: 'N75', resource: '/shipments/9', topic: 'shipments' }),
          0,
          // runners omitted entirely — the production defaults must be used.
        );
        expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'shipments' });
        expect(h.loadMercadoLivreContext).toHaveBeenCalledWith(asDb(db), 'conta-A');
        expect(h.createMercadoLivreApi).toHaveBeenCalled();
        expect(h.importShipmentMercadoLivre).toHaveBeenCalledWith(
          expect.objectContaining({ integracaoId: 'conta-A', nowUs: 1_700_000_000_000 * 1000 }),
          9,
        );
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  describe('sweep re-drive threads the payment/shipment runners', () => {
    it('reprocessNotifications passes the injected paymentImportRunner/shipmentImportRunner through to a re-driven payments/shipments doc', async () => {
      const db = new FakeDb();
      seedConta(db, 'conta-A', 55);
      seedFailed(db, 'N80', {
        processedAt: 1_000,
        resource: '/payments/501',
        topic: 'payments',
      });
      seedFailed(db, 'N81', {
        processedAt: 1_000,
        resource: '/shipments/601',
        topic: 'shipments',
      });
      const paymentImportRunner = vi.fn(async () => ({ pedidoId: 'ped1', skipped: null }));
      const shipmentImportRunner = vi.fn(async () => ({ pedidoId: 'ped2', skipped: null }));

      const res = await reprocessNotifications(
        asDb(db),
        { now: 10_000, olderThanMs: 100 },
        { paymentImportRunner, shipmentImportRunner },
      );

      expect(res.processed).toBe(2);
      expect(res.outcomes.done).toBe(2);
      expect(paymentImportRunner).toHaveBeenCalledWith(asDb(db), 'conta-A', 501);
      expect(shipmentImportRunner).toHaveBeenCalledWith(asDb(db), 'conta-A', 601);
      // resolved → both deleted from the failures-only store
      expect(db.docs(NOTIF).has('N80')).toBe(false);
      expect(db.docs(NOTIF).has('N81')).toBe(false);
    });
  });
});

/* ------------------- claims claim-import dispatch (Step 14) ---------------- */

describe('handleNotificationTask — claims claim-import dispatch (Step 14)', () => {
  it('parses the numeric resource id and routes it to the injected claimImportRunner (not the order/payment/shipment runners), acks done with nothing persisted', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const orderImportRunner = vi.fn(async () => ({
      pedidoId: 'ped-o',
      created: true,
      skipped: null,
    }));
    const paymentImportRunner = vi.fn(async () => ({ pedidoId: 'ped-p', skipped: null }));
    const shipmentImportRunner = vi.fn(async () => ({ pedidoId: 'ped-s', skipped: null }));
    const claimImportRunner = vi.fn(async () => ({
      pedidoId: 'ped1',
      incidenteId: 'inc1',
      conversaId: 'conv1',
      skipped: null,
    }));
    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({ id: 'N100', resource: '/claims/5142940410', topic: 'claims' }),
      0,
      { orderImportRunner, paymentImportRunner, shipmentImportRunner, claimImportRunner },
    );
    expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'claims' });
    expect(claimImportRunner).toHaveBeenCalledWith(asDb(db), 'conta-A', 5142940410);
    expect(orderImportRunner).not.toHaveBeenCalled();
    expect(paymentImportRunner).not.toHaveBeenCalled();
    expect(shipmentImportRunner).not.toHaveBeenCalled();
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('a skipped claim import (e.g. claim-404 / reclamacao-do-vendedor) still acks done — nothing persisted, nothing thrown', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const claimImportRunner = vi.fn(async () => ({
      pedidoId: null,
      incidenteId: null,
      conversaId: null,
      skipped: 'claim-404' as const,
    }));
    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({ id: 'N101', resource: '/claims/1', topic: 'claims' }),
      0,
      { claimImportRunner },
    );
    expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'claims' });
    expect(console.warn).toHaveBeenCalledWith(
      '[mercado-livre] claim import skipped',
      expect.objectContaining({ integracaoId: 'conta-A', resourceId: 1, skipped: 'claim-404' }),
    );
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('a malformed (non-numeric) resource is dropped in the TASK phase WITHOUT dispatching to the runner', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const claimImportRunner = vi.fn(async () => ({
      pedidoId: null,
      incidenteId: null,
      conversaId: null,
      skipped: null,
    }));
    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({ id: 'N102', resource: '/claims/abc', topic: 'claims' }),
      0,
      { claimImportRunner },
    );
    expect(r).toMatchObject({ outcome: 'dropped', integracaoId: 'conta-A', topic: 'claims' });
    expect(claimImportRunner).not.toHaveBeenCalled();
    expect(db.docs(NOTIF).size).toBe(0); // dropped — no persist
  });

  it('a malformed resource on a persisted doc PARKS in the SWEEP phase (phase-matrix parity)', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    seedFailed(db, 'N103', { processedAt: 1_000, resource: '/claims/abc', topic: 'claims' });
    const claimImportRunner = vi.fn(async () => ({
      pedidoId: null,
      incidenteId: null,
      conversaId: null,
      skipped: null,
    }));

    const res = await reprocessNotifications(
      asDb(db),
      { now: 10_000, olderThanMs: 100 },
      { claimImportRunner },
    );

    expect(res.outcomes.parked).toBe(1);
    expect(claimImportRunner).not.toHaveBeenCalled();
    const doc = db.docs(NOTIF).get('N103')!;
    expect(doc.status).toBe('parked'); // kept as an audit row, not deleted
  });

  it('the runner throwing on a non-final attempt propagates (queue retries)', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const claimImportRunner = vi.fn(async () => {
      throw new Error('ml api unavailable');
    });
    await expect(
      handleNotificationTask(
        asDb(db),
        payloadOf({ id: 'N104', resource: '/claims/7', topic: 'claims' }),
        0,
        { claimImportRunner },
      ),
    ).rejects.toThrow('ml api unavailable');
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('the runner throwing on the FINAL attempt persists failed (reuses the existing final-attempt harness)', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const claimImportRunner = vi.fn(async () => {
      throw new Error('ml api unavailable');
    });
    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({ id: 'N105', resource: '/claims/8', topic: 'claims' }),
      TASK_MAX_ATTEMPTS - 1,
      { claimImportRunner },
    );
    expect(r.outcome).toBe('failed');
    const doc = db.docs(NOTIF).get('N105')!;
    expect(doc.status).toBe('failed');
    expect(doc.erro).toContain('ml api unavailable');
  });

  it('default wiring (no override): resolves the ML context + api and calls importClaimMercadoLivre with {db, api, integracaoId, conta, nowUs, nowMs, bucket}', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    h.loadMercadoLivreContext.mockResolvedValue({
      integracaoId: 'conta-A',
      conta: { user_id: 999, cor: 4 },
      resolveChannelContext: async () => ({
        integracaoId: 'conta-A',
        accessToken: 'AT',
        account: {},
      }),
    });
    h.importClaimMercadoLivre.mockResolvedValue({
      pedidoId: 'ped9',
      incidenteId: 'inc9',
      conversaId: 'conv9',
      skipped: null,
    });
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const r = await handleNotificationTask(
        asDb(db),
        payloadOf({ id: 'N106', resource: '/claims/9', topic: 'claims' }),
        0,
        // runners omitted entirely — the production defaults must be used.
      );
      expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'claims' });
      expect(h.loadMercadoLivreContext).toHaveBeenCalledWith(asDb(db), 'conta-A');
      expect(h.createMercadoLivreApi).toHaveBeenCalled();
      expect(h.importClaimMercadoLivre).toHaveBeenCalledWith(
        expect.objectContaining({
          db: asDb(db),
          integracaoId: 'conta-A',
          conta: { userId: 999, cor: 4 },
          nowMs: 1_700_000_000_000,
          nowUs: 1_700_000_000_000 * 1000, // ONE clock read, µs converted from ms
          bucket: h.fakeBucket,
        }),
        9,
      );
    } finally {
      nowSpy.mockRestore();
    }
  });
});

/* ------------- items_prices is a PERMANENT no-op (#803) ------------------- */

describe('handleNotificationTask — items_prices is acked and ignored (#803)', () => {
  it('acks done and persists NOTHING — it must not park a doc per delivery', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({ id: 'N90', resource: '/items/MLB777/prices', topic: 'items_prices' }),
      0,
      // runners omitted: there is no items_prices runner to inject any more.
    );
    // `done`, NOT `parked` — the whole point of keeping items_prices in
    // KNOWN_TOPICS. A `parked` here means someone dropped it from the set and
    // every price notification now costs a Firestore write.
    expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'items_prices' });
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('is still known, so it never reaches the unknown-topic park arm', () => {
    expect(isKnownTopic('items_prices')).toBe(true);
  });

  it('a resource shape that used to be "malformed" is now simply ignored, still with no persist', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    // Both of these used to be `dropped` by the resource parser. With no
    // handler there is nothing to parse, so they ack like any other delivery.
    for (const [id, resource] of [
      ['N92', '/items/MLB777'],
      ['N93', 'garbage'],
    ] as const) {
      const r = await handleNotificationTask(
        asDb(db),
        payloadOf({ id, resource, topic: 'items_prices' }),
        0,
      );
      expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A' });
    }
    expect(db.docs(NOTIF).size).toBe(0);
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
