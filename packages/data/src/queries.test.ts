import { describe, expect, it, vi } from 'vitest';

// The helpers are declarative 1-line wrappers — the behavior under test is
// which operator each one forwards to the SDK's `where()`.
const { whereMock } = vi.hoisted(() => ({
  whereMock: vi.fn((field: string, op: string, value: unknown) => ({ field, op, value })),
}));

vi.mock('firebase/firestore', () => ({
  where: whereMock,
  documentId: vi.fn(() => '__name__'),
  orderBy: vi.fn(),
  limit: vi.fn(),
  query: vi.fn(),
  startAfter: vi.fn(),
  endBefore: vi.fn(),
  collectionGroup: vi.fn(),
}));

import { whereArrayContains, whereDocIdIn, whereEqual, whereOp } from './queries';

describe('where helpers', () => {
  it('whereEqual forwards the == operator', () => {
    expect(whereEqual('cpf_cnpj', '123')).toEqual({ field: 'cpf_cnpj', op: '==', value: '123' });
  });

  it('whereOp forwards the given operator', () => {
    expect(whereOp('nome', '>=', 'a')).toEqual({ field: 'nome', op: '>=', value: 'a' });
  });

  it('whereArrayContains forwards array-contains', () => {
    expect(whereArrayContains('componentesKitKeys', 'prod1')).toEqual({
      field: 'componentesKitKeys',
      op: 'array-contains',
      value: 'prod1',
    });
  });

  it('whereDocIdIn forwards documentId() with the in operator', () => {
    expect(whereDocIdIn(['a', 'b'])).toEqual({ field: '__name__', op: 'in', value: ['a', 'b'] });
  });
});
