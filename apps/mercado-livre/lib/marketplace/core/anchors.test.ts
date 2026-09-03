import type { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { resolverAnchors } from './anchors';

/** Minimal fake Firestore: `resolverAnchors` only needs `doc` refs + `getAll`. */
function fakeDb(docs: Record<string, Record<string, unknown> | null>): Firestore {
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({ id, path: `${name}/${id}`, __id: id }),
    }),
    getAll: (...args: unknown[]) => {
      const refs = args.filter((a) => a != null && typeof a === 'object' && '__id' in a) as Array<{
        __id: string;
      }>;
      return Promise.resolve(
        refs.map((ref) => {
          const data = docs[ref.__id];
          return { exists: data != null, data: () => data ?? undefined };
        }),
      );
    },
  } as unknown as Firestore;
}

describe('resolverAnchors', () => {
  it('maps a variation child to its parent and dedupes with the parent', async () => {
    const db = fakeDb({
      PROD: { paiId: null, nome: 'Camiseta' },
      CH1: { paiId: 'PROD', nome: 'Camiseta P' },
    });
    const res = await resolverAnchors(db, ['CH1', 'PROD']);
    expect(res.anchorIds).toEqual(['PROD']);
    expect(res.anchorPorProdutoId.get('CH1')).toBe('PROD');
    expect(res.naoEncontrados).toEqual([]);
  });

  it('reports a missing produto instead of silently dropping it', async () => {
    // `documents([...])` SILENTLY OMITS a missing doc, so a pipeline alone could
    // never tell "does not exist" from "is not an anchor". This pass is the only
    // place that distinction is available.
    const db = fakeDb({ PROD: { paiId: null, nome: 'Camiseta' }, SUMIU: null });
    const res = await resolverAnchors(db, ['PROD', 'SUMIU']);
    expect(res.anchorIds).toEqual(['PROD']);
    expect(res.naoEncontrados).toEqual(['SUMIU']);
  });

  it('dedupes a repeated id and keeps first-seen request order', async () => {
    const db = fakeDb({
      A: { paiId: null, nome: 'A' },
      B: { paiId: null, nome: 'B' },
    });
    const res = await resolverAnchors(db, ['B', 'A', 'B']);
    expect(res.anchorIds).toEqual(['B', 'A']);
  });
});
