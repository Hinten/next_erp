import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useServerTruthSeed, type ServerTruthSeedArgs } from './useServerTruthSeed';

/**
 * Drives the hook through a snapshot sequence. Each entry is one emission; the
 * component re-renders per entry, which is what a live `onSnapshot` does.
 */
function Harness(props: Omit<ServerTruthSeedArgs, 'onSeed'> & { onSeed: (s: boolean) => void }) {
  useServerTruthSeed(props);
  return null;
}

function seedThrough(
  emissions: ReadonlyArray<Omit<ServerTruthSeedArgs, 'onSeed'>>,
): Array<boolean> {
  const seen: boolean[] = [];
  const onSeed = (serverTruth: boolean) => void seen.push(serverTruth);
  const { rerender } = render(<Harness {...emissions[0]!} onSeed={onSeed} />);
  for (const e of emissions.slice(1)) rerender(<Harness {...e} onSeed={onSeed} />);
  return seen;
}

describe('useServerTruthSeed', () => {
  it('paints the first (cached) emission immediately', () => {
    // Blocking until the server answers would cost every editor a round trip on
    // open — the point is to correct the paint, not to delay it.
    expect(seedThrough([{ id: 'p1', fromCache: true, isDirty: false }])).toEqual([false]);
  });

  it('corrects a cache paint once the authoritative snapshot lands', () => {
    const seen = seedThrough([
      { id: 'p1', fromCache: true, isDirty: false },
      { id: 'p1', fromCache: false, isDirty: false },
    ]);
    expect(seen).toEqual([false, true]);
  });

  it('corrects at most once per record', () => {
    // A later live emission for the same doc must not re-reset the form; the
    // operator may have started typing between renders.
    const seen = seedThrough([
      { id: 'p1', fromCache: true, isDirty: false },
      { id: 'p1', fromCache: false, isDirty: false },
      { id: 'p1', fromCache: false, isDirty: false },
    ]);
    expect(seen).toEqual([false, true]);
  });

  it('never overwrites a dirty form', () => {
    // THE load-bearing one. The user typed while the server snapshot was in
    // flight — their edits win, and the stale paint they are looking at stays,
    // so whatever the caller derived from it (a concurrency baseline) still
    // describes the same version.
    const seen = seedThrough([
      { id: 'p1', fromCache: true, isDirty: false },
      { id: 'p1', fromCache: false, isDirty: true },
    ]);
    expect(seen).toEqual([false]);
  });

  it('pays an owed correction once the form goes pristine again', () => {
    // The counterpart to the test above, and the reason `isDirty` is a
    // dependency. The server snapshot lands mid-edit and is rightly skipped —
    // but it must not be LOST. Keyed on `[id, fromCache]` alone it was: neither
    // value changes again, so nothing ever re-ran, and the operator kept
    // editing a form whose untouched fields still held the pre-write cache.
    const seen = seedThrough([
      { id: 'p1', fromCache: true, isDirty: false },
      { id: 'p1', fromCache: false, isDirty: true },
      { id: 'p1', fromCache: false, isDirty: false },
    ]);
    expect(seen).toEqual([false, true]);
  });

  it('pays an owed correction at most once', () => {
    // Going dirty again after the debt is settled must not re-seed — by then
    // the form holds server truth and any edit on top of it is the operator's.
    const seen = seedThrough([
      { id: 'p1', fromCache: true, isDirty: false },
      { id: 'p1', fromCache: false, isDirty: true },
      { id: 'p1', fromCache: false, isDirty: false },
      { id: 'p1', fromCache: false, isDirty: true },
      { id: 'p1', fromCache: false, isDirty: false },
    ]);
    expect(seen).toEqual([false, true]);
  });

  it('owes nothing when no server snapshot ever arrived', () => {
    // A dirty→pristine transition is not itself a reason to re-seed; only an
    // authoritative snapshot is. Otherwise an operator undoing their own typing
    // would get the stale cache re-applied on top.
    const seen = seedThrough([
      { id: 'p1', fromCache: true, isDirty: false },
      { id: 'p1', fromCache: true, isDirty: true },
      { id: 'p1', fromCache: true, isDirty: false },
    ]);
    expect(seen).toEqual([false]);
  });

  it('re-seeds when the record changes, even from cache', () => {
    const seen = seedThrough([
      { id: 'p1', fromCache: false, isDirty: false },
      { id: 'p2', fromCache: true, isDirty: false },
    ]);
    expect(seen).toEqual([true, false]);
  });

  it('does nothing until something is loaded', () => {
    expect(seedThrough([{ id: undefined, fromCache: undefined, isDirty: false }])).toEqual([]);
  });

  it('seeds once for a source with no cache metadata', () => {
    // `fromCache: undefined` is a non-Firestore source (the one-shot Pipelines
    // hook), which is always authoritative — but it is not `=== false`, so it
    // paints once and is never "corrected". One seed, not zero and not two.
    const seen = seedThrough([
      { id: 'p1', fromCache: undefined, isDirty: false },
      { id: 'p1', fromCache: undefined, isDirty: false },
    ]);
    expect(seen).toEqual([false]);
  });

  it('reads isDirty at emission time, not from the render that armed it', () => {
    const onSeed = vi.fn();
    const { rerender } = render(
      <Harness id="p1" fromCache={true} isDirty={false} onSeed={onSeed} />,
    );
    // The form goes dirty WITHOUT a new snapshot — no re-seed may fire.
    rerender(<Harness id="p1" fromCache={true} isDirty={true} onSeed={onSeed} />);
    expect(onSeed).toHaveBeenCalledTimes(1);
  });
});
