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
 * the monitor.
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
    return buildQuery(collection.ref(db, pathContext), [
      orderByField(field, 'desc'),
      limit(1),
    ]);
    // pathContext is identity-tracked like the rest of the data layer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (signature === null) return;
    if (baselineRef.current === null) {
      baselineRef.current = signature;
      return;
    }
    if (signature !== baselineRef.current) setStale(true);
  }, [signature]);

  function acknowledge() {
    baselineRef.current = signature;
    setStale(false);
  }

  return { stale, acknowledge };
}
