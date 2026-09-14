import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it, vi } from 'vitest';

import {
  MAX_TENTATIVAS,
  TASK_MAX_ATTEMPTS,
  handleNotificationTask,
  notificationDocId,
  reprocessNotifications,
  type MelhorEnvioNotificationPayload,
  type MelhorEnvioProcessDeps,
  type PedidoMatch,
} from './notificacao';

type DocData = Record<string, unknown>;
type Clause = { field: string; op: string; value: unknown };

function matches(data: DocData, clauses: Clause[]): boolean {
  return clauses.every(({ field, op, value }) => {
    if (op === '==') return data[field] === value;
    if (op === '<') return typeof data[field] === 'number' && data[field] < (value as number);
    return false;
  });
}

class FakeDb {
  readonly collections = new Map<string, Map<string, DocData>>();
  readonly failCreateIds = new Set<string>();
  private autoId = 0;

  private docs(path: string): Map<string, DocData> {
    let docs = this.collections.get(path);
    if (!docs) {
      docs = new Map();
      this.collections.set(path, docs);
    }
    return docs;
  }

  seed(path: string, id: string, data: DocData): void {
    this.docs(path).set(id, data);
  }

  rows(path: string): Map<string, DocData> {
    return this.docs(path);
  }

  collection(path: string) {
    const docs = this.docs(path);
    const query = (clauses: Clause[], orderField: string | null, limit: number | null) => ({
      where: (field: string, op: string, value: unknown) =>
        query([...clauses, { field, op, value }], orderField, limit),
      orderBy: (field: string) => query(clauses, field, limit),
      limit: (count: number) => query(clauses, orderField, count),
      get: async () => {
        let result = [...docs.entries()].filter(([, data]) => matches(data, clauses));
        if (orderField) {
          result.sort(
            (left, right) =>
              ((left[1][orderField] as number) ?? 0) - ((right[1][orderField] as number) ?? 0),
          );
        }
        if (limit != null) result = result.slice(0, limit);
        return { docs: result.map(([id, data]) => ({ id, data: () => data })) };
      },
    });

    return {
      doc: (requestedId?: string) => {
        const id = requestedId ?? `auto-${++this.autoId}`;
        return {
          id,
          create: async (data: DocData) => {
            if (this.failCreateIds.has(id)) {
              throw Object.assign(new Error('persist unavailable'), { code: 14 });
            }
            if (docs.has(id)) throw Object.assign(new Error('already exists'), { code: 6 });
            docs.set(id, { ...data });
          },
          set: async (data: DocData, options?: { merge?: boolean }) => {
            docs.set(id, options?.merge ? { ...(docs.get(id) ?? {}), ...data } : { ...data });
          },
          delete: async () => {
            docs.delete(id);
          },
        };
      },
      where: (field: string, op: string, value: unknown) =>
        query([{ field, op, value }], null, null),
    };
  }
}

const COLLECTION = 'notificacoesMelhorEnvio';
const timestamp = {} as Timestamp;
const asDb = (db: FakeDb): Firestore => db as unknown as Firestore;

function payload(
  over: Partial<MelhorEnvioNotificationPayload> = {},
): MelhorEnvioNotificationPayload {
  return {
    labelId: 'label-1',
    event: 'order.posted',
    providerStatus: 'posted',
    tracking: null,
    ...over,
  };
}

function pedido(id = 'pedido-1'): PedidoMatch {
  return {
    id,
    updateTime: timestamp,
    data: { freteInicial: { estado: 'postado', codRastreio: null } },
  };
}

function processDeps(
  find: MelhorEnvioProcessDeps['findPedidoByLabel'] = vi.fn(async () => pedido()),
): MelhorEnvioProcessDeps {
  return { findPedidoByLabel: find, updatePedido: vi.fn(async () => {}) };
}

