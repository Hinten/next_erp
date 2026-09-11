import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildCheckoutReportPipeline,
  checkoutDateRange,
  checkoutGroupFromResult,
  loadCheckoutReport,
} from './checkouts';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), getDoc: vi.fn(), docRef: vi.fn() }));
vi.mock('firebase/firestore', () => ({ getDoc: mocks.getDoc }));
vi.mock('@/lib/data/usuarioCollection', () => ({ usuarioCollection: { docRef: mocks.docRef } }));
vi.mock('firebase/firestore/pipelines', () => {
  const expr = (kind: string, ...args: unknown[]) => ({
    kind,
    args,
    as: (alias: string) => ({ kind, args, alias }),
  });
  return {
    execute: mocks.execute,
    field: (name: string) => ({
      kind: 'field',
      name,
      ifAbsent: (fallback: unknown) => expr('ifAbsent', name, fallback),
    }),
    countAll: () => expr('countAll'),
    and: (...args: unknown[]) => expr('and', ...args),
    greaterThanOrEqual: (...args: unknown[]) => expr('gte', ...args),
    lessThan: (...args: unknown[]) => expr('lt', ...args),
  };
});

function database() {
  const aggregate = vi.fn().mockReturnValue({ aggregated: true });
  const where = vi.fn().mockReturnValue({ aggregate });
  const collectionGroup = vi.fn().mockReturnValue({ where });
  const pipeline = vi.fn().mockReturnValue({ collectionGroup });
  return { db: { pipeline } as unknown as Firestore, pipeline, collectionGroup, where, aggregate };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.docRef.mockImplementation((_db, _ctx, id: string) => ({ id }));
  mocks.getDoc.mockImplementation(async ({ id }: { id: string }) => ({
    data: () => ({ nome: id, colaborador: true }),
  }));
});

