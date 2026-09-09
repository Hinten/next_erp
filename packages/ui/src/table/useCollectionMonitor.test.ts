import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

/**
 * The staleness detector behind `TableView`'s "Página desatualizada" control.
 *
 * It had no test of its own until this file, and the two rules worth pinning
 * are both about WHEN the baseline is captured — the part that decides whether
 * the notice is information or noise:
 *
 *  1. Pin only on SERVER truth. The IndexedDB cache emits first, so pinning
 *     that emission made the cache→server correction itself read as "someone
 *     added a record", on a table nobody had touched.
 *  2. Forget the baseline when the monitor is switched off. `TableView`
 *     disables it whenever its list goes back to STREAMING, and a baseline
 *     surviving that would fire against the previous static session the moment
 *     a filter came back — over rows re-executed a millisecond earlier.
 */
const { snapRef } = vi.hoisted(() => ({
  snapRef: {
    current: { data: undefined, loading: false, error: undefined, fromCache: undefined } as {
      data?: { id: string; path: string; data: Record<string, unknown> }[];
      loading: boolean;
      error?: Error;
      fromCache?: boolean;
    },
  },
}));

vi.mock('@delfrance/data', async () => {
  const actual = await vi.importActual<typeof import('@delfrance/data')>('@delfrance/data');
  return {
    ...actual,
    // The returned object matters only as an identity for the query memo.
    buildQuery: () => ({ __query: true }),
    orderByField: () => ({ __c: 'orderBy' }),
    limit: () => ({ __c: 'limit' }),
  };
});

vi.mock('@delfrance/data/hooks', async () => {
  const actual =
    await vi.importActual<typeof import('@delfrance/data/hooks')>('@delfrance/data/hooks');
  return {
    ...actual,
    // Mirrors the real hook's `if (!q)` early return (useSnapshot.ts): a null
    // query never subscribes and reports no data. That is the whole reason a
    // null `field` costs nothing.
    useSnapshot: (q: unknown) =>
      q ? snapRef.current : { data: undefined, loading: false, error: undefined },
  };
});

import { useCollectionMonitor } from './useCollectionMonitor';

const DB = {} as never;
/** Only its identity matters here — every query builder above is mocked. */
const collection = {
  resolvePath: () => 'tests',
  ref: () => ({}),
  docRef: () => ({}),
  converter: {},
  merge: () => Promise.resolve(),
} as unknown as Parameters<typeof useCollectionMonitor>[0]['collection'];

const FIELD = 'ultimaModificacao';

/** What the listener reports once the server has answered. */
function fromServer(id: string, value: number) {
  return {
    data: [{ id, path: `tests/${id}`, data: { ultimaModificacao: value } }],
    loading: false,
    error: undefined,
    fromCache: false,
  };
}

/** The IndexedDB emission that always arrives first. */
function fromCache(id: string, value: number) {
  return { ...fromServer(id, value), fromCache: true };
}

/** Stands in for the row query object TableView passes as `rowsGeneration`. */
const ROWS_A = { __rows: 'a' };
const ROWS_B = { __rows: 'b' };

function mount(field: string | null = FIELD) {
  let gen: unknown = ROWS_A;
  const view = renderHook(
    ({ f, g }: { f: string | null; g: unknown }) =>
      useCollectionMonitor({ db: DB, collection, field: f, rowsGeneration: g }),
    { initialProps: { f: field, g: gen } },
  );
  /** Emit a snapshot and let the hook see it. */
  const emit = (snap: ReturnType<typeof fromServer>, f: string | null = field) => {
    snapRef.current = snap;
    view.rerender({ f, g: gen });
  };
  return {
    ...view,
    emit,
    retarget: (f: string | null) => view.rerender({ f, g: gen }),
    /** The rows were re-read — a filter change, a re-sort, a "Carregar mais". */
    reread: (g: unknown = ROWS_B) => {
      gen = g;
      view.rerender({ f: field, g });
    },
  };
}

