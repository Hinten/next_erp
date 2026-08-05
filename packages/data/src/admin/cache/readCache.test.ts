import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  READ_CACHE_DISABLED_ENV,
  READ_CACHE_TTL,
  ReadCacheConfigError,
  __resetAllReadCaches,
  createReadCache,
  readCacheStatsSnapshot,
} from './readCache';

/** Injected clock — TTL expiry must be provable without sleeping. */
function makeClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: (): number => current,
    advance: (ms: number): void => {
      current += ms;
    },
  };
}

/** A load that records every invocation, so "once per TTL window" is assertable. */
function countingLoad<V>(produce: () => V) {
  const calls: number[] = [];
  return {
    calls,
    load: async (): Promise<V> => {
      calls.push(calls.length + 1);
      return produce();
    },
  };
}

let clock: ReturnType<typeof makeClock>;

beforeEach(() => {
  clock = makeClock();
  // Suites share one process; without this a cache from the previous test serves
  // this one. Mandatory in `*.storage.test.ts` for the same reason.
  __resetAllReadCaches();
  vi.stubEnv(READ_CACHE_DISABLED_ENV, '');
});

afterEach(() => {
  __resetAllReadCaches();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('READ_CACHE_TTL', () => {
  it('pins the tiers — a silent edit to the policy table fails here', () => {
    expect(READ_CACHE_TTL).toEqual({ config: 900_000, volatile: 60_000, negative: 5_000 });
  });
});

describe('createReadCache — options', () => {
  it.each([
    ['ttlMs of 0', { name: 'bad', ttlMs: 0, maxEntries: 4 }],
    ['a non-finite ttlMs', { name: 'bad', ttlMs: Number.POSITIVE_INFINITY, maxEntries: 4 }],
    ['maxEntries of 0', { name: 'bad', ttlMs: 1_000, maxEntries: 0 }],
    ['a fractional maxEntries', { name: 'bad', ttlMs: 1_000, maxEntries: 1.5 }],
    ['a negative negativeTtlMs', { name: 'bad', ttlMs: 1_000, maxEntries: 4, negativeTtlMs: -1 }],
  ])('rejects %s', (_label, opts) => {
    expect(() => createReadCache<string, string>(opts)).toThrow(ReadCacheConfigError);
  });

  it('warns on a duplicate name — the tell for a per-request createReadCache', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    createReadCache<string, string>({ name: 'dup', ttlMs: 1_000, maxEntries: 4 });
    createReadCache<string, string>({ name: 'dup', ttlMs: 1_000, maxEntries: 4 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("duplicate cache name 'dup'");
  });
});

describe('createReadCache — TTL', () => {
  it('serves from cache until exactly ttlMs, then re-reads (boundary is exclusive)', async () => {
    const { calls, load } = countingLoad(() => 'v');
    const cache = createReadCache<string, string>({
      name: 'ttl',
      ttlMs: 60_000,
      maxEntries: 4,
      now: clock.now,
    });

    expect(await cache.get('k', load)).toBe('v');
    clock.advance(59_999);
    expect(await cache.get('k', load)).toBe('v');
    expect(calls).toHaveLength(1);

    clock.advance(1); // now exactly ttlMs after the write — expired
    expect(await cache.get('k', load)).toBe('v');
    expect(calls).toHaveLength(2);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 2 });
  });

  it('keys by the encoded key, so distinct keys do not share an entry', async () => {
    const { calls, load } = countingLoad(() => 'v');
    const cache = createReadCache<readonly [string, number], string>({
      name: 'keys',
      ttlMs: 60_000,
      maxEntries: 8,
      now: clock.now,
    });

    await cache.get(['a', 1], load);
    await cache.get(['a', 2], load);
    await cache.get(['a', 1], load);
    expect(calls).toHaveLength(2);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 2, size: 2 });
  });
});