describe('checkout pipeline', () => {
  it('filters the collection group by a millisecond range, then counts all rows grouped by user', () => {
    const mock = database();
    expect(buildCheckoutReportPipeline(mock.db, { startMs: 1000, endExclusiveMs: 2000 })).toEqual({
      aggregated: true,
    });
    expect(mock.collectionGroup).toHaveBeenCalledWith('checkout');
    expect(mock.where).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'and',
        args: [
          expect.objectContaining({
            kind: 'gte',
            args: [expect.objectContaining({ name: 'timestamp' }), 1000],
          }),
          expect.objectContaining({
            kind: 'lt',
            args: [expect.objectContaining({ name: 'timestamp' }), 2000],
          }),
        ],
      }),
    );
    expect(mock.aggregate).toHaveBeenCalledWith({
      groups: [
        { kind: 'ifAbsent', args: ['usuarioCheckoutFretePedidoOuterRef', null], alias: 'userRef' },
      ],
      accumulators: [{ kind: 'countAll', args: [], alias: 'count' }],
    });
  });

  it('declares the timestamp-first covering collection-group index without an implicit name field', () => {
    const indexes = JSON.parse(readFileSync(resolve('../../firestore.indexes.json'), 'utf8')) as {
      indexes: {
        collectionGroup: string;
        queryScope: string;
        apiScope?: string;
        density?: string;
        fields: { fieldPath: string; order: string }[];
      }[];
    };
    expect(indexes.indexes).toContainEqual({
      collectionGroup: 'checkout',
      queryScope: 'COLLECTION_GROUP',
      apiScope: 'ANY_API',
      density: 'SPARSE_ANY',
      fields: [
        { fieldPath: 'timestamp', order: 'ASCENDING' },
        { fieldPath: 'usuarioCheckoutFretePedidoOuterRef', order: 'ASCENDING' },
      ],
    });
  });

  it('executes once, resolves only the top 20 distinct users, and counts unresolved/non-collaborators in Other', async () => {
    const groups = Array.from({ length: 25 }, (_, i) => ({
      userRef: `documents/usuarios/u${i}`,
      count: 25 - i,
    }));
    mocks.execute.mockResolvedValue({
      results: [...groups, { userRef: null, count: 10 }].map((data) => ({ data: () => data })),
    });
    mocks.getDoc.mockImplementation(async ({ id }: { id: string }) => ({
      data: () => (id === 'u0' ? undefined : { nome: id, colaborador: id !== 'u1' }),
    }));
    const report = await loadCheckoutReport(database().db, { startMs: 1, endExclusiveMs: 2 });
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith({ aggregated: true });
    expect(mocks.getDoc).toHaveBeenCalledTimes(20);
    expect(mocks.docRef.mock.calls.map((args) => args[2])).toEqual(
      Array.from({ length: 20 }, (_, i) => `u${i}`),
    );
    expect(report.total).toBe(335);
    expect(report.rows.at(-1)).toEqual({ userId: null, label: 'Outros usuários', count: 74 });
  });

  it('merges canonical and bare aliases before choosing name lookups', async () => {
    mocks.execute.mockResolvedValue({
      results: [
        { data: () => ({ userRef: 'documents/usuarios/a', count: 2 }) },
        { data: () => ({ userRef: 'usuarios/a', count: 3 }) },
      ],
    });
    expect(await loadCheckoutReport(database().db, { startMs: 1, endExclusiveMs: 2 })).toEqual({
      total: 5,
      rows: [{ userId: 'a', label: 'a', count: 5 }],
    });
    expect(mocks.getDoc).toHaveBeenCalledTimes(1);
  });

  it('does not read users for an empty result and propagates lookup failures', async () => {
    mocks.execute.mockResolvedValue({ results: [] });
    expect(await loadCheckoutReport(database().db, { startMs: 1, endExclusiveMs: 2 })).toEqual({
      total: 0,
      rows: [],
    });
    expect(mocks.getDoc).not.toHaveBeenCalled();
    mocks.execute.mockResolvedValue({
      results: [{ data: () => ({ userRef: 'usuarios/a', count: 1 }) }],
    });
    mocks.getDoc.mockRejectedValue(new TypeError('lookup failed'));
    await expect(
      loadCheckoutReport(database().db, { startMs: 1, endExclusiveMs: 2 }),
    ).rejects.toThrow('lookup failed');
  });
});

describe('checkout result transformation', () => {
  it.each(['documents/usuarios/a', 'usuarios/a'])('accepts user wire format %s', (userRef) => {
    expect(checkoutGroupFromResult({ userRef, count: 3 })).toEqual({ userId: 'a', count: 3 });
  });
  it.each([null, undefined, 7, '', 'a', 'clientes/a', 'usuarios/a/nested/b', 'usuarios'])(
    'keeps unknown reference %s in the total',
    (userRef) => {
      expect(checkoutGroupFromResult({ userRef, count: 4 })).toEqual({ userId: null, count: 4 });
    },
  );
  it.each([-1, 1.5, NaN, Infinity, '3', null, undefined])(
    'rejects invalid count %s instead of silently undercounting',
    (count) => {
      expect(() => checkoutGroupFromResult({ count })).toThrow('Contagem de checkouts inválida.');
    },
  );
});

describe('checkout calendar range', () => {
  it('includes the complete end date using next local midnight, in ms', () => {
    expect(checkoutDateRange('2026-09-01', '2026-09-30')).toEqual({
      startMs: new Date(2026, 8, 1).getTime(),
      endExclusiveMs: new Date(2026, 9, 1).getTime(),
    });
    expect(checkoutDateRange('2026-12-31', '2026-12-31')?.endExclusiveMs).toBe(
      new Date(2027, 0, 1).getTime(),
    );
  });
  it.each([
    [null, null],
    ['2026-09-01', null],
    ['2026-09-02', '2026-09-01'],
    ['2026-02-30', '2026-03-01'],
  ])('rejects incomplete/invalid ranges %s %s', (start, end) => {
    expect(checkoutDateRange(start, end)).toBeNull();
  });
});
