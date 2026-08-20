import { describe, expect, it, vi } from 'vitest';
import type { CollectionHandle } from '@delfrance/data';
import type { Firestore } from 'firebase/firestore';
import type { z } from 'zod';

// getDocs receives the query built from a chunk; the mocked buildQuery threads
// the chunk's ids straight through so we can assert per-chunk sizes.
const { getDocsMock, getDocsFromServerMock } = vi.hoisted(() => {
  const snap = async (q: { ids: string[] }) => ({
    docs: q.ids.map((id) => ({ id, data: () => ({ id }) })),
  });
  return { getDocsMock: vi.fn(snap), getDocsFromServerMock: vi.fn(snap) };
});

vi.mock('firebase/firestore', () => ({
  getDocs: getDocsMock,
  getDocsFromServer: getDocsFromServerMock,
}));
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

describe('getDocsByIds source', () => {
  it('defaults to the cache-capable getDocs', async () => {
    getDocsMock.mockClear();
    getDocsFromServerMock.mockClear();

    await getDocsByIds(db, handle, ['a']);

    expect(getDocsMock).toHaveBeenCalledTimes(1);
    expect(getDocsFromServerMock).not.toHaveBeenCalled();
  });

  it("uses getDocsFromServer for source: 'server'", async () => {
    // Callers that PERSIST something derived from the result need an absent id
    // to mean "does not exist", never "the cache has not seen it" — so an
    // offline read has to reject rather than come back empty.
    getDocsMock.mockClear();
    getDocsFromServerMock.mockClear();

    await getDocsByIds(db, handle, ['a'], {}, { source: 'server' });

    expect(getDocsFromServerMock).toHaveBeenCalledTimes(1);
    expect(getDocsMock).not.toHaveBeenCalled();
  });

  it('still chunks at 30 ids when forced to the server', async () => {
    getDocsFromServerMock.mockClear();

    await getDocsByIds(
      db,
      handle,
      Array.from({ length: 61 }, (_, i) => `id${i}`),
      {},
      { source: 'server' },
    );

    expect(getDocsFromServerMock).toHaveBeenCalledTimes(3);
  });
});
