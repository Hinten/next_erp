import { describe, expect, it, vi } from 'vitest';
import type { CollectionDefaultQuery } from '@delfrance/schemas';

// Tag each SDK constraint so the test can assert the *order* and *content* of
// what `defaultQueryConstraints` emits without a live Firestore.
vi.mock('firebase/firestore', () => ({
  where: (field: string, op: string, value: unknown) => ({ kind: 'where', field, op, value }),
  orderBy: (field: string, direction: string) => ({ kind: 'orderBy', field, direction }),
  limit: (n: number) => ({ kind: 'limit', n }),
  query: vi.fn(),
  startAfter: vi.fn(),
  endBefore: vi.fn(),
  collectionGroup: vi.fn(),
}));

import { defaultQueryConstraints } from './defaultQuery';

describe('defaultQueryConstraints', () => {
  it('emits orderBy then limit for a plain default query', () => {
    const dq: CollectionDefaultQuery = {
      orderBy: [{ field: 'nome', direction: 'asc' }],
      limit: 50,
    };
    expect(defaultQueryConstraints(dq)).toEqual([
      { kind: 'orderBy', field: 'nome', direction: 'asc' },
      { kind: 'limit', n: 50 },
    ]);
  });

  it('emits literal where filters before orderBy', () => {
    const dq: CollectionDefaultQuery = {
      where: [{ field: 'paiId', value: null }],
      orderBy: [{ field: 'nome', direction: 'asc' }],
      limit: 50,
    };
    expect(defaultQueryConstraints(dq)).toEqual([
      { kind: 'where', field: 'paiId', op: '==', value: null },
      { kind: 'orderBy', field: 'nome', direction: 'asc' },
      { kind: 'limit', n: 50 },
    ]);
  });

  it('binds param filters from the params option', () => {
    const dq: CollectionDefaultQuery = {
      where: [{ field: 'tipo', param: true }],
      orderBy: [{ field: 'nome', direction: 'asc' }],
      limit: 50,
    };
    expect(defaultQueryConstraints(dq, { params: { tipo: 7 } })).toEqual([
      { kind: 'where', field: 'tipo', op: '==', value: 7 },
      { kind: 'orderBy', field: 'nome', direction: 'asc' },
      { kind: 'limit', n: 50 },
    ]);
  });

  it('throws when a declared param has no binding', () => {
    const dq: CollectionDefaultQuery = {
      where: [{ field: 'tipo', param: true }],
      orderBy: [{ field: 'nome', direction: 'asc' }],
      limit: 50,
    };
    expect(() => defaultQueryConstraints(dq)).toThrow(/missing runtime value for param "tipo"/);
    expect(() => defaultQueryConstraints(dq, { params: {} })).toThrow(/tipo/);
  });

  it('inserts extraConstraints between orderBy and limit', () => {
    const dq: CollectionDefaultQuery = {
      where: [{ field: 'paiId', value: null }],
      orderBy: [{ field: 'nome', direction: 'asc' }],
      limit: 50,
    };
    const extra = { kind: 'where', field: 'nome', op: '>=', value: 'a' } as never;
    expect(defaultQueryConstraints(dq, { extraConstraints: [extra] })).toEqual([
      { kind: 'where', field: 'paiId', op: '==', value: null },
      { kind: 'orderBy', field: 'nome', direction: 'asc' },
      { kind: 'where', field: 'nome', op: '>=', value: 'a' },
      { kind: 'limit', n: 50 },
    ]);
  });
});
