import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { READ_CACHE_DISABLED_ENV, __resetAllReadCaches, createReadCache } from './readCache';
import { readCacheDelta, readCacheMark, readCacheSummary } from './cacheReport';

function cache(name: string) {
  return createReadCache<string, string>({ name, ttlMs: 60_000, maxEntries: 8, sampleEvery: 0 });
}

beforeEach(() => {
  __resetAllReadCaches();
  vi.stubEnv(READ_CACHE_DISABLED_ENV, '');
});

afterEach(() => {
  __resetAllReadCaches();
  vi.unstubAllEnvs();
});

describe('readCacheSummary', () => {
  it('is null before any cache registers — a cold instance reports nothing', () => {
    expect(readCacheSummary()).toBeNull();
  });

  it('reports cumulative hits/misses as structured counters', async () => {
    const c = cache('x:one');
    await c.get('k', async () => 'v'); // miss
    await c.get('k', async () => 'v'); // hit
    await c.get('k', async () => 'v'); // hit

    expect(readCacheSummary()).toEqual({ 'x:one': { hits: 2, misses: 1 } });
  });

  it('reports every registered cache', async () => {
    const a = cache('x:a');
    const b = cache('x:b');
    await a.get('k', async () => 'v');
    await b.get('k', async () => 'v');

    expect(readCacheSummary()).toEqual({
      'x:a': { hits: 0, misses: 1 },
      'x:b': { hits: 0, misses: 1 },
    });
  });

  it('reports all-zeroes under the kill switch — NOT null', async () => {
    vi.stubEnv(READ_CACHE_DISABLED_ENV, '1');
    const c = cache('x:off');
    await c.get('k', async () => 'v');
    await c.get('k', async () => 'v');

    // A cache registers at CONSTRUCTION, so it is present in the report even
    // though the passthrough never touches a counter. All-zeroes is the switch's
    // signature, not an absent field — the A/B in the PR body depends on this.
    expect(readCacheSummary()).toEqual({ 'x:off': { hits: 0, misses: 0 } });
  });
});

describe('readCacheDelta', () => {
  it('reports only what accrued since the mark — not the process total', async () => {
    const c = cache('x:tick');
    await c.get('k', async () => 'v'); // miss, BEFORE the mark
    await c.get('k', async () => 'v'); // hit, before the mark

    const mark = readCacheMark();
    await c.get('k', async () => 'v'); // hit, inside the tick

    expect(readCacheDelta(mark)).toEqual({ 'x:tick': { hits: 1, misses: 0 } });
    // …while the cumulative view still sees everything.
    expect(readCacheSummary()).toEqual({ 'x:tick': { hits: 2, misses: 1 } });
  });

  it('counts a cache that first registered inside the tick in full', async () => {
    const mark = readCacheMark();
    const c = cache('x:late');
    await c.get('k', async () => 'v');

    expect(readCacheDelta(mark)).toEqual({ 'x:late': { hits: 0, misses: 1 } });
  });

  it('reports an idle tick as zeroes rather than dropping the cache', async () => {
    const c = cache('x:idle');
    await c.get('k', async () => 'v');

    expect(readCacheDelta(readCacheMark())).toEqual({ 'x:idle': { hits: 0, misses: 0 } });
  });
});