describe('createReadCache — single flight', () => {
  it('runs load ONCE for N concurrent gets and hands all of them the same value', async () => {
    let calls = 0;
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const cache = createReadCache<string, string>({
      name: 'sf',
      ttlMs: 60_000,
      maxEntries: 4,
      now: clock.now,
    });

    const all = Promise.all([
      cache.get('k', () => {
        calls += 1;
        return pending;
      }),
      cache.get('k', () => {
        calls += 1;
        return pending;
      }),
      cache.get('k', () => {
        calls += 1;
        return pending;
      }),
    ]);

    expect(calls).toBe(1);
    expect(cache.stats()).toMatchObject({ hits: 2, misses: 1, inFlight: 1, size: 1 });

    release('v');
    await expect(all).resolves.toEqual(['v', 'v', 'v']);
    expect(cache.stats()).toMatchObject({ inFlight: 0 });
  });

  it('hands every caller the SAME object reference — the value must not be mutated', async () => {
    const cache = createReadCache<string, { n: number }>({
      name: 'shared',
      ttlMs: 60_000,
      maxEntries: 4,
      now: clock.now,
    });

    const first = await cache.get('k', async () => ({ n: 1 }));
    const second = await cache.get('k', async () => ({ n: 2 }));
    expect(second).toBe(first);
  });
});

describe('createReadCache — failures', () => {
  it('never caches a rejection: the next get re-reads', async () => {
    let calls = 0;
    const cache = createReadCache<string, string>({
      name: 'fail',
      ttlMs: 60_000,
      maxEntries: 4,
      now: clock.now,
    });
    const load = async (): Promise<string> => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return 'v';
    };

    await expect(cache.get('k', load)).rejects.toThrow('transient');
    expect(cache.stats()).toMatchObject({ failures: 1, size: 0 });

    expect(await cache.get('k', load)).toBe('v');
    expect(calls).toBe(2);
    expect(cache.stats()).toMatchObject({ failures: 1, size: 1 });
  });

  it('does not leave an unhandled rejection behind', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const cache = createReadCache<string, string>({
      name: 'unhandled',
      ttlMs: 60_000,
      maxEntries: 4,
      now: clock.now,
    });
    await expect(cache.get('k', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await new Promise((resolve) => setTimeout(resolve, 10));

    process.off('unhandledRejection', onUnhandled);
    expect(seen).toEqual([]);
  });

  it('a rejecting in-flight load does not delete a NEWER entry for the same key', async () => {
    let rejectFirst!: (err: Error) => void;
    const first = new Promise<string>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const cache = createReadCache<string, string>({
      name: 'race-reject',
      ttlMs: 60_000,
      maxEntries: 4,
      now: clock.now,
    });

    const inFlight = cache.get('k', () => first);
    cache.invalidate('k');
    const replacement = cache.get('k', async () => 'second');
    await expect(replacement).resolves.toBe('second');

    rejectFirst(new Error('late'));
    await expect(inFlight).rejects.toThrow('late');

    // The late rejection must not have evicted the replacement.
    const { calls, load } = countingLoad(() => 'third');
    expect(await cache.get('k', load)).toBe('second');
    expect(calls).toHaveLength(0);
  });

  it('an in-flight load that settles after invalidate does not repopulate the key', async () => {
    let releaseFirst!: (value: string) => void;
    const first = new Promise<string>((resolve) => {
      releaseFirst = resolve;
    });
    const cache = createReadCache<string, string>({
      name: 'race-resolve',
      ttlMs: 60_000,
      maxEntries: 4,
      now: clock.now,
    });

    const inFlight = cache.get('k', () => first);
    cache.invalidate('k');
    await expect(cache.get('k', async () => 'second')).resolves.toBe('second');

    releaseFirst('first');
    await expect(inFlight).resolves.toBe('first');
    expect(await cache.get('k', async () => 'third')).toBe('second');
  });
});

