import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMemoryReportCacheStorage,
  createReportCache,
  MAX_REPORT_CACHE_ENTRIES,
  reportCacheKey,
  REPORT_CACHE_TTL_MS,
  type ReportCacheScope,
  type ReportCacheStorage,
} from './reportCache';

interface Report {
  total: number;
  photoUrl: string | null;
}
const validate = (raw: unknown): raw is Report => {
  if (raw === null || typeof raw !== 'object') return false;
  const value = raw as Record<string, unknown>;
  return (
    typeof value.total === 'number' &&
    (typeof value.photoUrl === 'string' || value.photoUrl === null)
  );
};
const scope: ReportCacheScope = {
  version: 'best-sellers:1',
  project: 'project-a',
  database: 'default',
  transport: 'staging',
  userId: 'operator-a',
  permissions: '31',
};
const data: Report = { total: 5, photoUrl: 'https://example.test/product.jpg' };
const BASE = 1_800_000_000_000;

interface EnrichedReport {
  total: number;
  details: string[];
}

function validateEnriched(raw: unknown): raw is EnrichedReport {
  if (raw === null || typeof raw !== 'object') return false;
  const value = raw as Record<string, unknown>;
  return (
    typeof value.total === 'number' &&
    Array.isArray(value.details) &&
    value.details.every((detail: unknown) => typeof detail === 'string')
  );
}

