import { describe, expect, it } from 'vitest';
import type { QueryDocumentSnapshot, QuerySnapshot } from 'firebase/firestore';
import { mapSnapshotRows } from './useSnapshot';

/**
 * Build a fake `QuerySnapshot` from `[id, data]` pairs. Only the members
 * `mapSnapshotRows` touches (`docs`, `id`, `ref.path`, `data()`) are populated;
 * the cast keeps the test free of the full SDK surface.
 */
function fakeSnapshot<T>(entries: Array<[string, T]>): {
  snap: QuerySnapshot<T>;
  docs: QueryDocumentSnapshot<T>[];
} {
  const docs = entries.map(
    ([id, data]) =>
      ({
        id,
        ref: { path: `chat/${id}` },
        data: () => data,
      }) as unknown as QueryDocumentSnapshot<T>,
  );
  return { snap: { docs } as unknown as QuerySnapshot<T>, docs };
}

describe('mapSnapshotRows', () => {
  it('maps id/path/data without a snap cursor by default (useSnapshot shape)', () => {
    const { snap } = fakeSnapshot([
      ['a', { n: 1 }],
      ['b', { n: 2 }],
    ]);
    const rows = mapSnapshotRows(snap, false);
    expect(rows).toEqual([
      { id: 'a', path: 'chat/a', data: { n: 1 } },
      { id: 'b', path: 'chat/b', data: { n: 2 } },
    ]);
    // The additive field stays undefined for the classic hook.
    expect(rows[0]!.snap).toBeUndefined();
  });

  it('attaches the raw QueryDocumentSnapshot as row.snap when includeDocs is true', () => {
    const { snap, docs } = fakeSnapshot([
      ['a', { n: 1 }],
      ['b', { n: 2 }],
    ]);
    const rows = mapSnapshotRows(snap, true);
    // Same id/path/data, plus the cursor doc used by paginate({ after }).
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows[0]!.snap).toBe(docs[0]);
    expect(rows[1]!.snap).toBe(docs[1]);
  });

  it('returns an empty array for an empty snapshot', () => {
    const { snap } = fakeSnapshot<{ n: number }>([]);
    expect(mapSnapshotRows(snap, true)).toEqual([]);
  });
});
