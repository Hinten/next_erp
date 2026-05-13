import { describe, expect, it, vi } from 'vitest';
import type { CollectionMetadata } from '@delfrance/schemas';
import { CascadeBlockedError, applyCascade } from './cascade';

function fakeAdmin(perPath: Record<string, number>) {
  // Tracks remaining docs per path so we can simulate paged deletes.
  const remaining = { ...perPath };
  return {
    collection: (path: string) => ({
      limit: (n: number) => ({
        get: async () => {
          const r = remaining[path] ?? 0;
          if (r === 0) {
            return { empty: true, size: 0, docs: [] };
          }
          const take = Math.min(n, r);
          remaining[path] = r - take;
          return {
            empty: false,
            size: take,
            docs: Array.from({ length: take }, () => ({
              ref: { delete: vi.fn().mockResolvedValue(undefined) },
            })),
          };
        },
      }),
    }),
    _remaining: remaining,
  };
}

describe('applyCascade', () => {
  it('no-ops when meta has no cascade declarations', async () => {
    const meta: CollectionMetadata = {
      collectionPath: 'foo',
      permissions: { read: 1n, write: 1n, delete: 1n },
    };
    const admin = fakeAdmin({});
    await expect(
      applyCascade(meta, { admin, resolvePath: (p) => p }),
    ).resolves.toBeUndefined();
  });

  it('throws CascadeBlockedError when restrict-declared subcollection is non-empty', async () => {
    const meta: CollectionMetadata = {
      collectionPath: 'pedidos',
      permissions: { read: 1n, write: 1n, delete: 1n },
      cascade: [{ path: 'pedidos/{id}/itens', onDelete: 'restrict' }],
    };
    const admin = fakeAdmin({ 'pedidos/abc/itens': 5 });
    await expect(
      applyCascade(meta, {
        admin,
        resolvePath: (p) => p.replaceAll('{id}', 'abc'),
      }),
    ).rejects.toBeInstanceOf(CascadeBlockedError);
  });

  it('skips empty restrict subcollections without throwing', async () => {
    const meta: CollectionMetadata = {
      collectionPath: 'pedidos',
      permissions: { read: 1n, write: 1n, delete: 1n },
      cascade: [{ path: 'pedidos/{id}/itens', onDelete: 'restrict' }],
    };
    const admin = fakeAdmin({ 'pedidos/abc/itens': 0 });
    await expect(
      applyCascade(meta, {
        admin,
        resolvePath: (p) => p.replaceAll('{id}', 'abc'),
      }),
    ).resolves.toBeUndefined();
  });

  it('paged-deletes cascade-declared subcollections until empty', async () => {
    const meta: CollectionMetadata = {
      collectionPath: 'clientes',
      permissions: { read: 1n, write: 1n, delete: 1n },
      cascade: [{ path: 'clientes/{id}/enderecos', onDelete: 'cascade' }],
    };
    const admin = fakeAdmin({ 'clientes/c1/enderecos': 5 });
    await applyCascade(meta, {
      admin,
      resolvePath: (p) => p.replaceAll('{id}', 'c1'),
      pageSize: 2,
    });
    expect(admin._remaining['clientes/c1/enderecos']).toBe(0);
  });
});