function mergeEnriched(previous: unknown, incoming: unknown): unknown {
  if (!validateEnriched(previous) || !validateEnriched(incoming)) return incoming;
  return { ...incoming, details: [...new Set([...previous.details, ...incoming.details])].sort() };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function failingStorage(error: unknown): ReportCacheStorage {
  return {
    get: async () => {
      throw error;
    },
    putIfNewer: async () => {
      throw error;
    },
    delete: async () => {
      throw error;
    },
  };
}

describe('reportCacheKey', () => {
  it('folds object insertion order while keeping meaningful filter values distinct', () => {
    const key = reportCacheKey(scope, { start: 1, nested: { end: 2, channels: ['a', 'b'] } });
    expect(key).toBe(reportCacheKey(scope, { nested: { channels: ['a', 'b'], end: 2 }, start: 1 }));
    expect(key).not.toBe(
      reportCacheKey(scope, { start: 2, nested: { end: 2, channels: ['a', 'b'] } }),
    );
    // Array order is not universally a set; the report normalizes its set selections first.
    expect(key).not.toBe(
      reportCacheKey(scope, { start: 1, nested: { end: 2, channels: ['b', 'a'] } }),
    );
  });

  it('isolates identities, permission changes, databases, transports and report versions', () => {
    const key = reportCacheKey(scope, {});
    for (const field of Object.keys(scope) as (keyof ReportCacheScope)[]) {
      expect(reportCacheKey({ ...scope, [field]: scope[field] + '-different' }, {})).not.toBe(key);
    }
  });

  it('does not fold nonfinite numeric filters into null', () => {
    expect(() => reportCacheKey(scope, { limit: Number.NaN })).toThrow(RangeError);
    expect(() => reportCacheKey(scope, { nested: { limit: Infinity } })).toThrow(RangeError);
  });
});

describe('report snapshots', () => {
  it('persists complete snapshots across instances with fixed six-hour expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const storage = createMemoryReportCacheStorage();
    await createReportCache({ storage }).put('report', {
      data,
      generatedAt: BASE,
      requestStartedAt: BASE - 50,
    });
    const reloaded = createReportCache({ storage });
    vi.setSystemTime(BASE + REPORT_CACHE_TTL_MS - 1);
    expect(await reloaded.get('report', validate)).toEqual({
      data,
      generatedAt: BASE,
      requestStartedAt: BASE - 50,
    });
    vi.setSystemTime(BASE + REPORT_CACHE_TTL_MS);
    expect(await reloaded.get('report', validate)).toBeNull();
    expect(storage.map.has('report')).toBe(false);
  });

  it('never exposes a snapshot belonging to another scope or filter key', async () => {
    const storage = createMemoryReportCacheStorage();
    const cache = createReportCache({ storage, now: () => BASE });
    const key = reportCacheKey(scope, { ehSaida: true });
    await cache.put(key, { data, generatedAt: BASE, requestStartedAt: BASE });
    expect(
      await cache.get(
        reportCacheKey({ ...scope, userId: 'operator-b' }, { ehSaida: true }),
        validate,
      ),
    ).toBeNull();
    expect(await cache.get(reportCacheKey(scope, { ehSaida: false }), validate)).toBeNull();
  });

  it('retains successful empty reports and returns detached payloads', async () => {
    const storage = createMemoryReportCacheStorage();
    const cache = createReportCache({ storage, now: () => BASE });
    await cache.put('empty', {
      data: { total: 0, photoUrl: null },
      generatedAt: BASE,
      requestStartedAt: BASE,
    });
    const first = await cache.get('empty', validate);
    expect(first?.data.total).toBe(0);
    if (first) first.data.total = 9;
    expect((await cache.get('empty', validate))?.data.total).toBe(0);
  });

  it('deletes invalid envelopes and payloads', async () => {
    const storage = createMemoryReportCacheStorage();
    const cache = createReportCache({ storage, now: () => BASE });
    const good = { schemaVersion: 1, data, generatedAt: BASE, requestStartedAt: BASE - 1 };
    const invalid: unknown[] = [
      null,
      'json',
      {},
      { ...good, schemaVersion: 99 },
      { ...good, generatedAt: NaN },
      { ...good, generatedAt: BASE + 1 },
      { ...good, requestStartedAt: BASE + 1 },
      { ...good, data: { total: '5' } },
    ];
    for (const raw of invalid) {
      storage.map.set('bad', raw);
      expect(await cache.get('bad', validate)).toBeNull();
      expect(storage.map.has('bad')).toBe(false);
    }
  });

  it('rejects old requests and accepts same-request enrichment', async () => {
    const storage = createMemoryReportCacheStorage();
    const cache = createReportCache({ storage, now: () => BASE + 100 });
    await cache.put('report', { data, generatedAt: BASE + 50, requestStartedAt: BASE + 10 });
    await cache.put('report', {
      data: { total: 999, photoUrl: null },
      generatedAt: BASE + 90,
      requestStartedAt: BASE,
    });
    expect((await cache.get('report', validate))?.data).toEqual(data);
    const enriched = { total: 5, photoUrl: 'https://example.test/enriched.jpg' };
    await cache.put('report', {
      data: enriched,
      generatedAt: BASE + 50,
      requestStartedAt: BASE + 10,
    });
    expect((await cache.get('report', validate))?.data).toEqual(enriched);
  });

  it('unions concurrent same-snapshot writes from separate session caches without extending expiry', async () => {
    const storage = createMemoryReportCacheStorage();
    let now = BASE;
    const makeCache = () => createReportCache({ storage, now: () => now });
    const first = makeCache();
    const second = makeCache();
    const entry = (details: string[]) => ({
      data: { total: 5, details },
      generatedAt: BASE,
      requestStartedAt: BASE - 10,
    });
    await first.put('report', entry([]), mergeEnriched);
    await second.get('report', validateEnriched, mergeEnriched);
    now += 60_000;
    await Promise.all([
      first.put('report', entry(['a']), mergeEnriched),
      second.put('report', entry(['b']), mergeEnriched),
    ]);
    expect(await first.get('report', validateEnriched, mergeEnriched)).toEqual(entry(['a', 'b']));
    await first.put('report', entry(['c']), mergeEnriched);
    expect(await makeCache().get('report', validateEnriched, mergeEnriched)).toEqual(
      entry(['a', 'b', 'c']),
    );
    now = BASE + REPORT_CACHE_TTL_MS - 1;
    expect(await makeCache().get('report', validateEnriched, mergeEnriched)).toEqual(
      entry(['a', 'b', 'c']),
    );
    now++;
    expect(await first.get('report', validateEnriched, mergeEnriched)).toBeNull();
    expect(await makeCache().get('report', validateEnriched, mergeEnriched)).toBeNull();
  });

  it.each([
    {
      name: 'request start differs',
      older: { generatedAt: BASE, requestStartedAt: BASE - 20 },
      newer: { generatedAt: BASE, requestStartedAt: BASE - 10 },
    },
    {
      name: 'generation time differs',
      older: { generatedAt: BASE - 1, requestStartedAt: BASE - 10 },
      newer: { generatedAt: BASE, requestStartedAt: BASE - 10 },
    },
    {
      name: 'older request finishes later',
      older: { generatedAt: BASE + 1, requestStartedAt: BASE - 20 },
      newer: { generatedAt: BASE, requestStartedAt: BASE - 10 },
    },
  ])('keeps the newer snapshot without merging when $name', async ({ older, newer }) => {
    const storage = createMemoryReportCacheStorage();
    const makeCache = () => createReportCache({ storage, now: () => BASE + 1 });
    const merge = vi.fn(mergeEnriched);
    const winner = { ...newer, data: { total: 5, details: ['new'] } };
    await makeCache().put('report', winner, merge);
    merge.mockClear();
    await makeCache().put('report', { ...older, data: { total: 1, details: ['old'] } }, merge);
    expect(await makeCache().get('report', validateEnriched, merge)).toEqual(winner);
    expect(merge).not.toHaveBeenCalled();
  });

  it('merges quota-only session details with persisted details and preserves them on the next write', async () => {
    const primary = createMemoryReportCacheStorage();
    const entry = (details: string[]) => ({
      data: { total: 5, details },
      generatedAt: BASE,
      requestStartedAt: BASE - 10,
    });
    const other = createReportCache({ storage: primary, now: () => BASE });
    await other.put('report', entry([]), mergeEnriched);
    let quotaFailure = true;
    const first = createReportCache({
      storage: {
        ...primary,
        putIfNewer: async (...args) => {
          if (quotaFailure) throw new DOMException('Quota exceeded', 'QuotaExceededError');
          return primary.putIfNewer(...args);
        },
      },
      now: () => BASE,
    });
    await first.get('report', validateEnriched, mergeEnriched);
    await first.put('report', entry(['local']), mergeEnriched);
    await other.put('report', entry(['remote']), mergeEnriched);
    expect(await first.get('report', validateEnriched, mergeEnriched)).toEqual(
      entry(['local', 'remote']),
    );
    quotaFailure = false;
    await first.put('report', entry(['next']), mergeEnriched);
    const reloaded = createReportCache({ storage: primary, now: () => BASE });
    expect(await reloaded.get('report', validateEnriched, mergeEnriched)).toEqual(
      entry(['local', 'next', 'remote']),
    );
  });

  it('removes expired entries and prunes oldest snapshots at the shared cap', async () => {
    const storage = createMemoryReportCacheStorage();
    let now = BASE;
    const cache = createReportCache({ storage, now: () => now });
    await cache.put('expired', { data, generatedAt: BASE, requestStartedAt: BASE });
    now += REPORT_CACHE_TTL_MS;
    for (let index = 0; index < MAX_REPORT_CACHE_ENTRIES + 2; index++) {
      now++;
      await cache.put('report-' + index, { data, generatedAt: now, requestStartedAt: now });
    }
    expect(storage.map.size).toBe(MAX_REPORT_CACHE_ENTRIES);
    expect(storage.map.has('expired')).toBe(false);
    expect(storage.map.has('report-0')).toBe(false);
    expect(storage.map.has('report-1')).toBe(false);
    expect((await cache.get('report-' + (MAX_REPORT_CACHE_ENTRIES + 1), validate))?.data).toEqual(
      data,
    );
  });

  it('rejects invalid timestamps and expired writes', async () => {
    const storage = createMemoryReportCacheStorage();
    const cache = createReportCache({ storage, now: () => BASE });
    await cache.put('report', { data, generatedAt: BASE, requestStartedAt: BASE });
    await cache.put('report', {
      data: { total: 9, photoUrl: null },
      generatedAt: BASE - REPORT_CACHE_TTL_MS,
      requestStartedAt: 0,
    });
    expect((await cache.get('report', validate))?.data).toEqual(data);
    await expect(
      cache.put('report', { data, generatedAt: BASE + 1, requestStartedAt: BASE }),
    ).rejects.toThrow(RangeError);
    await expect(
      cache.put('report', { data, generatedAt: BASE, requestStartedAt: NaN }),
    ).rejects.toThrow(RangeError);
  });

  it('falls back to session memory on browser storage failures', async () => {
    let now = BASE;
    const cache = createReportCache({
      storage: failingStorage(new DOMException('Quota exceeded', 'QuotaExceededError')),
      now: () => now,
    });
    await cache.put('report', { data, generatedAt: BASE, requestStartedAt: BASE });
    expect((await cache.get('report', validate))?.data).toEqual(data);
    await cache.delete('report');
    expect(await cache.get('report', validate)).toBeNull();
    await cache.put('report', { data, generatedAt: BASE, requestStartedAt: BASE });
    now += REPORT_CACHE_TTL_MS;
    expect(await cache.get('report', validate)).toBeNull();
  });

  it('keeps session results when a failed quota write is followed by a readable miss', async () => {
    const persistent = createMemoryReportCacheStorage();
    const cache = createReportCache({
      storage: {
        ...persistent,
        putIfNewer: async () => {
          throw new DOMException('Quota exceeded', 'QuotaExceededError');
        },
      },
      now: () => BASE,
    });
    await cache.put('report', { data, generatedAt: BASE, requestStartedAt: BASE });
    expect(persistent.map.has('report')).toBe(false);
    expect((await cache.get('report', validate))?.data).toEqual(data);
  });

  it('prefers session updates over older readable persistent snapshots', async () => {
    const persistent = createMemoryReportCacheStorage();
    await persistent.putIfNewer(
      'report',
      {
        schemaVersion: 1,
        data: { total: 1, photoUrl: null },
        generatedAt: BASE - 10,
        requestStartedAt: BASE - 20,
      },
      BASE,
    );
    const cache = createReportCache({
      storage: {
        ...persistent,
        putIfNewer: async () => {
          throw new DOMException('Quota exceeded', 'QuotaExceededError');
        },
      },
      now: () => BASE,
    });
    await cache.put('report', { data, generatedAt: BASE, requestStartedAt: BASE });
    expect((await cache.get('report', validate))?.data).toEqual(data);
    persistent.map.set('report', {
      schemaVersion: 1,
      data,
      generatedAt: BASE,
      requestStartedAt: BASE,
    });
    const enriched = { total: 5, photoUrl: 'https://example.test/enriched.jpg' };
    await cache.put('report', { data: enriched, generatedAt: BASE, requestStartedAt: BASE });
    expect((await cache.get('report', validate))?.data).toEqual(enriched);
  });

  it('shares the default fallback across factories without IndexedDB', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const first = createReportCache({ now: () => BASE });
    const second = createReportCache({ now: () => BASE });
    const key = reportCacheKey(scope, { sessionFallback: true });
    await first.put(key, { data, generatedAt: BASE, requestStartedAt: BASE });
    expect((await second.get(key, validate))?.data).toEqual(data);
    await first.delete(key);
    expect(await second.get(key, validate)).toBeNull();
  });

  it('falls back when a database upgrade is blocked and closes a late connection', async () => {
    const close = vi.fn();
    const request: {
      onblocked?: () => void;
      onsuccess?: () => void;
      result: { close: () => void };
    } = { result: { close } };
    vi.stubGlobal('indexedDB', {
      open: () => {
        queueMicrotask(() => request.onblocked?.());
        return request;
      },
    });
    const cache = createReportCache({ now: () => BASE });
    expect(await cache.get('blocked-upgrade', validate)).toBeNull();
    request.onsuccess?.();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not swallow programming failures as an unavailable cache', async () => {
    const error = new TypeError('Unexpected store bug');
    const cache = createReportCache({ storage: failingStorage(error), now: () => BASE });
    await expect(cache.get('report', validate)).rejects.toBe(error);
    await expect(
      cache.put('report', { data, generatedAt: BASE, requestStartedAt: BASE }),
    ).rejects.toBe(error);
    await expect(cache.delete('report')).rejects.toBe(error);
  });
});
