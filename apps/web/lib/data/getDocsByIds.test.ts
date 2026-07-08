import { describe, expect, it, vi } from 'vitest';
import type { CollectionHandle } from '@delfrance/data';
import type { Firestore } from 'firebase/firestore';
import type { z } from 'zod';

// getDocs receives the query built from a chunk; the mocked buildQuery threads
// the chunk's ids straight through so we can assert per-chunk sizes.
const { getDocsMock } = vi.hoisted(() => ({
  getDocsMock: vi.fn(async (q: { ids: string[] }) => ({
    docs: q.ids.map((id) => ({ id, data: () => ({ id }) })),
  })),
}));

vi.mock('firebase/firestore', () => ({ getDocs: getDocsMock }));
vi.mock('@delfrance/data', () => ({
  whereDocIdIn: (ids: string[]) => ({ ids }),
  buildQuery: (_base: unknown, constraints: Array<{ ids: string[] }>) => ({
    ids: constraints[0]!.ids,
  }),
}));

import { getDocsByIds } from './getDocsByIds';

const handle = { ref: () => ({}) } as unknown as CollectionHandle<z.ZodString>;
const db = {} as unknown as Firestore;

describe('getDocsByIds', () => {
  it('splits ids into ≤30-value in-queries at the chunk boundaries', async () => {
    for (const [count, expectedChunks] of [
      [29, 1],
      [30, 1],
      [31, 2],
      [61, 3],
    ] as const) {
      getDocsMock.mockClear();
      const ids = Array.from({ length: count }, (_, i) => `id${i}`);
      const map = await getDocsByIds(db, handle, ids);
      expect(getDocsMock).toHaveBeenCalledTimes(expectedChunks);
      expect(map.size).toBe(count);
    }
  });

  it('dedupes and drops empty ids (one chunk)', async () => {
    getDocsMock.mockClear();
    const map = await getDocsByIds(db, handle, ['a', 'a', '', 'b']);
    expect(getDocsMock).toHaveBeenCalledTimes(1);
    expect([...map.keys()].sort()).toEqual(['a', 'b']);
  });

  it('returns an empty map without querying when there are no valid ids', async () => {
    getDocsMock.mockClear();
    const map = await getDocsByIds(db, handle, ['', '']);
    expect(getDocsMock).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });
});
