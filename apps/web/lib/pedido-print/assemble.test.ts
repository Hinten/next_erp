import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase/firestore';
import type { Produto } from '@delfrance/schemas';

/**
 * Read-count coverage for the print path's cover-photo resolver.
 *
 * The comum print is the BATCH path — `batch.ts` drives many pedidos in bounded
 * waves — so how many documents this resolver reads per photo is a real cost on
 * a database that bills data scanned (root `CLAUDE.md` rule 1). Resolving the
 * candidate ladder eagerly would triple it permanently, so the healthy case is
 * pinned here at one read per distinct photo.
 */
const { reads, docs } = vi.hoisted(() => ({
  reads: { current: [] as string[] },
  docs: { current: {} as Record<string, { url: string | null } | undefined> },
}));

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<typeof import('firebase/firestore')>('firebase/firestore');
  return {
    ...actual,
    getDoc: async (ref: { id: string }) => {
      reads.current.push(ref.id);
      const data = docs.current[ref.id];
      return { exists: () => data !== undefined, data: () => data };
    },
  };
});

vi.mock('@delfrance/storage', () => ({
  arquivoCollection: {
    docRef: (_db: unknown, _scope: unknown, id: string) => ({ id }),
  },
}));

import { buildFotoResolver } from './assemble';

const db = {} as Firestore;

/** A produto whose upload wrote all three optimistic derivative refs. */
function produto(id: string): Produto {
  return {
    fotos: [
      {
        arquivoOuterRef: `arquivos/${id}`,
        arquivo200pxOuterRef: `arquivos/${id}_200`,
        arquivo400pxOuterRef: `arquivos/${id}_400`,
        arquivoJpegOuterRef: `arquivos/${id}_jpeg`,
      },
    ],
  } as unknown as Produto;
}

afterEach(() => {
  reads.current = [];
  docs.current = {};
  vi.clearAllMocks();
});

describe('buildFotoResolver', () => {
  it('reads ONE document per photo when the preferred derivative exists', async () => {
    docs.current = { p1_200: { url: 'https://cdn/p1_200.jpg' } };
    const resolve = await buildFotoResolver(db, new Map([['p1', produto('p1')]]));
    expect(resolve('p1')).toBe('https://cdn/p1_200.jpg');
    // ⚠️ The whole point: NOT ['p1_200', 'p1_400', 'p1'].
    expect(reads.current).toEqual(['p1_200']);
  });

  it('only the produtos that missed pay for the next rung', async () => {
    // p1 healthy, p2 degraded (no derivatives, original intact).
    docs.current = {
      p1_200: { url: 'https://cdn/p1_200.jpg' },
      p2: { url: 'https://cdn/p2.jpg' },
    };
    const resolve = await buildFotoResolver(
      db,
      new Map([
        ['p1', produto('p1')],
        ['p2', produto('p2')],
      ]),
    );
    expect(resolve('p1')).toBe('https://cdn/p1_200.jpg');
    expect(resolve('p2')).toBe('https://cdn/p2.jpg');
    // Wave 1 asks both; wave 2 asks only p2; p1 never reaches its lower rungs.
    expect(reads.current).toEqual(['p1_200', 'p2_200', 'p2_400', 'p2']);
  });

  it('falls through to the original when no derivative document exists', async () => {
    docs.current = { p1: { url: 'https://cdn/p1.jpg' } };
    const resolve = await buildFotoResolver(db, new Map([['p1', produto('p1')]]));
    expect(resolve('p1')).toBe('https://cdn/p1.jpg');
    expect(reads.current).toEqual(['p1_200', 'p1_400', 'p1']);
  });

  it('fetches a shared photo once, however many produtos name it', async () => {
    docs.current = { shared_200: { url: 'https://cdn/shared.jpg' } };
    const p = produto('shared');
    const resolve = await buildFotoResolver(
      db,
      new Map([
        ['a', p],
        ['b', p],
      ]),
    );
    expect(resolve('a')).toBe('https://cdn/shared.jpg');
    expect(resolve('b')).toBe('https://cdn/shared.jpg');
    expect(reads.current).toEqual(['shared_200']);
  });

  it('returns null when every candidate is missing, and reads each once', async () => {
    docs.current = {};
    const resolve = await buildFotoResolver(db, new Map([['p1', produto('p1')]]));
    expect(resolve('p1')).toBeNull();
    expect(reads.current).toEqual(['p1_200', 'p1_400', 'p1']);
  });

  it('treats a doc that exists with a null url as an empty rung', async () => {
    docs.current = { p1_200: { url: null }, p1: { url: 'https://cdn/p1.jpg' } };
    const resolve = await buildFotoResolver(db, new Map([['p1', produto('p1')]]));
    expect(resolve('p1')).toBe('https://cdn/p1.jpg');
  });

  it('reads nothing for a produto with no photo, and resolves unknown ids to null', async () => {
    const semFoto = { fotos: null } as unknown as Produto;
    const resolve = await buildFotoResolver(db, new Map([['p1', semFoto]]));
    expect(resolve('p1')).toBeNull();
    expect(resolve('desconhecido')).toBeNull();
    expect(resolve(null)).toBeNull();
    expect(reads.current).toEqual([]);
  });
});
