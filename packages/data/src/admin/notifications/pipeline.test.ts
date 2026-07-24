import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';

import { defineAdminCollection } from '../defineAdminCollection';
import { defineNotificationPipeline } from './pipeline';
import { MAX_TENTATIVAS, TASK_MAX_ATTEMPTS, type NotificationDisposition } from './types';

/* --------------------------- a minimal fake Firestore --------------------- */
// Only the shapes the store touches: doc create/set/delete and a chained
// where/orderBy/limit/get. Fault injection covers the two failure modes the
// pipeline's disposition actually branches on — a `.create()` that throws
// (correlated outage) and a `.set()` that throws (the sweep's mark write).

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
  readonly failCreateIds = new Set<string>();
  readonly failMarkIds = new Set<string>();
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
          set: async (data: DocData, opts?: { merge?: boolean }) => {
            if (self.failMarkIds.has(docId)) {
              throw Object.assign(new Error('mark unavailable'), { code: 14 });
            }
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
    };
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

/* ------------------------------ the test channel -------------------------- */

const NOTIF = 'notificacoesTeste';

const docSchema = z
  .object({
    id: z.string().nullable().default(null),
    resource: z.string().min(1),
    status: z.enum(['failed', 'parked']).default('failed'),
    tentativas: z.number().int().default(0),
    erro: z.string().nullable().default(null),
    processedAt: z.number().int().nullable().default(null),
  })
  .passthrough();

const collection = defineAdminCollection({ path: NOTIF, schema: docSchema });

interface TestPayload {
  id: string | null;
  resource: string;
}

const taskSchema = z.object({
  id: z.string().nullable().default(null),
  resource: z.string().min(1),
});

/** Test outcomes, mirroring the shape a real channel returns. */
type TestOutcome =
  | { kind: 'ok' }
  | { kind: 'noise' }
  | { kind: 'unsupported' }
  | { kind: 'no-account' };

function buildPipeline(
  process: (db: Firestore, payload: TestPayload) => Promise<TestOutcome>,
  toDisposition?: (
    o: TestOutcome,
    payload: TestPayload,
    phase: 'task' | 'sweep',
  ) => NotificationDisposition,
) {
  return defineNotificationPipeline<TestPayload, TestOutcome>({
    channel: 'teste',
    collection,
    taskSchema,
    docIdOf: (p) => p.id,
    dedupKeyOf: (p) => p.resource,
    toDocFields: (p) => ({ id: p.id, resource: p.resource }),
    fromDoc: (parsed) => {
      const d = parsed as { id: string | null; resource: string };
      return { id: d.id, resource: d.resource };
    },
    process,
    toDisposition:
      toDisposition ??
      ((o) => {
        if (o.kind === 'ok') return { kind: 'resolve' };
        if (o.kind === 'noise') return { kind: 'drop', reason: 'ruído' };
        if (o.kind === 'unsupported') return { kind: 'park', reason: 'não suportado' };
        return { kind: 'fail', reason: 'sem conta ativa' };
      }),
  });
}

const payloadOf = (over: Partial<TestPayload> = {}): TestPayload => ({
  id: 'N1',
  resource: '/orders/1',
  ...over,
});

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb();
  vi.restoreAllMocks();
});

/* ---------------------------------- tests --------------------------------- */

