import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';

import {
  MAX_TENTATIVAS,
  MAX_TENTATIVAS_DEFERRED,
  TASK_MAX_ATTEMPTS,
  TOPIC_DISPOSITION,
  handleNotificationTask,
  isIgnoredTopic,
  isKnownTopic,
  parseNotificationBody,
  redriveDeferredForUserId,
  reprocessDeferredNotifications,
  reprocessNotifications,
  resolveIntegracaoByUserId,
  shouldEnqueueTopic,
  userIdResolvivel,
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
          // `mergeIfExists` — what the #808 re-drive uses — is `update()` plus a
          // NOT_FOUND narrow, so an absent doc must raise gRPC 5 rather than be
          // upserted into a ghost carrying only the patch keys.
          update: async (data: DocData) => {
            const current = col.get(docId);
            if (!current) throw Object.assign(new Error('not found'), { code: 5 });
            col.set(docId, { ...current, ...data });
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
 * The topic these fixtures use to exercise the generic `ack` dispatch fallback:
 * recognised, resolves an account, does no work and persists nothing.
 *
 * ⚠️ `items_prices` is the ONLY correct choice, and it is correct by
 * construction rather than by luck. It is the one topic `TOPIC_DISPOSITION`
 * marks `ack` **permanently** — #803 settled that the ERP owns both price
 * tables, and `notificacao.ts` says in as many words not to attach a handler.
 * Every other inert-looking topic is a handler waiting to happen:
 * `questions`/`messages` are `park` today and become `handled` in #532, and
 * `stock-location` is one stock feature away from the same fate. Pointing these
 * fixtures at a topic that later grows a branch is how ~20 unrelated tests
 * suddenly assert the wrong thing (which is exactly what this move repaired).
 *
 * The guard below pins it. Do not repoint these fixtures at a `handled` or
 * `park` topic.
 */
const INERT_TOPIC = 'items_prices';
const INERT_RESOURCE = '/items/MLB123/prices';

/**
 * A lean ML-wire payload (what the receiver enqueues / the sweep rebuilds).
 * Uses {@link INERT_TOPIC}, so a bare `payloadOf()` exercises the generic
 * dispatch fallback, not the Step 9 order-import branch that owns
 * `orders_v2`/`orders` (see the dedicated describe block below).
 */
function payloadOf(over: DocData = {}): DocData {
  return {
    id: 'N1',
    resource: INERT_RESOURCE,
    topic: INERT_TOPIC,
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
 * inert-topic default as `payloadOf` — tests below that only override
 * `resource` (for dedup/aging) keep exercising the fallback, not order import.
 */
function seedFailed(db: FakeDb, id: string, over: DocData = {}): void {
  db.seed(NOTIF, id, {
    id,
    resource: INERT_RESOURCE,
    topic: INERT_TOPIC,
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
  // The conta cache is module-scope and keyed by the document PATH, so a fresh
  // `FakeDb` per test does NOT isolate it — `conta-A` and seller 55 recur
  // throughout this file with deliberately different seeded state.
  __resetAllReadCaches();
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

afterEach(() => {
  __resetAllReadCaches();
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
    expect(a).toMatchObject({
      id: 'N1',
      resource: '/orders/123',
      topic: 'orders_v2',
      user_id: 55,
    });
    // sent/received are normalized to epoch millis at the source
    expect(a?.sent).toBe(Date.parse('2025-03-05T20:27:20.218Z'));
    expect(a?.received).toBe(1_741_196_520_060);
    // the lean payload carries NO local resilience fields (those belong only to
    // a persisted failure doc)
    expect(a).not.toHaveProperty('status');
    expect(a).not.toHaveProperty('tentativas');
    // `_id` is folded into `id`, not carried twice
    expect(a).not.toHaveProperty('_id');
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
    expect(p?.sent).toBeNull();
    expect(p?.received).toBeNull();
    const n = parseNotificationBody({ resource: '/orders/1', topic: 'orders_v2', sent: 42 });
    expect(n?.sent).toBe(42);
  });

  it('rejects noise: non-object, arrays, missing topic/resource', () => {
    expect(parseNotificationBody(null)).toBeNull();
    expect(parseNotificationBody('x')).toBeNull();
    expect(parseNotificationBody([1, 2])).toBeNull();
    expect(parseNotificationBody({ topic: 'orders_v2' })).toBeNull();
    expect(parseNotificationBody({ resource: '/orders/1' })).toBeNull();
  });

  /* ------------------------------- #810 ---------------------------------- */

  it('KEEPS a field ML adds without telling us (the payload is the schema output)', () => {
    const p = parseNotificationBody({
      _id: 'N1',
      resource: '/orders/123',
      topic: 'orders_v2',
      user_id: 55,
      // hypothetical future ML fields
      site_id: 'MLB',
      seller_nickname: 'LOJA',
      priority: 3,
    });
    expect(p).toMatchObject({ site_id: 'MLB', seller_nickname: 'LOJA', priority: 3 });
  });

  it('accepts a numeric-STRING user_id — the old asInt nulled it and stopped ingestion', () => {
    const p = parseNotificationBody({
      resource: '/orders/123',
      topic: 'orders_v2',
      user_id: '55',
      application_id: ' 7 ',
      attempts: '2',
    });
    expect(p).toMatchObject({ user_id: 55, application_id: 7, attempts: 2 });
  });

  it('never lets a provider-supplied resilience field into the payload', () => {
    const p = parseNotificationBody({
      resource: '/orders/1',
      topic: 'orders_v2',
      status: 'parked',
      tentativas: 999,
      erro: 'injected',
      processedAt: 1,
    });
    for (const key of ['status', 'tentativas', 'erro', 'processedAt']) {
      expect(p).not.toHaveProperty(key);
    }
  });

  it('refuses an `_id` that is a PATH rather than a name (auto-id instead)', () => {
    // `docIdOf` feeds this straight into docRef(...).create(): "a/b/c" would
    // land in a nested subcollection the sweep can never see, and "a/b" throws
    // a non-ZodError the receiver rethrows as 5xx.
    for (const _id of ['a/b/c', 'a/b', '.', '..', '__x__', 'z'.repeat(2000)]) {
      const p = parseNotificationBody({ _id, resource: '/orders/1', topic: 'orders_v2' });
      expect(p?.id).toBeNull();
    }
    expect(parseNotificationBody({ _id: 'N-1_ok', resource: '/o/1', topic: 'orders_v2' })?.id).toBe(
      'N-1_ok',
    );
  });

  it('bounds the remainder so it can never break the enqueue or the persist', () => {
    const p = parseNotificationBody({
      resource: '/orders/1',
      topic: 'orders_v2',
      nested: [[1, 2]], // Firestore refuses a nested array outright
      obj: { a: 1 },
      __reserved__: 'x', // Firestore refuses this field NAME
      '': 'x', // ...and this one
      long: 'x'.repeat(5_000),
      huge: 'y'.repeat(200_000),
    });
    expect(p?.nested).toBe('[[1,2]]');
    expect(p?.obj).toBe('{"a":1}');
    expect(Object.keys(p!)).not.toContain('__reserved__');
    expect(Object.keys(p!)).not.toContain('');
    expect(String(p?.long).length).toBeLessThanOrEqual(513);
    expect(JSON.stringify(p).length).toBeLessThan(20_000);
  });

  it('keeps a sent/received the persisted-doc validator would reject out of the payload', () => {
    // 5e13 sits in coerceToMillis' undeterminable gap → NaN → a ZodError thrown
    // from inside persistFailure, which is OUTSIDE handleTask's try/catch.
    const p = parseNotificationBody({ resource: '/orders/1', topic: 'orders_v2', sent: 5e13 });
    expect(p?.sent).toBeNull();
  });
});

describe('isKnownTopic', () => {
  it('knows the ML topics; unknown ones are not', () => {
    expect(isKnownTopic('orders_v2')).toBe(true);
    expect(isKnownTopic('payments')).toBe(true);
    // Recognised as of #813 — previously absent, which is what made every
    // delivery park a permanent document.
    expect(isKnownTopic('public_offers')).toBe(true);
    expect(isKnownTopic('nonsense')).toBe(false);
  });
});

describe('TOPIC_DISPOSITION', () => {
  it('marks the three routinely-delivered nuisance topics as ignore', () => {
    expect(isIgnoredTopic('public_offers')).toBe(true);
    expect(isIgnoredTopic('public_candidates')).toBe(true);
    expect(isIgnoredTopic('user-products-families')).toBe(true);
  });

  it('never ignores a data-bearing or handled topic', () => {
    for (const [topic, disposition] of Object.entries(TOPIC_DISPOSITION)) {
      expect(isIgnoredTopic(topic)).toBe(disposition === 'ignore');
    }
  });

  it('keeps ignored topics out of BOTH enqueue producers', () => {
    // The receiver and the missed_feeds sweep share this gate.
    expect(shouldEnqueueTopic('public_offers')).toBe(false);
    expect(shouldEnqueueTopic('orders_v2')).toBe(true);
    // An UNKNOWN topic still enqueues — parking it is the only signal that a
    // new ML topic appeared.
    expect(shouldEnqueueTopic('nonsense')).toBe(true);
  });

  it('every `handled` topic really reaches its dispatch branch', async () => {
    // `handled` used to be pure documentation: the final fallback caught every
    // known non-`park` topic, so deleting or renaming a branch made its topic
    // silently return `done` — no failure doc, no parked doc, no warn line, i.e.
    // #813 reintroduced through the table meant to prevent it.
    //
    // The discriminator is an UNPARSEABLE resource. Every handled branch parses
    // the resource id first, so it must answer `dropped` (malformed-resource).
    // A branch that has gone missing cannot: it falls through to the fallback,
    // which now parks (`handler-pendente`). So `dropped` proves the branch ran,
    // and both failure modes — `parked` from the fallback, `done` from the old
    // silent ack — fail this assertion.
    const handled = Object.entries(TOPIC_DISPOSITION)
      .filter(([, d]) => d === 'handled')
      .map(([t]) => t);
    expect(handled.length).toBeGreaterThan(0);

    for (const topic of handled) {
      const db = new FakeDb();
      seedConta(db, 'conta-A', 55);
      const r = await handleNotificationTask(
        asDb(db),
        payloadOf({ topic, resource: '/nao-parseavel' }),
        0,
      );
      expect(r.outcome, `topic '${topic}' did not reach its dispatch branch`).toBe('dropped');
    }
  });

  it('pins the inert fixture topic — it must stay recognised and do nothing', () => {
    // ~20 tests in this file lean on INERT_TOPIC being a no-op. If it ever
    // gains a handler (or joins the ignore list) they start asserting something
    // else entirely, silently. See the INERT_TOPIC docblock.
    expect(isKnownTopic(INERT_TOPIC)).toBe(true);
    expect(TOPIC_DISPOSITION[INERT_TOPIC]).toBe('ack');
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
    expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: INERT_TOPIC });
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('unknown topic → parked (terminal), persisted', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    // A topic genuinely absent from TOPIC_DISPOSITION. `public_offers` used to
    // stand in here and no longer can — it is recognised and ignored now.
    const r = await handleNotificationTask(asDb(db), payloadOf({ topic: 'algum_topico_novo' }), 0);
    expect(r.outcome).toBe('parked');
    const doc = db.docs(NOTIF).get('N1')!;
    expect(doc.status).toBe('parked');
    expect(typeof doc.processedAt).toBe('number');
  });

  it('ignored topic → dropped, persists NOTHING, and never resolves an account', async () => {
    const db = new FakeDb();
    // Deliberately NO conta seeded: an ignored topic must settle before the
    // account lookup, so an unconnected seller cannot make it DEFER a document
    // for a topic we have decided not to care about.
    const r = await handleNotificationTask(asDb(db), payloadOf({ topic: 'public_offers' }), 0);
    expect(r.outcome).toBe('dropped');
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('has NO park topic left — every data-bearing topic now has an importer', () => {
    // #813 introduced `park` for topics carrying real data with no importer:
    // `questions` and `messages`. #532 gave both one, so the arm is now empty.
    //
    // It is deliberately KEPT rather than deleted. It still fires for a
    // `handled` topic whose dispatch branch went missing (see the guard below),
    // which is the regression it was really built to catch, and it is where the
    // next data-bearing ML topic lands before its importer exists.
    // Cast: TypeScript now NARROWS the union to exclude 'park', which is itself
    // the proof — but the runtime assertion is what survives someone re-adding one.
    const park = (Object.entries(TOPIC_DISPOSITION) as Array<[string, string]>)
      .filter(([, d]) => d === 'park')
      .map(([t]) => t);
    expect(park).toEqual([]);
  });

  it('routes a questions notification to the question importer (#532)', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const questionImportRunner = vi.fn(async () => ({
      conversaId: 'conv-1',
      clienteId: 'cli-1',
      skipped: null,
    }));

    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({ topic: 'questions', resource: '/questions/123' }),
      0,
      { questionImportRunner },
    );

    // ⚠️ The 4th argument is the payload's own `sent`. The importer needs it to
    // tell a 404 that means "deleted" from a 404 that means "ML has not
    // propagated this question yet" — acking the second one loses a real
    // customer question permanently. Dropping it here would silently restore
    // that behaviour, because `undefined` reads as "no timestamp" ⇒ ack.
    expect(questionImportRunner).toHaveBeenCalledWith(
      expect.anything(),
      'conta-A',
      123,
      1_700_000_000_000,
    );
    expect(r.outcome).toBe('done');
    // A processed question persists NOTHING — the whole point of the failures-only store.
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('passes a NULL sent through rather than inventing one', async () => {
    // A payload with no freshness claim must reach the importer as `null`, so it
    // takes the "cannot defend this with a window" branch instead of being
    // treated as fresh forever.
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const questionImportRunner = vi.fn(async () => ({
      conversaId: 'conv-1',
      clienteId: 'cli-1',
      skipped: null,
    }));

    await handleNotificationTask(
      asDb(db),
      payloadOf({ topic: 'questions', resource: '/questions/123', sent: null }),
      0,
      { questionImportRunner },
    );

    expect(questionImportRunner).toHaveBeenCalledWith(expect.anything(), 'conta-A', 123, null);
  });

  it('routes a messages notification to the order-message importer (#532)', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const orderMessageImportRunner = vi.fn(async () => ({
      conversaId: 'conv-1',
      pedidoId: 'ped-1',
      skipped: null,
    }));

    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({
        topic: 'messages',
        resource: 'fd1d2e37ad004ede9e0bf25d1215002d',
        actions: ['created'],
      }),
      0,
      { orderMessageImportRunner },
    );

    // ⚠️ The 4th argument is the payload's own `sent`, and it is load-bearing:
    // the receiver delays `messages` precisely because ML can 404 a message it
    // has not propagated yet, and the importer uses this clock to tell that
    // race apart from a real deletion. Dropping it reads as "no timestamp" ⇒ ack
    // ⇒ a silently lost message.
    expect(orderMessageImportRunner).toHaveBeenCalledWith(
      expect.anything(),
      'conta-A',
      'fd1d2e37ad004ede9e0bf25d1215002d',
      1_700_000_000_000,
    );
    expect(r.outcome).toBe('done');
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('does NOT import on a read receipt — it carries no content', async () => {
    // `messages` is a SUBTOPIC topic. Acting on `["read"]` would spend two ML
    // calls (and a slice of the 500 rpm post-sale budget) to write nothing.
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const orderMessageImportRunner = vi.fn();

    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({
        topic: 'messages',
        resource: 'fd1d2e37ad004ede9e0bf25d1215002d',
        actions: ['read'],
      }),
      0,
      { orderMessageImportRunner },
    );

    expect(orderMessageImportRunner).not.toHaveBeenCalled();
    expect(r.outcome).toBe('done');
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('imports when ML sends no actions array at all', async () => {
    // Absence is not a read receipt. Older deliveries (and `missed_feeds`
    // replays predating the typed field) carry none, and dropping those would
    // lose real messages.
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const orderMessageImportRunner = vi.fn(async () => ({
      conversaId: null,
      pedidoId: null,
      skipped: null,
    }));

    await handleNotificationTask(
      asDb(db),
      payloadOf({ topic: 'messages', resource: 'fd1d2e37ad004ede9e0bf25d1215002d' }),
      0,
      { orderMessageImportRunner },
    );

    expect(orderMessageImportRunner).toHaveBeenCalled();
  });

  it('accepts a HEX messages resource that the numeric parser would reject', async () => {
    // `parseOrderResourceId` matches digits only. Reusing it here would
    // classify the entire `messages` topic as malformed and silently drop it —
    // the failure class #813 was filed about.
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const orderMessageImportRunner = vi.fn(async () => ({
      conversaId: null,
      pedidoId: null,
      skipped: null,
    }));

    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({
        topic: 'messages',
        resource: 'abcdef0123456789abcdef0123456789',
        actions: ['created'],
      }),
      0,
      { orderMessageImportRunner },
    );

    expect(r.outcome).toBe('done');
    expect(orderMessageImportRunner).toHaveBeenCalledWith(
      expect.anything(),
      'conta-A',
      'abcdef0123456789abcdef0123456789',
      1_700_000_000_000,
    );
  });

  it('drops a questions notification whose resource carries no id', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const questionImportRunner = vi.fn();

    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({ topic: 'questions', resource: '/questions/nao-numerico' }),
      0,
      { questionImportRunner },
    );

    expect(questionImportRunner).not.toHaveBeenCalled();
    expect(r.outcome).toBe('dropped');
  });

  it('no active account → DEFERRED, not failed: the seller may connect tomorrow (#808)', async () => {
    const db = new FakeDb();
    const r = await handleNotificationTask(asDb(db), payloadOf({ user_id: 999 }), 0);
    expect(r.outcome).toBe('deferred');
    const doc = db.docs(NOTIF).get('N1')!;
    // `failed` would put it in the HOURLY pool, which parks at MAX_TENTATIVAS —
    // roughly 6h, so a next-business-day connect lost everything.
    expect(doc.status).toBe('deferred');
    expect(doc.tentativas).toBe(0);
    expect(doc.resource).toBe(INERT_RESOURCE); // ML wire fields persisted
  });

  it('no user_id at all → parked: nothing can ever make it resolvable', async () => {
    const db = new FakeDb();
    const r = await handleNotificationTask(asDb(db), payloadOf({ user_id: null }), 0);
    // Deferring would promise a connect that cannot help — the fast lane keys on
    // `user_id`, and no seller owns a notification that names none.
    expect(r.outcome).toBe('parked');
    expect(db.docs(NOTIF).get('N1')!.status).toBe('parked');
  });

  /**
   * #810 acceptance. This goes through the REAL `collection.parse` — the suite
   * mocks the import runners, never `@delfrance/data` — so it exercises
   * `parseForWrite` against the `.passthrough()` collection schema, which is
   * what actually decides whether an unknown field survives the write.
   */
  it('carries an unknown ML field onto the persisted doc', async () => {
    const db = new FakeDb();
    const r = await handleNotificationTask(
      asDb(db),
      payloadOf({ user_id: 999, site_id: 'MLB', priority: 3 }),
      0,
    );
    expect(r.outcome).toBe('deferred'); // no conta yet — the #808 slow lane
    const doc = db.docs(NOTIF).get('N1')!;
    expect(doc.site_id).toBe('MLB');
    expect(doc.priority).toBe(3);
    // ...without letting the wire payload dictate the local resilience state.
    expect(doc.status).toBe('deferred');
  });

  it('resolves the conta when user_id arrives as a numeric string (nothing persisted)', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const r = await handleNotificationTask(asDb(db), payloadOf({ user_id: '55' }), 0);
    expect(r).toMatchObject({ outcome: 'done', integracaoId: 'conta-A' });
    expect(db.docs(NOTIF).size).toBe(0);
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

  /**
   * #807. Three producers can hand the store a payload with no `_id`/`id`: the
   * order-backfill sweep (its `orders_v2` notifications are synthesised, so no ML
   * event stands behind them), a `missed_feeds` entry whose `_id` is absent or
   * path-shaped, and a webhook body carrying neither key. Each persist used to
   * mint a fresh auto id, so `store.create`'s ALREADY_EXISTS collision — the whole
   * dedup mechanism — never fired and a repeatedly-failing resource accumulated
   * one dead document per attempt.
   *
   * Driven through `handleNotificationTask` rather than by exporting
   * `derivedDocId`: the same altitude at which `asDocId` is covered above. Every
   * case rides the `no-account` arm (seller 999 is never seeded), which persists a
   * `deferred` doc through the same `docIdOf` path a `failed` one takes.
   */
  describe('failure-doc id when ML sent no id (#807)', () => {
    /** What `payloadOf`'s defaults derive to: `<topic>:<resource, slashes to _>`. */
    const DERIVED = 'items_prices:items_MLB123_prices';

    it('an id-less payload lands on a DERIVED doc id, not an auto one', async () => {
      const db = new FakeDb();
      const r = await handleNotificationTask(asDb(db), payloadOf({ id: null, user_id: 999 }), 0);
      expect(r.outcome).toBe('deferred');
      expect([...db.docs(NOTIF).keys()]).toEqual([DERIVED]);
      // The `id` FIELD stays null. The derived value keys the DOCUMENT; it is not
      // a claim that ML issued an event id.
      expect(db.docs(NOTIF).get(DERIVED)!.id).toBeNull();
    });

    it('a second id-less delivery COLLIDES and keeps the first record', async () => {
      const db = new FakeDb();
      const p = payloadOf({ id: null, user_id: 999 });

      await handleNotificationTask(asDb(db), p, 0);
      // Mutating the stored retry state is what makes this distinguishing: "one
      // document" alone would also hold if the second create had silently
      // OVERWRITTEN the first instead of raising code 6.
      db.docs(NOTIF).get(DERIVED)!.tentativas = 3;
      await handleNotificationTask(asDb(db), p, 0);

      expect(db.docs(NOTIF).size).toBe(1);
      expect(db.docs(NOTIF).get(DERIVED)!.tentativas).toBe(3);
    });

    it('keys on the TOPIC too — one resource under two topics is two jobs', async () => {
      const db = new FakeDb();
      // `orders_v2` and `orders` both carry `/orders/<id>`, so keying on the
      // resource alone would collapse two unrelated failures into one document.
      const over = { id: null, user_id: 999, resource: '/orders/7' };
      await handleNotificationTask(asDb(db), payloadOf({ ...over, topic: 'orders_v2' }), 0);
      await handleNotificationTask(asDb(db), payloadOf({ ...over, topic: 'orders' }), 0);

      expect([...db.docs(NOTIF).keys()].sort()).toEqual(['orders:orders_7', 'orders_v2:orders_7']);
    });

    it('keys on the WHOLE resource, not just its last segment', async () => {
      const db = new FakeDb();
      // A `<topic>:<last segment>` key would let these collide on `7` and drop one
      // of them silently.
      const over = { id: null, user_id: 999, topic: 'orders_v2' };
      await handleNotificationTask(asDb(db), payloadOf({ ...over, resource: '/orders/7' }), 0);
      await handleNotificationTask(asDb(db), payloadOf({ ...over, resource: '/shipments/7' }), 0);

      expect([...db.docs(NOTIF).keys()].sort()).toEqual([
        'orders_v2:orders_7',
        'orders_v2:shipments_7',
      ]);
    });

    it('a real ML id still wins over the derived one', async () => {
      const db = new FakeDb();
      await handleNotificationTask(asDb(db), payloadOf({ user_id: 999 }), 0);
      expect([...db.docs(NOTIF).keys()]).toEqual(['N1']);
    });

    it('degrades to an auto id when the composite cannot be a document id', async () => {
      const db = new FakeDb();
      // A topic carrying a slash would make the composite a PATH — `asDocId`
      // refuses it, and what is left is exactly the pre-#807 auto-id behaviour.
      const r = await handleNotificationTask(
        asDb(db),
        payloadOf({ id: null, user_id: 999, topic: 'a/b' }),
        0,
      );
      expect(r.outcome).toBe('deferred');
      expect([...db.docs(NOTIF).keys()][0]).toMatch(/^auto-/);
    });
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

  it('migrates a still-unresolvable doc OUT of the hourly pool instead of parking it (#808)', async () => {
    const db = new FakeDb();
    // No conta → unresolvable. Both docs used to bleed hourly retries here and
    // the second one used to PARK, terminally, about six hours in.
    seedFailed(db, 'N1', { processedAt: 1_000, resource: '/orders/1', user_id: 77, tentativas: 0 });
    seedFailed(db, 'N2', {
      processedAt: 1_000,
      resource: '/orders/2',
      user_id: 77,
      tentativas: MAX_TENTATIVAS - 1,
    });
    const res = await reprocessNotifications(asDb(db), { now: 10_000, olderThanMs: 100 });

    expect(res.outcomes.deferred).toBe(2);
    expect(res.outcomes.parked).toBeUndefined(); // nothing is lost at the hot cap any more
    for (const id of ['N1', 'N2']) {
      const doc = db.docs(NOTIF).get(id)!;
      expect(doc.status).toBe('deferred');
      expect(doc.tentativas).toBe(0); // a fresh 7-day clock, not the spent hourly one
      expect(doc.processedAt).toBe(10_000);
    }
  });

  it('the hot sweep no longer sees a deferred doc at all — zero hourly retries while waiting', async () => {
    const db = new FakeDb();
    seedFailed(db, 'N1', {
      processedAt: 1_000,
      resource: '/orders/1',
      user_id: 77,
      status: 'deferred',
    });

    const res = await reprocessNotifications(asDb(db), { now: 10_000, olderThanMs: 100 });

    expect(res.processed).toBe(0);
    expect(db.docs(NOTIF).get('N1')).toMatchObject({ tentativas: 0, processedAt: 1_000 });
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

  /**
   * The GHOST document (N6). `store.mark`'s merge is an UPSERT, so a doc deleted
   * concurrently with a sweep is recreated carrying ONLY
   * `{status, tentativas, erro, processedAt}` — no `resource`, no `topic`. It
   * still matches the sweep query, so it comes back around every run.
   *
   * The contract is that rehydration REFUSES it with a legible reason rather
   * than letting `undefined` reach the dispatcher, where `lastSegment` would
   * `ref.split('/')` into a `TypeError`. These tests are deliberately written
   * against BEHAVIOUR (not the exact wording) so they hold across the #810
   * rewrite of `fromDoc` from a hand-rolled guard to a schema parse.
   */
  it('refuses a ghost document (no resource/topic) with a legible error, never a TypeError', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    // Exactly what a merge-upsert over a deleted doc leaves behind.
    db.seed(NOTIF, 'N9', {
      status: 'failed',
      tentativas: 0,
      erro: 'falha anterior',
      processedAt: 1_000,
    });

    const res = await reprocessNotifications(asDb(db), { now: 10_000, olderThanMs: 100 });

    expect(res.processed).toBe(0);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.docId).toBe('N9');
    // Names the field that is missing, and is a DELIBERATE refusal rather than
    // a `ref.split is not a function` that escaped from the dispatcher.
    expect(res.errors[0]!.message).toMatch(/resource/i);
    expect(res.errors[0]!.message).not.toMatch(/TypeError|is not a function/i);

    const n9 = db.docs(NOTIF).get('N9')!; // kept as an audit row, tentativas bumped
    expect(n9.status).toBe('failed');
    expect(n9.tentativas).toBe(1);
    expect(n9.processedAt).toBe(10_000);
  });

  it('parks a ghost document once it reaches the retry cap', async () => {
    const db = new FakeDb();
    db.seed(NOTIF, 'N9', {
      status: 'failed',
      tentativas: MAX_TENTATIVAS - 1,
      erro: 'falha anterior',
      processedAt: 1_000,
    });

    const res = await reprocessNotifications(asDb(db), { now: 10_000, olderThanMs: 100 });

    expect(res.errors).toHaveLength(1);
    const n9 = db.docs(NOTIF).get('N9')!;
    expect(n9.status).toBe('parked');
    expect(n9.tentativas).toBe(MAX_TENTATIVAS);
  });
});

/* ------------------- the deferred lane + connect re-drive (#808) ------------ */

/** A notification already parked in the deferred lane, waiting on its seller. */
function seedDeferred(db: FakeDb, id: string, over: DocData = {}): void {
  seedFailed(db, id, {
    status: 'deferred',
    erro: 'integração ativa do Mercado Livre não encontrada para user_id 77',
    user_id: 77,
    ...over,
  });
}

describe('reprocessDeferredNotifications', () => {
  it('re-drives a deferred doc once its seller connects, and deletes it on success', async () => {
    const db = new FakeDb();
    seedDeferred(db, 'N1', { processedAt: 1_000, resource: '/items/MLB1/prices' });
    seedConta(db, 'conta-A', 77); // the seller connected meanwhile

    const res = await reprocessDeferredNotifications(asDb(db), { now: 10_000, olderThanMs: 100 });

    expect(res.outcomes.done).toBe(1);
    expect(db.docs(NOTIF).has('N1')).toBe(false);
  });

  it('holds a still-unconnected seller for MAX_TENTATIVAS_DEFERRED days, then parks', async () => {
    const db = new FakeDb();
    seedDeferred(db, 'N1', { processedAt: 1_000, resource: '/items/MLB1/prices', tentativas: 0 });
    seedDeferred(db, 'N2', {
      processedAt: 1_000,
      resource: '/items/MLB2/prices',
      tentativas: MAX_TENTATIVAS_DEFERRED - 1,
    });

    const res = await reprocessDeferredNotifications(asDb(db), { now: 10_000, olderThanMs: 100 });

    expect(res.outcomes.deferred).toBe(1);
    expect(res.outcomes.parked).toBe(1);
    expect(db.docs(NOTIF).get('N1')).toMatchObject({ status: 'deferred', tentativas: 1 });
    expect(db.docs(NOTIF).get('N2')).toMatchObject({
      status: 'parked',
      tentativas: MAX_TENTATIVAS_DEFERRED,
    });
  });

  it('is far more patient than the hot lane — MAX_TENTATIVAS does not park it', async () => {
    const db = new FakeDb();
    seedDeferred(db, 'N1', { processedAt: 1_000, tentativas: MAX_TENTATIVAS });

    await reprocessDeferredNotifications(asDb(db), { now: 10_000, olderThanMs: 100 });

    expect(db.docs(NOTIF).get('N1')).toMatchObject({ status: 'deferred' });
  });
});

describe('redriveDeferredForUserId', () => {
  it('moves only THAT seller’s deferred docs into the hot lane', async () => {
    const db = new FakeDb();
    seedDeferred(db, 'N1', { resource: '/items/MLB1/prices', user_id: 77 });
    seedDeferred(db, 'N2', { resource: '/items/MLB2/prices', user_id: 77 });
    seedDeferred(db, 'N3', { resource: '/items/MLB3/prices', user_id: 88 }); // another seller
    seedFailed(db, 'N4', { resource: '/items/MLB4/prices', user_id: 77 }); // already hot

    const res = await redriveDeferredForUserId(asDb(db), 77);

    expect(res).toMatchObject({ encontradas: 2, redirecionadas: 2, truncado: false });
    for (const id of ['N1', 'N2']) {
      expect(db.docs(NOTIF).get(id)).toMatchObject({
        status: 'failed',
        tentativas: 0,
        processedAt: 0, // the next hot tick picks it up whatever the window
        resource: db.docs(NOTIF).get(id)!.resource, // wire fields survive the merge
      });
    }
    expect(db.docs(NOTIF).get('N3')).toMatchObject({ status: 'deferred' });
    expect(db.docs(NOTIF).get('N4')).toMatchObject({ tentativas: 0, processedAt: 1_000 });
  });

  it('is idempotent — a trigger redelivery finds nothing left to move', async () => {
    const db = new FakeDb();
    seedDeferred(db, 'N1', { user_id: 77 });

    await redriveDeferredForUserId(asDb(db), 77);
    const replay = await redriveDeferredForUserId(asDb(db), 77);

    expect(replay).toMatchObject({ encontradas: 0, redirecionadas: 0 });
  });

  it('reports truncation rather than silently dropping the tail', async () => {
    const db = new FakeDb();
    seedDeferred(db, 'N1', { resource: '/items/MLB1/prices', user_id: 77 });
    seedDeferred(db, 'N2', { resource: '/items/MLB2/prices', user_id: 77 });

    const res = await redriveDeferredForUserId(asDb(db), 77, 1);

    expect(res).toMatchObject({ encontradas: 1, redirecionadas: 1, truncado: true });
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('userIdResolvivel', () => {
  // It must agree exactly with what `resolveIntegracaoByUserId` queries, or the
  // trigger re-drives accounts the sweep will refuse (or misses ones it accepts).
  it('mirrors the three predicates the resolve query filters on', () => {
    expect(userIdResolvivel({ tipo: 1, ativo: true, user_id: 77 })).toBe(77);
    expect(userIdResolvivel({ tipo: 1, ativo: false, user_id: 77 })).toBeNull();
    expect(userIdResolvivel({ tipo: 2, ativo: true, user_id: 77 })).toBeNull(); // another channel
    expect(userIdResolvivel({ tipo: 1, ativo: true, user_id: null })).toBeNull();
    expect(userIdResolvivel(null)).toBeNull();
  });

  it('agrees with resolveIntegracaoByUserId on the same document', async () => {
    const db = new FakeDb();
    db.seed('integracao', 'conta-A', { tipo: 1, user_id: 77, ativo: true, nome: 'A' });
    db.seed('integracao', 'conta-B', { tipo: 1, user_id: 88, ativo: false, nome: 'B' });

    expect(await resolveIntegracaoByUserId(asDb(db), 77)).toBe('conta-A');
    expect(userIdResolvivel(db.docs('integracao').get('conta-A')!)).toBe(77);

    expect(await resolveIntegracaoByUserId(asDb(db), 88)).toBeNull();
    expect(userIdResolvivel(db.docs('integracao').get('conta-B')!)).toBeNull();
  });
});

describe('#808 acceptance — a notification survives a connect-after-the-fact', () => {
  const UMA_HORA = 60 * 60 * 1000;
  const UM_DIA = 24 * UMA_HORA;

  /**
   * The moment the persisted doc was actually stamped. `store.create` reads the
   * real clock and takes no injectable `now`, so the timeline MUST be anchored to
   * what it wrote — anchoring to a `Date.now()` taken before the call leaves a
   * sub-millisecond margin that a loaded machine eats, and the daily window then
   * misses the doc.
   */
  function stampOf(db: FakeDb, id: string): number {
    return db.docs(NOTIF).get(id)!.processedAt as number;
  }

  it('imports a day-old notification once the seller connects, instead of parking it', async () => {
    const db = new FakeDb();

    // 1. The webhook arrives for a seller nobody has connected yet.
    const task = await handleNotificationTask(asDb(db), payloadOf({ user_id: 999 }), 0);
    expect(task.outcome).toBe('deferred');
    const T0 = stampOf(db, 'N1');

    // 2. It sits out the whole business day. The HOURLY sweep — which used to
    //    park it terminally after ~6h — never touches it, even from hour 2 on
    //    where its window would have matched every single time.
    for (let hora = 2; hora <= 9; hora += 1) {
      await reprocessNotifications(asDb(db), { now: T0 + hora * UMA_HORA });
    }
    expect(db.docs(NOTIF).get('N1')).toMatchObject({ status: 'deferred', tentativas: 0 });

    // 3. The daily lane re-drives it once and finds the seller still absent.
    await reprocessDeferredNotifications(asDb(db), { now: T0 + UM_DIA + 1 });
    expect(db.docs(NOTIF).get('N1')).toMatchObject({ status: 'deferred', tentativas: 1 });

    // 4. Next business day the seller finishes the OAuth connect, which stamps
    //    `user_id` onto their integração — what the trigger arm keys on.
    seedConta(db, 'conta-nova', 999);
    const redrive = await redriveDeferredForUserId(asDb(db), 999);
    expect(redrive).toMatchObject({ encontradas: 1, redirecionadas: 1 });

    // 5. The very next hot sweep imports it and clears the doc.
    const res = await reprocessNotifications(asDb(db), { now: T0 + UM_DIA + 2 });
    expect(res.outcomes.done).toBe(1);
    expect(db.docs(NOTIF).has('N1')).toBe(false);
  });

  it('drains without the trigger too — the daily lane alone still imports it', async () => {
    const db = new FakeDb();

    await handleNotificationTask(asDb(db), payloadOf({ user_id: 999 }), 0);
    const T0 = stampOf(db, 'N1');
    seedConta(db, 'conta-nova', 999); // connected, but nothing observed it

    const res = await reprocessDeferredNotifications(asDb(db), { now: T0 + UM_DIA + 1 });

    expect(res.outcomes.done).toBe(1);
    expect(db.docs(NOTIF).has('N1')).toBe(false);
  });
});

// The connect re-drive's (status, user_id) composite is now covered generically
// by guard D in packages/data/src/admin/notifications/notificationGuardrails.test.ts,
// which derives the required index from THIS file's query source and compares it
// with `indexSatisfies`. The hand-rolled block that used to live here compared
// `fieldPath` only and ignored `order`, so flipping user_id to DESCENDING passed
// it while breaking the query — verified before deleting it (#823).