describe('createReadCache — negative caching', () => {
  it('bounds absence by negativeTtlMs, independently of ttlMs', async () => {
    let value: string | null = null;
    const { calls, load } = countingLoad<string | null>(() => value);
    const cache = createReadCache<string, string | null>({
      name: 'neg',
      ttlMs: 60_000,
      maxEntries: 4,
      negativeTtlMs: 5_000,
      now: clock.now,
    });

    expect(await cache.get('k', load)).toBeNull();
    clock.advance(4_999);
    expect(await cache.get('k', load)).toBeNull();
    expect(calls).toHaveLength(1);

    clock.advance(1); // exactly negativeTtlMs — the absence expires
    value = 'found';
    expect(await cache.get('k', load)).toBe('found');
    expect(calls).toHaveLength(2);

    // The positive entry now lives for the FULL ttlMs, not the negative window.
    clock.advance(5_001);
    expect(await cache.get('k', load)).toBe('found');
    expect(calls).toHaveLength(2);
  });

  it('defaults negativeTtlMs to min(negative tier, ttlMs)', async () => {
    const { calls, load } = countingLoad<string | null>(() => null);
    const cache = createReadCache<string, string | null>({
      name: 'neg-default',
      ttlMs: 1_000, // shorter than READ_CACHE_TTL.negative
      maxEntries: 4,
      now: clock.now,
    });

    await cache.get('k', load);
    clock.advance(999);
    await cache.get('k', load);
    expect(calls).toHaveLength(1);
    clock.advance(1);
    await cache.get('k', load);
    expect(calls).toHaveLength(2);
  });

  it('negativeTtlMs: 0 never caches absence — for a deterministic-ack read', async () => {
    const { calls, load } = countingLoad<string | null>(() => null);
    const cache = createReadCache<string, string | null>({
      name: 'neg-off',
      ttlMs: 60_000,
      maxEntries: 4,
      negativeTtlMs: 0,
      now: clock.now,
    });

    await cache.get('k', load);
    await cache.get('k', load);
    await cache.get('k', load);
    expect(calls).toHaveLength(3);
    expect(cache.stats()).toMatchObject({ size: 0 });
  });

  it('honours a custom isNegative — an empty query result counts as absent', async () => {
    let rows: readonly string[] = [];
    const { calls, load } = countingLoad<readonly string[]>(() => rows);
    const cache = createReadCache<string, readonly string[]>({
      name: 'neg-custom',
      ttlMs: 60_000,
      maxEntries: 4,
      negativeTtlMs: 1_000,
      isNegative: (value) => value.length === 0,
      now: clock.now,
    });

    expect(await cache.get('k', load)).toEqual([]);
    clock.advance(1_000);
    rows = ['a'];
    expect(await cache.get('k', load)).toEqual(['a']);
    expect(calls).toHaveLength(2);

    // Non-empty ⇒ positive ⇒ full ttlMs.
    clock.advance(1_001);
    expect(await cache.get('k', load)).toEqual(['a']);
    expect(calls).toHaveLength(2);
  });
});

describe('createReadCache — isFresh', () => {
  it('re-reads when a hit fails the freshness check, and hits once it passes', async () => {
    let userId: number | null = null;
    const { calls, load } = countingLoad<{ user_id: number | null }>(() => ({ user_id: userId }));
    const cache = createReadCache<string, { user_id: number | null }>({
      name: 'fresh',
      ttlMs: 900_000,
      maxEntries: 4,
      isFresh: (conta) => conta.user_id != null,
      now: clock.now,
    });

    expect(await cache.get('k', load)).toEqual({ user_id: null });
    // Cached, unexpired — but refused, so this is a miss and a re-read.
    expect(await cache.get('k', load)).toEqual({ user_id: null });
    expect(calls).toHaveLength(2);
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 2 });

    userId = 7;
    expect(await cache.get('k', load)).toEqual({ user_id: 7 });
    expect(calls).toHaveLength(3);

    // Now it passes — a real hit, and the entry keeps its original expiry.
    expect(await cache.get('k', load)).toEqual({ user_id: 7 });
    expect(calls).toHaveLength(3);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 3 });
  });
});

describe('createReadCache — bounded size', () => {
  it('evicts the least recently USED key, not the oldest inserted', async () => {
    const loaded: string[] = [];
    const load = (key: string) => async (): Promise<string> => {
      loaded.push(key);
      return key;
    };
    const cache = createReadCache<string, string>({
      name: 'lru',
      ttlMs: 60_000,
      maxEntries: 2,
      now: clock.now,
    });

    await cache.get('a', load('a'));
    await cache.get('b', load('b'));
    await cache.get('a', load('a')); // touch 'a' ⇒ 'b' is now least recently used
    await cache.get('c', load('c')); // over the cap ⇒ evicts 'b'

    expect(cache.stats()).toMatchObject({ evictions: 1, size: 2 });

    await cache.get('a', load('a')); // survived
    await cache.get('b', load('b')); // was evicted ⇒ reloads
    expect(loaded).toEqual(['a', 'b', 'c', 'b']);
  });
});

