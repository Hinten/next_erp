'use client';

import { useCallback, useEffect } from 'react';
import { useLocalStorage } from '@mantine/hooks';

export interface RecentEntry {
  id: string;
  label: string;
  /** `Date.now()` captured at selection time. */
  at: number;
}

/** Recent entries expire 24h after they were selected. */
export const RECENT_TTL_MS = 24 * 60 * 60 * 1000;
/** Keep at most this many recent entries. */
export const MAX_RECENTS = 5;

/**
 * Merge a freshly-picked entry into a recents list: drop any prior entry with
 * the same id, prepend the new one, discard entries older than 24h, and cap
 * the result to the 5 most recent. Pure — `now` is injected so the expiry
 * logic is deterministically unit-testable.
 */
export function mergeRecent(list: RecentEntry[], entry: RecentEntry, now: number): RecentEntry[] {
  return [entry, ...list.filter((e) => e.id !== entry.id)]
    .filter((e) => now - e.at < RECENT_TTL_MS)
    .slice(0, MAX_RECENTS);
}

/**
 * localStorage-backed "recent selections" memory for one `CollectionSelect`
 * instance. `cacheKey` must be unique per instance so sibling selectors (e.g.
 * the two `listaDePrecos` fields) keep separate history. Entries expire 24h
 * after selection — pruned on write by `record` and on mount by the effect
 * below (which catches entries that went stale while sitting in storage).
 */
export function useRecentSelections(cacheKey: string): {
  recents: RecentEntry[];
  record: (id: string, label: string) => void;
} {
  const [raw, setRaw] = useLocalStorage<RecentEntry[]>({
    key: cacheKey,
    defaultValue: [],
  });

  // Drop entries that expired while the page was closed. Settles in one extra
  // render and can't loop: `setRaw` fires only when the length actually shrank.
  useEffect(() => {
    setRaw((prev) => {
      const now = Date.now();
      const fresh = prev.filter((e) => now - e.at < RECENT_TTL_MS);
      return fresh.length === prev.length ? prev : fresh;
    });
  }, [raw, setRaw]);

  const record = useCallback(
    (id: string, label: string) => {
      const now = Date.now();
      setRaw((prev) => mergeRecent(prev, { id, label, at: now }, now));
    },
    [setRaw],
  );

  return { recents: raw, record };
}
