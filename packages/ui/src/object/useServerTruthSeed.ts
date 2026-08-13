'use client';

import { useEffect, useRef } from 'react';

export interface ServerTruthSeedArgs {
  /** Record id of the current snapshot; `undefined` while nothing is loaded. */
  id: string | undefined;
  /**
   * `DocumentSnapshot.metadata.fromCache` of the LATEST emission. `undefined`
   * for non-Firestore sources (always authoritative), which therefore seed once
   * and are never "corrected".
   */
  fromCache: boolean | undefined;
  /** Whether the form holds unsaved edits — a dirty form is never overwritten. */
  isDirty: boolean;
  /**
   * Apply the snapshot. Called at most twice per record: once for the first
   * paint, once more when server truth arrives and the form is still pristine.
   * `serverTruth` says which, for callers that seed more than the form (the
   * pedido editor also re-seeds its concurrency baseline).
   */
  onSeed: (serverTruth: boolean) => void;
}

/**
 * Seed a form from a Firestore snapshot **without trusting the cache**.
 *
 * With the IndexedDB persistent cache, `onSnapshot` emits a `fromCache: true`
 * snapshot FIRST, and a transactional write has NO latency compensation — so
 * the cached copy can still hold a pre-write value while the server has the new
 * one. `packages/data/src/hooks/useSnapshot.ts` states the contract: consumers
 * that must seed from SERVER truth (an edit form) gate on `fromCache === false`.
 *
 * Blocking the paint until the server answers would cost every editor a round
 * trip on open, so this does what `ObjectView` has always done instead: paint
 * the first emission for instant feedback, then **re-seed once** when the
 * authoritative snapshot lands — but only while the form is pristine, so an
 * in-progress edit is never clobbered.
 *
 * A correction the pristine check defers is **owed, not forfeited**: it is paid
 * the moment the form goes pristine again. Dropping it instead is how an
 * operator ends up staring at pre-write values in every field they did not
 * touch — for the rest of that mount, since neither the record id nor
 * `fromCache` ever changes again to trigger a retry.
 *
 * ⚠️ Whatever a caller derives from the snapshot must be re-seeded HERE, in the
 * same callback, not in a second effect. A form corrected to server truth while
 * some sibling state still holds the cached copy is worse than either alone —
 * that mismatch is exactly how the pedido editor turned its own trigger's
 * write-back into a false "Pedido alterado" conflict (#972).
 *
 * Extracted from `ObjectView`, whose tests pin this behaviour.
 */
export function useServerTruthSeed({ id, fromCache, isDirty, onSeed }: ServerTruthSeedArgs): void {
  /** Last id painted from ANY source (cache or server). */
  const seededId = useRef<string | undefined>(undefined);
  /** Last id corrected from server truth — so the correction happens once. */
  const serverSeededId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (id === undefined) return;
    const serverTruth = fromCache === false;
    const firstPaint = seededId.current !== id;
    const correctCachePaint = serverTruth && serverSeededId.current !== id && !isDirty;
    if (!firstPaint && !correctCachePaint) return;
    onSeed(serverTruth);
    seededId.current = id;
    if (serverTruth) serverSeededId.current = id;
    // `isDirty` IS a dependency, and that is what makes the correction owed
    // rather than forfeited. Keyed on `[id, fromCache]` alone, a server
    // snapshot that landed while the form was dirty was skipped and could
    // never be retried — neither value changes again — so the operator kept
    // editing a form whose untouched fields still held the cached, pre-write
    // values, with nothing on screen saying so.
    //
    // Depending on it does NOT reintroduce the clobber: `correctCachePaint`
    // already requires `!isDirty`, so the extra runs while the user types
    // return early. What the dependency buys is the run on the dirty→pristine
    // transition, which pays a correction that was owed. And it cannot loop:
    // `onSeed` resets the form, which drives `isDirty` false and re-runs this
    // once more, by which point `serverSeededId.current === id` stops it.
    //
    // `onSeed` stays out on purpose — it is a fresh closure every render, and
    // depending on it would re-seed on any parent re-render.
  }, [id, fromCache, isDirty]);
}