describe('handleTask disposition', () => {
  it('a resolved notification persists NOTHING (the cost win)', async () => {
    const pipeline = buildPipeline(async () => ({ kind: 'ok' }));
    const r = await pipeline.handleTask(asDb(db), payloadOf(), 0);
    expect(r.outcome).toBe('done');
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('a dropped notification persists NOTHING', async () => {
    const pipeline = buildPipeline(async () => ({ kind: 'noise' }));
    const r = await pipeline.handleTask(asDb(db), payloadOf(), 0);
    expect(r.outcome).toBe('dropped');
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('a parked notification persists status=parked with tentativas 0', async () => {
    const pipeline = buildPipeline(async () => ({ kind: 'unsupported' }));
    const r = await pipeline.handleTask(asDb(db), payloadOf(), 0);
    expect(r.outcome).toBe('parked');
    const doc = db.docs(NOTIF).get('N1');
    expect(doc).toMatchObject({ status: 'parked', tentativas: 0, erro: 'não suportado' });
    expect(typeof doc?.processedAt).toBe('number');
  });

  it('a failed notification persists status=failed keyed by the provider event id', async () => {
    const pipeline = buildPipeline(async () => ({ kind: 'no-account' }));
    const r = await pipeline.handleTask(asDb(db), payloadOf(), 0);
    expect(r.outcome).toBe('failed');
    expect(db.docs(NOTIF).get('N1')).toMatchObject({
      status: 'failed',
      resource: '/orders/1',
      erro: 'sem conta ativa',
    });
  });

  it('mints an auto id when the wire carries no event id', async () => {
    const pipeline = buildPipeline(async () => ({ kind: 'no-account' }));
    await pipeline.handleTask(asDb(db), payloadOf({ id: null }), 0);
    expect(db.docs(NOTIF).size).toBe(1);
    expect([...db.docs(NOTIF).keys()][0]).toMatch(/^auto-/);
  });

  it('a redelivery that also fails hits ALREADY_EXISTS and keeps the FIRST retry state', async () => {
    const pipeline = buildPipeline(async () => ({ kind: 'no-account' }));
    await pipeline.handleTask(asDb(db), payloadOf(), 0);
    db.docs(NOTIF).set('N1', { ...db.docs(NOTIF).get('N1'), tentativas: 3 });
    await pipeline.handleTask(asDb(db), payloadOf(), 0);
    expect(db.docs(NOTIF).get('N1')).toMatchObject({ tentativas: 3 });
  });

  it('a malformed task payload is DROPPED — a coding/enqueue bug, never retried', async () => {
    const process = vi.fn(async () => ({ kind: 'ok' }) as TestOutcome);
    const pipeline = buildPipeline(process);
    const r = await pipeline.handleTask(asDb(db), { resource: '' }, 0);
    expect(r.outcome).toBe('dropped');
    expect(process).not.toHaveBeenCalled();
    expect(db.docs(NOTIF).size).toBe(0);
  });
});

describe('handleTask transient failures', () => {
  it('re-throws below the attempt cap so the queue retries, persisting nothing', async () => {
    const pipeline = buildPipeline(async () => {
      throw new Error('firestore unavailable');
    });
    await expect(pipeline.handleTask(asDb(db), payloadOf(), 0)).rejects.toThrow(
      'firestore unavailable',
    );
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('persists `failed` on the FINAL attempt instead of throwing', async () => {
    const pipeline = buildPipeline(async () => {
      throw new Error('firestore unavailable');
    });
    const r = await pipeline.handleTask(asDb(db), payloadOf(), TASK_MAX_ATTEMPTS - 1);
    expect(r.outcome).toBe('failed');
    expect(db.docs(NOTIF).get('N1')).toMatchObject({
      status: 'failed',
      erro: 'firestore unavailable',
    });
  });

  it('⭐ a correlated outage re-throws the ORIGINAL error, not the persist error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db.failCreateIds.add('N1');
    const pipeline = buildPipeline(async () => {
      throw new Error('firestore unavailable');
    });
    await expect(pipeline.handleTask(asDb(db), payloadOf(), TASK_MAX_ATTEMPTS - 1)).rejects.toThrow(
      'firestore unavailable',
    );
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('a non-Error throw always propagates — it is a coding bug, not an outage', async () => {
    const pipeline = buildPipeline(async () => {
      throw 'not an error';
    });
    await expect(pipeline.handleTask(asDb(db), payloadOf(), TASK_MAX_ATTEMPTS - 1)).rejects.toBe(
      'not an error',
    );
  });
});

describe('reprocess (the durable-cursor sweep)', () => {
  const NOW = 1_700_000_000_000;
  const OLD = NOW - 2 * 60 * 60 * 1000;

  function seedFailed(id: string, resource: string, over: Record<string, unknown> = {}): void {
    db.seed(NOTIF, id, {
      id,
      resource,
      status: 'failed',
      tentativas: 0,
      erro: 'boom',
      processedAt: OLD,
      ...over,
    });
  }

  it('re-drives docs past the window, deletes on resolution, and skips too-recent ones', async () => {
    seedFailed('N1', '/orders/1');
    seedFailed('N2', '/orders/2');
    seedFailed('N3', '/orders/3', { processedAt: NOW - 1000 }); // inside the window
    seedFailed('N4', '/orders/4', { status: 'parked' }); // terminal — not queried

    const pipeline = buildPipeline(async () => ({ kind: 'ok' }));
    const res = await pipeline.reprocess(asDb(db), { now: NOW });

    expect(res.processed).toBe(2);
    expect(res.outcomes.done).toBe(2);
    expect(db.docs(NOTIF).has('N1')).toBe(false);
    expect(db.docs(NOTIF).has('N2')).toBe(false);
    expect(db.docs(NOTIF).has('N3')).toBe(true);
    expect(db.docs(NOTIF).has('N4')).toBe(true);
  });

  it('dedups by key within a run and LEAVES the duplicate in place for a later run', async () => {
    seedFailed('N1', '/orders/1');
    seedFailed('N2', '/orders/1'); // same resource
    const process = vi.fn(async () => ({ kind: 'ok' }) as TestOutcome);
    const pipeline = buildPipeline(process);

    const res = await pipeline.reprocess(asDb(db), { now: NOW });

    expect(process).toHaveBeenCalledTimes(1);
    expect(res.processed).toBe(1);
    expect(db.docs(NOTIF).size).toBe(1); // the dup survives, un-touched
  });

  it('bumps tentativas below the cap and PARKS at it', async () => {
    seedFailed('N1', '/orders/1', { tentativas: 0 });
    seedFailed('N2', '/orders/2', { tentativas: MAX_TENTATIVAS - 1 });
    const pipeline = buildPipeline(async () => ({ kind: 'no-account' }));

    const res = await pipeline.reprocess(asDb(db), { now: NOW });

    expect(res.outcomes.failed).toBe(1);
    expect(res.outcomes.parked).toBe(1);
    expect(db.docs(NOTIF).get('N1')).toMatchObject({
      status: 'failed',
      tentativas: 1,
      processedAt: NOW, // the cursor advanced — it won't starve the backlog
    });
    expect(db.docs(NOTIF).get('N2')).toMatchObject({
      status: 'parked',
      tentativas: MAX_TENTATIVAS,
    });
  });

  it('a park disposition is terminal — marked, never deleted', async () => {
    seedFailed('N1', '/orders/1');
    const pipeline = buildPipeline(async () => ({ kind: 'unsupported' }));

    const res = await pipeline.reprocess(asDb(db), { now: NOW });

    expect(res.outcomes.parked).toBe(1);
    expect(db.docs(NOTIF).get('N1')).toMatchObject({ status: 'parked', tentativas: 1 });
  });

  it('a drop disposition DELETES the doc — the event is no longer ours', async () => {
    seedFailed('N1', '/orders/1');
    const pipeline = buildPipeline(async () => ({ kind: 'noise' }));

    const res = await pipeline.reprocess(asDb(db), { now: NOW });

    expect(res.outcomes.dropped).toBe(1);
    expect(db.docs(NOTIF).has('N1')).toBe(false);
  });

  it('honours a channel-supplied outcome label so operator vocabulary survives', async () => {
    seedFailed('N1', '/orders/1');
    const pipeline = buildPipeline(
      async () => ({ kind: 'ok' }),
      () => ({ kind: 'resolve', label: 'reconciled' }),
    );

    const res = await pipeline.reprocess(asDb(db), { now: NOW });

    expect(res.outcomes.reconciled).toBe(1);
    expect(res.outcomes.done).toBeUndefined();
  });

  it('⚠️ the disposition map sees the phase — the same outcome can differ per stage', async () => {
    seedFailed('N1', '/orders/1');
    const toDisposition = (
      _o: TestOutcome,
      _p: TestPayload,
      phase: 'task' | 'sweep',
    ): NotificationDisposition =>
      phase === 'task' ? { kind: 'drop' } : { kind: 'park', reason: 'terminal' };
    const pipeline = buildPipeline(async () => ({ kind: 'noise' }), toDisposition);

    // In the task there is nothing to create, so the drop leaves no doc...
    const r = await pipeline.handleTask(asDb(db), payloadOf({ id: 'N9' }), 0);
    expect(r.outcome).toBe('dropped');
    expect(db.docs(NOTIF).has('N9')).toBe(false);

    // ...but in the sweep a doc already exists, and this channel keeps it.
    const res = await pipeline.reprocess(asDb(db), { now: NOW });
    expect(res.outcomes.parked).toBe(1);
    expect(db.docs(NOTIF).get('N1')).toMatchObject({ status: 'parked' });
  });

  it('isolates per-doc failures — one throw never aborts the batch', async () => {
    seedFailed('N1', '/orders/1');
    seedFailed('N2', '/orders/2');
    const pipeline = buildPipeline(async (_db, p) => {
      if (p.resource === '/orders/1') throw new Error('transient');
      return { kind: 'ok' };
    });

    const res = await pipeline.reprocess(asDb(db), { now: NOW });

    expect(res.processed).toBe(1); // only the success path counts
    expect(res.errors).toEqual([{ docId: 'N1', message: 'transient' }]);
    expect(db.docs(NOTIF).get('N1')).toMatchObject({ status: 'failed', tentativas: 1 });
    expect(db.docs(NOTIF).has('N2')).toBe(false);
  });

  it('isolates a REHYDRATION failure too, not just a processing one', async () => {
    seedFailed('N1', '/orders/1');
    seedFailed('N2', '/orders/2');
    // `fromDoc` is channel-supplied, so the shared core cannot assume it is
    // total. A throw there must be contained exactly like a `process` throw —
    // otherwise one malformed doc aborts the whole sweep.
    const pipeline = defineNotificationPipeline<TestPayload, TestOutcome>({
      channel: 'teste',
      collection,
      taskSchema,
      docIdOf: (p) => p.id,
      dedupKeyOf: (p) => p.resource,
      toDocFields: (p) => ({ id: p.id, resource: p.resource }),
      fromDoc: (parsed) => {
        const d = parsed as { id: string | null; resource: string };
        if (d.id === 'N1') throw new Error('rehydration exploded');
        return { id: d.id, resource: d.resource };
      },
      process: async () => ({ kind: 'ok' }),
      toDisposition: () => ({ kind: 'resolve' }),
    });

    const res = await pipeline.reprocess(asDb(db), { now: NOW });

    expect(res.errors).toEqual([{ docId: 'N1', message: 'rehydration exploded' }]);
    expect(res.processed).toBe(1); // N2 still ran
    expect(db.docs(NOTIF).has('N2')).toBe(false); // ...and resolved
    // The un-rehydratable doc is still marked, so it ages out via the cap
    // instead of being retried forever.
    expect(db.docs(NOTIF).get('N1')).toMatchObject({ status: 'failed', tentativas: 1 });
  });

  it('survives a mark write that ALSO fails — collected, not thrown', async () => {
    seedFailed('N1', '/orders/1');
    db.failMarkIds.add('N1');
    const pipeline = buildPipeline(async () => {
      throw new Error('transient');
    });

    const res = await pipeline.reprocess(asDb(db), { now: NOW });

    expect(res.errors).toHaveLength(1);
    expect(res.processed).toBe(0);
  });

  it('respects the limit cap', async () => {
    seedFailed('N1', '/orders/1');
    seedFailed('N2', '/orders/2');
    seedFailed('N3', '/orders/3');
    const pipeline = buildPipeline(async () => ({ kind: 'ok' }));

    const res = await pipeline.reprocess(asDb(db), { now: NOW, limit: 2 });

    expect(res.processed).toBe(2);
  });
});
