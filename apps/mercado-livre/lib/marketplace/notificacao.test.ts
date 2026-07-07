import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

import {
  MAX_TENTATIVAS,
  isKnownTopic,
  parseNotificationBody,
  processNotification,
  reprocessNotifications,
  resolveIntegracaoByUserId,
} from './notificacao';

/* ----------------------------- fake Firestore ---------------------------- */
// Supports the two access shapes the admin handles use: doc get/set/merge, and
// chained where/orderBy/limit/get queries (ops: '==', '<', 'in').

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
  /** Fault injection: a `doc(id).get()` for one of these ids throws. */
  readonly failGetIds = new Set<string>();
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
          get: async () => {
            if (self.failGetIds.has(docId)) throw new Error('firestore unavailable');
            return { exists: col.has(docId), id: docId, data: () => col.get(docId) };
          },
          set: async (data: DocData, opts?: { merge?: boolean }) => {
            col.set(docId, opts?.merge ? { ...(col.get(docId) ?? {}), ...data } : { ...data });
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

const NOTIF = 'notificacoesMercadoLivre';
const asDb = (db: FakeDb) => db as unknown as Firestore;

function seedConta(db: FakeDb, id: string, userId: number, ativo = true): void {
  db.seed('integracao', id, { tipo: 1, user_id: userId, ativo, nome: id });
}
function seedNotif(db: FakeDb, id: string, over: DocData = {}): void {
  db.seed(NOTIF, id, {
    id,
    resource: '/orders/123',
    topic: 'orders_v2',
    user_id: 55,
    application_id: 999,
    attempts: 1,
    sent: 1_700_000_000_000,
    received: 1_700_000_000_000,
    status: 'pending',
    tentativas: 0,
    erro: null,
    processedAt: null,
    ...over,
  });
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

/* ------------------------------ parse + topics --------------------------- */

describe('parseNotificationBody', () => {
  it('extracts a well-formed notification (accepts _id and id)', () => {
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
    expect(a?.fields).toMatchObject({
      id: 'N1',
      resource: '/orders/123',
      topic: 'orders_v2',
      user_id: 55,
      status: 'pending',
      tentativas: 0,
    });
    expect(parseNotificationBody({ id: 'N2', resource: '/items/MLB1', topic: 'items' })?.id).toBe(
      'N2',
    );
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

/* ------------------------------ processNotification ----------------------- */

describe('processNotification', () => {
  it('gone when the doc no longer exists', async () => {
    const db = new FakeDb();
    expect((await processNotification(asDb(db), 'nope')).outcome).toBe('gone');
  });

  it('skips a terminal doc (done/parked) idempotently', async () => {
    const db = new FakeDb();
    seedNotif(db, 'N1', { status: 'done' });
    expect((await processNotification(asDb(db), 'N1')).outcome).toBe('skip');
  });

  it('known topic + resolved account → done', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    seedNotif(db, 'N1');
    const res = await processNotification(asDb(db), 'N1');
    expect(res).toMatchObject({ outcome: 'done', integracaoId: 'conta-A', topic: 'orders_v2' });
    const doc = db.docs(NOTIF).get('N1')!;
    expect(doc.status).toBe('done');
    expect(doc.tentativas).toBe(1);
    expect(doc.erro).toBeNull();
    // the ML wire fields are preserved (merge, not overwrite)
    expect(doc.resource).toBe('/orders/123');
  });

  it('unknown topic → parked (terminal, no retry)', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    seedNotif(db, 'N1', { topic: 'public_offers' });
    expect((await processNotification(asDb(db), 'N1')).outcome).toBe('parked');
    expect(db.docs(NOTIF).get('N1')!.status).toBe('parked');
  });

  it('no active account → failed while under the cap; parked at the cap', async () => {
    const db = new FakeDb();
    // no conta seeded → unresolvable
    seedNotif(db, 'N1', { tentativas: 0 });
    expect((await processNotification(asDb(db), 'N1')).outcome).toBe('failed');
    expect(db.docs(NOTIF).get('N1')!.status).toBe('failed');

    seedNotif(db, 'N2', { tentativas: MAX_TENTATIVAS - 1 });
    expect((await processNotification(asDb(db), 'N2')).outcome).toBe('parked');
    expect(db.docs(NOTIF).get('N2')!.status).toBe('parked');
  });
});

/* ----------------------------- reprocess sweep --------------------------- */

describe('reprocessNotifications', () => {
  it('re-drives pending/failed docs older than the window, deduped by resource', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    const old = 1_000;
    seedNotif(db, 'N1', { received: old, resource: '/orders/1' });
    seedNotif(db, 'N2', { received: old, resource: '/orders/1', status: 'failed' }); // dup resource
    seedNotif(db, 'N3', { received: old, resource: '/orders/2' });
    seedNotif(db, 'N4', { received: 9_999_999_999_999, resource: '/orders/3' }); // too new
    seedNotif(db, 'N5', { received: old, resource: '/orders/4', status: 'done' }); // terminal, excluded by query

    const res = await reprocessNotifications(asDb(db), { now: 10_000, olderThanMs: 100 });
    // N1 + N3 processed (N2 deduped by resource, N4 too new, N5 already done)
    expect(res.processed).toBe(2);
    expect(res.outcomes.done).toBe(2);
    expect(res.errors).toEqual([]);
  });

  it('isolates a per-doc failure — one throw does not abort the batch', async () => {
    const db = new FakeDb();
    seedConta(db, 'conta-A', 55);
    seedNotif(db, 'N1', { received: 1_000, resource: '/orders/1' });
    seedNotif(db, 'N2', { received: 1_000, resource: '/orders/2' });
    // N2's read throws (a transient Firestore failure) — the sweep must
    // collect it and still process N1, not abort.
    db.failGetIds.add('N2');

    const res = await reprocessNotifications(asDb(db), { now: 10_000, olderThanMs: 100 });
    expect(res.processed).toBe(1); // N1 succeeded
    expect(res.errors).toHaveLength(1); // N2 collected, not thrown
    expect(res.errors[0]!.message).toContain('firestore unavailable');
    expect(db.docs(NOTIF).get('N1')!.status).toBe('done');
  });
});