function seedFailure(
  db: FakeDb,
  value: MelhorEnvioNotificationPayload,
  over: DocData = {},
): string {
  const id = notificationDocId(value);
  db.seed(COLLECTION, id, {
    ...value,
    status: 'failed',
    tentativas: 0,
    erro: 'falha anterior',
    processedAt: 1_000,
    ...over,
  });
  return id;
}

describe('Melhor Envio notification pipeline', () => {
  it('persists neither successful work nor deterministic drops', async () => {
    const db = new FakeDb();
    await expect(
      handleNotificationTask(asDb(db), payload(), 0, processDeps()),
    ).resolves.toMatchObject({ outcome: 'done', kind: 'noop', detail: 'sem-alteracao' });
    await expect(
      handleNotificationTask(asDb(db), payload({ providerStatus: 'unknown' }), 0, processDeps()),
    ).resolves.toMatchObject({ outcome: 'dropped', kind: 'dropped' });
    expect(db.rows(COLLECTION).size).toBe(0);
  });

  it('rethrows transient failures before the last task attempt', async () => {
    const db = new FakeDb();
    const deps = processDeps(vi.fn(async () => Promise.reject(new Error('firestore offline'))));
    await expect(handleNotificationTask(asDb(db), payload(), 0, deps)).rejects.toThrow(
      'firestore offline',
    );
    expect(db.rows(COLLECTION).size).toBe(0);
  });

  it('persists a final-attempt transient failure using the deterministic id', async () => {
    const db = new FakeDb();
    const value = payload();
    const deps = processDeps(vi.fn(async () => Promise.reject(new Error('firestore offline'))));
    await expect(
      handleNotificationTask(asDb(db), value, TASK_MAX_ATTEMPTS - 1, deps),
    ).resolves.toMatchObject({ outcome: 'failed', labelId: 'label-1' });
    expect(db.rows(COLLECTION).get(notificationDocId(value))).toMatchObject({
      labelId: 'label-1',
      providerStatus: 'posted',
      status: 'failed',
      tentativas: 0,
      erro: 'firestore offline',
    });
  });

  it('rethrows the original error when the correlated persistence also fails', async () => {
    const db = new FakeDb();
    const value = payload();
    db.failCreateIds.add(notificationDocId(value));
    const deps = processDeps(vi.fn(async () => Promise.reject(new Error('original outage'))));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      handleNotificationTask(asDb(db), value, TASK_MAX_ATTEMPTS - 1, deps),
    ).rejects.toThrow('original outage');
    expect(db.rows(COLLECTION).size).toBe(0);
  });

  it('deletes resolved rows, increments failures, parks at the cap, and isolates errors', async () => {
    const db = new FakeDb();
    const resolved = payload({ labelId: 'resolved' });
    const failed = payload({ labelId: 'failed' });
    const parked = payload({ labelId: 'parked' });
    const resolvedId = seedFailure(db, resolved);
    const failedId = seedFailure(db, failed);
    const parkedId = seedFailure(db, parked, { tentativas: MAX_TENTATIVAS - 1 });
    const deps = processDeps(
      vi.fn(async (_db, labelId) => {
        if (labelId !== 'resolved') throw new Error(`temporary ${labelId}`);
        return pedido();
      }),
    );

    const result = await reprocessNotifications(asDb(db), { now: 10_000, olderThanMs: 100 }, deps);

    expect(result.processed).toBe(1);
    expect(result.outcomes['sem-alteracao']).toBe(1);
    expect(result.errors).toHaveLength(2);
    expect(db.rows(COLLECTION).has(resolvedId)).toBe(false);
    expect(db.rows(COLLECTION).get(failedId)).toMatchObject({
      status: 'failed',
      tentativas: 1,
      processedAt: 10_000,
    });
    expect(db.rows(COLLECTION).get(parkedId)).toMatchObject({
      status: 'parked',
      tentativas: MAX_TENTATIVAS,
      processedAt: 10_000,
    });
  });
});
