import { describe, expect, it } from 'vitest';
import { MAX_RECENTS, RECENT_TTL_MS, type RecentEntry, mergeRecent } from './useRecentSelections';

const NOW = 1_700_000_000_000;
const entry = (id: string, at: number = NOW): RecentEntry => ({
  id,
  label: `label-${id}`,
  at,
});

describe('mergeRecent', () => {
  it('prepends the new entry, freshest-first', () => {
    const out = mergeRecent([entry('a')], entry('b'), NOW);
    expect(out.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('dedupes by id, keeping the new entry on top', () => {
    const out = mergeRecent([entry('a', NOW - 100), entry('b', NOW - 200)], entry('a'), NOW);
    expect(out.map((e) => e.id)).toEqual(['a', 'b']);
    expect(out).toHaveLength(2);
  });

  it('caps the list at MAX_RECENTS entries', () => {
    const list = ['a', 'b', 'c', 'd', 'e'].map((id) => entry(id));
    const out = mergeRecent(list, entry('f'), NOW);
    expect(out).toHaveLength(MAX_RECENTS);
    expect(out.map((e) => e.id)).toEqual(['f', 'a', 'b', 'c', 'd']);
  });

  it('drops entries older than 24h', () => {
    const fresh = entry('fresh', NOW - 1_000);
    const stale = entry('stale', NOW - RECENT_TTL_MS - 1);
    const out = mergeRecent([fresh, stale], entry('new'), NOW);
    expect(out.map((e) => e.id)).toEqual(['new', 'fresh']);
  });

  it('drops a freshly-added entry that is already past its TTL', () => {
    const out = mergeRecent([], entry('old', NOW - RECENT_TTL_MS - 1), NOW);
    expect(out).toEqual([]);
  });
});
