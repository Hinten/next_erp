'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Firestore } from 'firebase/firestore';
import type { z, ZodObject, ZodRawShape } from 'zod';
import {
  type CollectionHandle,
  type PathContext,
  buildQuery,
  limit,
  orderByField,
} from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';

export interface CollectionMonitorResult {
  /** True when the collection changed since the captured baseline. */
  stale: boolean;
  /** Re-baseline against the current latest doc and clear `stale`. */
  acknowledge: () => void;
}

/**
 * Lightweight staleness detector for TableView. Subscribes to a realtime
 * `limit(1)` query ordered by `field` descending and flags `stale` whenever
 * the top document's identity or `field` value changes from the captured
 * baseline — a new doc changes the id, an edit that bumps `field` changes
 * the value, deleting the top doc changes the id. `field === null` disables
 * the monitor — no query is built, `useSnapshot` never subscribes, and the
 * baseline is forgotten so a later re-enable pins afresh.
 *
 * ⚠️ TableView enables this ONLY on the frozen (Pipelines) transport. A list
 * whose rows stream has nothing to detect: every change is already on screen,
 * so the notice would fire over data it had just applied. What that gate does
 * NOT change is which collections owe the index — any list drops to the frozen
 * transport on a filter, a search or a header sort, so the query is reachable
 * on every collection that declares a `defaultQuery` and carries one of these
 * fields, and `defaultQuery.indexes.test.ts` still requires all of them.
 *
 * Known limitation: deleting a document that is NOT the current top one is
 * invisible here — a hard delete leaves no queryable trace and a `limit(1)`
 * query only ever sees the most-recent doc. Deletes performed in the same
 * tab are handled separately (the TableView re-runs its query after a
 * `refreshOnComplete` action); cross-session deletes are not detected.
 * Tracked in issue #40.
 */
export function useCollectionMonitor<S extends ZodObject<ZodRawShape>>(opts: {
  db: Firestore;
  collection: CollectionHandle<S>;
  pathContext?: PathContext;
  field: string | null;
}): CollectionMonitorResult {
  const { db, collection, pathContext = {}, field } = opts;

  const query = useMemo(() => {
    if (!field) return null;
    return buildQuery(collection.ref(db, pathContext), [orderByField(field, 'desc'), limit(1)]);
    // pathContext is identity-tracked like the rest of the data layer.
  }, [db, collection, field]);

  const snap = useSnapshot<z.infer<S>>(query);

  // `null` until the first result arrives; `'∅'` for an empty collection.
  const signature = useMemo<string | null>(() => {
    if (!query || !field || !snap.data) return null;
    const top = snap.data[0];
    if (!top) return '∅';
    return `${top.id}:${String((top.data as Record<string, unknown>)[field])}`;
  }, [query, field, snap.data]);

  const baselineRef = useRef<string | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    // ⚠️ Switched off — forget everything. The baseline and `stale` are pinned
    // to a result set nobody is looking at any more, and TableView disables the
    // monitor exactly when its list goes back to STREAMING. Keeping them would
    // make re-entry lie: on the next filter the rows re-execute and are fresh,
    // but a surviving non-null baseline skips the server-truth wait below,
    // compares against the previous static session and raises `stale` over rows
    // fetched a millisecond ago.
    if (!query) {
      baselineRef.current = null;
      setStale(false);
      return;
    }
    if (signature === null) return;
    // Wait for SERVER truth before pinning the baseline. The IndexedDB cache
    // emits first, so pinning that emission made the cache→server correction
    // itself look like "someone added a record" and raised the banner on a
    // table nobody had touched.
    if (baselineRef.current === null) {
      if (snap.fromCache !== false) return;
      baselineRef.current = signature;
      return;
    }
    if (signature !== baselineRef.current) setStale(true);
  }, [query, signature, snap.fromCache]);

  function acknowledge() {
    baselineRef.current = signature;
    setStale(false);
  }

  return { stale, acknowledge };
}