describe('createReadCache — invalidate / clear / stats', () => {
  it('invalidate drops one key and leaves the rest', async () => {
    const { calls, load } = countingLoad(() => 'v');
    const cache = createReadCache<string, string>({
      name: 'inv',
      ttlMs: 60_000,
      maxEntries: 4,
      now: clock.now,
    });

    await cache.get('a', load);
    await cache.get('b', load);
    cache.invalidate('a');

    await cache.get('a', load); // reloads
    await cache.get('b', load); // still cached
    expect(calls).toHaveLength(3);
  });

  it('clear drops every entry but keeps the cumulative counters', async () => {
    const { load } = countingLoad(() => 'v');
    const cache = createReadCache<string, string>({
      name: 'clr',
      ttlMs: 60_000,
      maxEntries: 4,
      now: clock.now,
    });

    await cache.get('k', load);
    await cache.get('k', load);
    cache.clear();

    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, size: 0 });
  });

  it('emits one stats line every sampleEvery gets', async () => {
    const log = vi.fn();
    const cache = createReadCache<string, string>({
      name: 'logged',
      ttlMs: 60_000,
      maxEntries: 4,
      sampleEvery: 2,
      log,
      now: clock.now,
    });

    await cache.get('k', async () => 'v');
    expect(log).not.toHaveBeenCalled();

    await cache.get('k', async () => 'v');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toBe(
      '[read-cache] logged: 1 hits, 1 misses, 0 evictions, 0 failures, size 1',
    );
    expect(log.mock.calls[0]?.[1]).toMatchObject({ name: 'logged', hits: 1, misses: 1 });
  });
});

describe('createReadCache — kill switch', () => {
  it(`${READ_CACHE_DISABLED_ENV}=1 turns every get into a passthrough`, async () => {
    vi.stubEnv(READ_CACHE_DISABLED_ENV, '1');
    const { calls, load } = countingLoad(() => 'v');
    const cache = createReadCache<string, string>({
      name: 'killed',
      ttlMs: 60_000,
      maxEntries: 4,
      now: clock.now,
    });

    expect(await cache.get('k', load)).toBe('v');
    expect(await cache.get('k', load)).toBe('v');
    expect(calls).toHaveLength(2);
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 0, size: 0 });
  });

  it('any other value leaves the cache on', async () => {
    vi.stubEnv(READ_CACHE_DISABLED_ENV, 'true');
    const { calls, load } = countingLoad(() => 'v');
    const cache = createReadCache<string, string>({
      name: 'not-killed',
      ttlMs: 60_000,
      maxEntries: 4,
      now: clock.now,
    });

    await cache.get('k', load);
    await cache.get('k', load);
    expect(calls).toHaveLength(1);
  });
});

describe('the registry', () => {
  it('snapshots every registered cache and resets them all', async () => {
    const a = createReadCache<string, string>({ name: 'reg-a', ttlMs: 60_000, maxEntries: 4 });
    const b = createReadCache<string, string>({ name: 'reg-b', ttlMs: 60_000, maxEntries: 4 });
    await a.get('k', async () => 'v');
    await b.get('k', async () => 'v');

    expect(readCacheStatsSnapshot().map((s) => s.name)).toEqual(['reg-a', 'reg-b']);

    __resetAllReadCaches();

    expect(readCacheStatsSnapshot()).toEqual([]);
    expect(a.stats()).toMatchObject({ hits: 0, misses: 0, failures: 0, size: 0 });
    expect(b.stats()).toMatchObject({ size: 0 });
  });

  it('a module-scope cache re-registers itself on its next get after a reset', async () => {
    const cache = createReadCache<string, string>({
      name: 'rereg',
      ttlMs: 60_000,
      maxEntries: 4,
    });
    __resetAllReadCaches();
    expect(readCacheStatsSnapshot()).toEqual([]);

    await cache.get('k', async () => 'v');
    expect(readCacheStatsSnapshot().map((s) => s.name)).toEqual(['rereg']);
  });
});