describe('useCollectionMonitor', () => {
  // `snapRef` is module state: without this, a test mounts against whatever
  // document the previous one left behind and pins its baseline to that, so
  // the first emission here reads as someone else's write.
  beforeEach(() => {
    snapRef.current = { data: undefined, loading: false, error: undefined, fromCache: undefined };
  });

  it('pins its baseline on server truth, not on the cache emission', () => {
    const { result, emit } = mount();

    // The cache answers first, and it can be WRONG — it is the state before
    // whatever the server is about to correct.
    emit(fromCache('a', 1));
    expect(result.current.stale, 'nothing is pinned yet, so nothing can differ').toBe(false);

    // The correction. Pinning the cache emission above would have read this as
    // a fresh write by someone else.
    emit(fromServer('b', 2));
    expect(result.current.stale, 'this IS the baseline, not a change to it').toBe(false);

    emit(fromServer('c', 3));
    expect(result.current.stale, 'a real write after the baseline').toBe(true);
  });

  it('re-pins against server truth after the list goes back to streaming', () => {
    const { result, emit, retarget } = mount();
    emit(fromServer('a', 1));
    expect(result.current.stale).toBe(false);

    // Another session writes, so the notice goes up.
    emit(fromServer('b', 2));
    expect(result.current.stale).toBe(true);

    // The operator clears the filter: the list streams again and TableView
    // switches the monitor off. A raised flag must not survive that — the
    // rows below it are now live.
    retarget(null);
    expect(result.current.stale, 'a streaming list is never out of date').toBe(false);

    // A third session writes while we were streaming...
    snapRef.current = fromServer('c', 3);
    // ...and the filter comes back, re-executing the rows against THIS state.
    retarget(FIELD);
    expect(
      result.current.stale,
      'the rows were just refetched; a surviving baseline would call them stale',
    ).toBe(false);

    // Re-armed, not dead: the next real write still reports.
    emit(fromServer('d', 4));
    expect(result.current.stale).toBe(true);
  });

  it('takes the notice down when the rows are re-read by anything else', () => {
    // A frozen list re-executes on a filter change, a re-sort, a "Carregar
    // mais" and a completed action — none of which go through this monitor's
    // own button. The re-read already contains the write being reported, so
    // leaving the notice up says a list that just updated itself is behind.
    const { result, emit, reread } = mount();
    emit(fromServer('a', 1));
    emit(fromServer('b', 2));
    expect(result.current.stale).toBe(true);

    reread();
    expect(result.current.stale, 'those rows now include the write').toBe(false);

    // Re-pinned to the CURRENT state in the same pass, not merely muted: the
    // next write is still reported rather than being swallowed as a baseline.
    emit(fromServer('c', 3));
    expect(result.current.stale).toBe(true);
  });

  it('stays quiet while the rows are not re-read', () => {
    // The guard against the fix above going too far: `rowsGeneration` must be
    // a STABLE identity per row query. If TableView ever handed over a value
    // that churned per render, every render would re-pin and the monitor would
    // silently never report anything again.
    const { result, emit } = mount();
    emit(fromServer('a', 1));
    emit(fromServer('a', 1));
    emit(fromServer('a', 1));
    expect(result.current.stale).toBe(false);
    emit(fromServer('b', 2));
    expect(result.current.stale, 'still armed after idle re-renders').toBe(true);
  });

  it('clears the notice when the operator acknowledges it', () => {
    const { result, emit } = mount();
    emit(fromServer('a', 1));
    emit(fromServer('b', 2));
    expect(result.current.stale).toBe(true);

    act(() => result.current.acknowledge());
    expect(result.current.stale).toBe(false);

    // Acknowledging re-baselines rather than muting: the same state stays
    // quiet, a further write does not.
    emit(fromServer('b', 2));
    expect(result.current.stale).toBe(false);
    emit(fromServer('c', 3));
    expect(result.current.stale).toBe(true);
  });
});
