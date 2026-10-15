import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import type { TokenDuravel } from '@delfrance/schemas';

const h = vi.hoisted(() => ({ set: vi.fn(), list: vi.fn(), commit: vi.fn(), remove: vi.fn() }));
vi.mock('@delfrance/data/admin/collections', () => ({
  tokenDuravelCollection: {
    ref: () => ({ select: () => ({ get: h.list }) }),
    docRef: () => ({ set: h.set }),
    parse: (value: unknown) => value,
  },
}));

import { createTokenDuravelStore } from './tokenStore';

const fresh: TokenDuravel = {
  access_token: 'AT',
  refresh_token: 'RT',
  token_type: 'bearer',
  scope: '',
  expires_in: 1_700_003_600_000,
  user_id: null,
  expired: null,
};
const db = {
  batch: () => ({ delete: h.remove, commit: h.commit }),
} as unknown as Firestore;

beforeEach(() => {
  vi.resetAllMocks();
  h.set.mockResolvedValue(undefined);
  h.commit.mockResolvedValue(undefined);
});

describe('durable credential mutation invalidation', () => {
  it('invalidates only after a successful save and preserves failed writes', async () => {
    const changed = vi.fn();
    const store = createTokenDuravelStore(db, 'i1', { onCredentialsChanged: changed });
    await expect(store.save(fresh)).resolves.toBe(fresh);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(h.set.mock.invocationCallOrder[0]).toBeLessThan(changed.mock.invocationCallOrder[0]!);
    const failure = new Error('write failed');
    h.set.mockRejectedValueOnce(failure);
    await expect(store.save(fresh)).rejects.toBe(failure);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('invalidates an empty deletion too, fencing previously cached credentials', async () => {
    const changed = vi.fn();
    h.list.mockResolvedValue({ empty: true, docs: [], size: 0 });
    const store = createTokenDuravelStore(db, 'i1', { onCredentialsChanged: changed });
    await expect(store.deleteAll()).resolves.toBe(0);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('invalidates after a partial deletion failure and rethrows the original error', async () => {
    const events: string[] = [];
    const failure = new Error('second batch failed');
    h.list.mockResolvedValue({
      empty: false,
      docs: Array.from({ length: 451 }, (_, id) => ({ ref: { id } })),
      size: 451,
    });
    h.commit.mockImplementationOnce(async () => {
      events.push('first batch');
    });
    h.commit.mockImplementationOnce(async () => {
      events.push('failed batch');
      throw failure;
    });
    const store = createTokenDuravelStore(db, 'i1', {
      onCredentialsChanged: () => {
        events.push('invalidate');
      },
    });
    await expect(store.deleteAll()).rejects.toBe(failure);
    expect(events).toEqual(['invalidate', 'first batch', 'failed batch', 'invalidate']);
    expect(h.remove).toHaveBeenCalledTimes(451);
  });
});
