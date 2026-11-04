/** Browser report snapshots: six-hour absolute expiry, isolated by caller and query. */
export const REPORT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_REPORT_CACHE_ENTRIES = 50;
export const REPORT_CACHE_DB = 'delfrance-report-cache';
export const REPORT_CACHE_STORE = 'reports';
const CACHE_SCHEMA_VERSION = 1;

export interface ReportCacheScope {
  version: string;
  project: string;
  database: string;
  transport: string;
  userId: string;
  permissions: string;
}

export type ReportCacheKeyValue =
  | string
  | number
  | boolean
  | null
  | readonly ReportCacheKeyValue[]
  | { readonly [key: string]: ReportCacheKeyValue };

function canonicalValue(value: ReportCacheKeyValue): ReportCacheKeyValue {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError('Report cache keys require finite numbers.');
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

/** Object order is irrelevant; callers sort/deduplicate arrays that represent filter sets. */
export function reportCacheKey(
  scope: ReportCacheScope,
  filters: Readonly<Record<string, ReportCacheKeyValue>>,
): string {
  return JSON.stringify(canonicalValue({ scope: { ...scope }, filters }));
}

export interface CachedReport<T> {
  data: T;
  generatedAt: number;
  /** Earlier requests must never overwrite a newer request's snapshot or decorations. */
  requestStartedAt: number;
}

export interface StoredReportCacheEntry extends CachedReport<unknown> {
  schemaVersion: number;
}

/** Pure, synchronous payload merge; callers validate unknown data at this boundary. */
export type ReportCacheMerge = (previous: unknown, incoming: unknown) => unknown;

export interface ReportCacheStorage {
  /** Validation and removal happen atomically, so cleanup cannot delete a concurrent refresh. */
  get<T>(key: string, accept: (raw: unknown) => raw is T): Promise<T | null>;
  putIfNewer(
    key: string,
    entry: StoredReportCacheEntry,
    now: number,
    /** Invoked atomically, only when both snapshot timestamps match. */
    merge?: ReportCacheMerge,
  ): Promise<StoredReportCacheEntry>;
  delete(key: string): Promise<void>;
}

export interface ReportCache {
  get<T>(
    key: string,
    validate: (raw: unknown) => raw is T,
    merge?: ReportCacheMerge,
  ): Promise<CachedReport<T> | null>;
  put<T>(key: string, entry: CachedReport<T>, merge?: ReportCacheMerge): Promise<void>;
  delete(key: string): Promise<void>;
}

function isStoredEntry(raw: unknown): raw is StoredReportCacheEntry {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  return (
    value.schemaVersion === CACHE_SCHEMA_VERSION &&
    Object.hasOwn(value, 'data') &&
    typeof value.generatedAt === 'number' &&
    Number.isSafeInteger(value.generatedAt) &&
    value.generatedAt >= 0 &&
    typeof value.requestStartedAt === 'number' &&
    Number.isSafeInteger(value.requestStartedAt) &&
    value.requestStartedAt >= 0 &&
    value.requestStartedAt <= value.generatedAt
  );
}

function isFresh(entry: StoredReportCacheEntry, now: number): boolean {
  return entry.generatedAt <= now && now - entry.generatedAt < REPORT_CACHE_TTL_MS;
}

/** Snapshot order and enrichment are separate: a merge never advances freshness. */
function winningEntry(
  previous: unknown,
  incoming: StoredReportCacheEntry,
  now: number,
  merge?: ReportCacheMerge,
): StoredReportCacheEntry {
  if (!isStoredEntry(previous) || !isFresh(previous, now)) return incoming;
  if (
    previous.requestStartedAt > incoming.requestStartedAt ||
    (previous.requestStartedAt === incoming.requestStartedAt &&
      previous.generatedAt > incoming.generatedAt)
  ) {
    return previous;
  }
  if (
    merge &&
    previous.requestStartedAt === incoming.requestStartedAt &&
    previous.generatedAt === incoming.generatedAt
  ) {
    return { ...incoming, data: merge(previous.data, incoming.data) };
  }
  return incoming;
}

function pruneMemory(map: Map<string, unknown>, now: number): void {
  const fresh: { key: string; generatedAt: number }[] = [];
  for (const [key, raw] of map) {
    if (!isStoredEntry(raw) || !isFresh(raw, now)) map.delete(key);
    else fresh.push({ key, generatedAt: raw.generatedAt });
  }
  fresh.sort((a, b) => a.generatedAt - b.generatedAt);
  for (const row of fresh.slice(0, Math.max(0, fresh.length - MAX_REPORT_CACHE_ENTRIES))) {
    map.delete(row.key);
  }
}

/** Injectable storage with the same monotonic writes, expiry cleanup and cap as IndexedDB. */
export function createMemoryReportCacheStorage(): ReportCacheStorage & {
  readonly map: Map<string, unknown>;
} {
  const map = new Map<string, unknown>();
  return {
    map,
    async get<T>(key: string, accept: (raw: unknown) => raw is T): Promise<T | null> {
      const raw = map.get(key);
      if (!accept(raw)) {
        map.delete(key);
        return null;
      }
      return structuredClone(raw);
    },
    async putIfNewer(key, entry, now, merge) {
      const winner = winningEntry(map.get(key), entry, now, merge);
      map.set(key, structuredClone(winner));
      pruneMemory(map, now);
      return structuredClone(winner);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new DOMException('IndexedDB is unavailable.', 'NotSupportedError'));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(REPORT_CACHE_DB, CACHE_SCHEMA_VERSION);
    let blocked = false;
    request.onerror = () => reject(request.error ?? new DOMException('Cannot open report cache.'));
    request.onblocked = () => {
      blocked = true;
      reject(new DOMException('Report cache upgrade is blocked.', 'InvalidStateError'));
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(REPORT_CACHE_STORE)) {
        db.createObjectStore(REPORT_CACHE_STORE);
      }
    };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new DOMException('Report cache transaction failed.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new DOMException('Report cache transaction aborted.'));
  });
}

/** Cursor cleanup remains in the write transaction, including the size cap. */
function pruneStore(store: IDBObjectStore, now: number): void {
  const fresh: { key: IDBValidKey; generatedAt: number }[] = [];
  const request = store.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor) {
      const raw: unknown = cursor.value;
      if (!isStoredEntry(raw) || !isFresh(raw, now)) cursor.delete();
      else fresh.push({ key: cursor.primaryKey, generatedAt: raw.generatedAt });
      cursor.continue();
      return;
    }
    fresh.sort((a, b) => a.generatedAt - b.generatedAt);
    for (const row of fresh.slice(0, Math.max(0, fresh.length - MAX_REPORT_CACHE_ENTRIES))) {
      store.delete(row.key);
    }
  };
}

export function createIdbReportCacheStorage(): ReportCacheStorage {
  return {
    async get<T>(key: string, accept: (raw: unknown) => raw is T): Promise<T | null> {
      const db = await openDb();
      try {
        const transaction = db.transaction(REPORT_CACHE_STORE, 'readwrite');
        const done = transactionDone(transaction);
        const store = transaction.objectStore(REPORT_CACHE_STORE);
        const request = store.get(key);
        let found: T | null = null;
        request.onsuccess = () => {
          const raw: unknown = request.result;
          if (accept(raw)) found = raw;
          else store.delete(key);
        };
        await done;
        return found;
      } finally {
        db.close();
      }
    },
    async putIfNewer(key, entry, now, merge) {
      const db = await openDb();
      try {
        const transaction = db.transaction(REPORT_CACHE_STORE, 'readwrite');
        const done = transactionDone(transaction);
        const store = transaction.objectStore(REPORT_CACHE_STORE);
        const request = store.get(key);
        let winner = entry;
        request.onsuccess = () => {
          const previous: unknown = request.result;
          winner = winningEntry(previous, entry, now, merge);
          if (winner !== previous) store.put(winner, key);
          pruneStore(store, now);
        };
        await done;
        return winner;
      } finally {
        db.close();
      }
    },
    async delete(key) {
      const db = await openDb();
      try {
        const transaction = db.transaction(REPORT_CACHE_STORE, 'readwrite');
        const done = transactionDone(transaction);
        transaction.objectStore(REPORT_CACHE_STORE).delete(key);
        await done;
      } finally {
        db.close();
      }
    },
  };
}

const sessionFallback = createMemoryReportCacheStorage();

/** Persist when possible; a blocked/quota-limited browser retains an in-session cache. */
export function createReportCache({
  now = Date.now,
  storage,
}: {
  now?: () => number;
  storage?: ReportCacheStorage;
} = {}): ReportCache {
  const primary = storage ?? createIdbReportCacheStorage();
  const fallback = storage === undefined ? sessionFallback : createMemoryReportCacheStorage();
  return {
    async get<T>(
      key: string,
      validate: (raw: unknown) => raw is T,
      merge?: ReportCacheMerge,
    ): Promise<CachedReport<T> | null> {
      const current = now();
      const accept = (raw: unknown): raw is StoredReportCacheEntry & CachedReport<T> =>
        isStoredEntry(raw) && isFresh(raw, current) && validate(raw.data);
      // A quota failure can reject a put while later reads still succeed with
      // null or an older snapshot. Keep the successful in-session result usable.
      let entry: StoredReportCacheEntry | null = await fallback.get(key, accept);
      try {
        const persisted = await primary.get(key, accept);
        if (persisted !== null) {
          entry = entry === null ? persisted : winningEntry(persisted, entry, current, merge);
        }
      } catch (error) {
        if (!(error instanceof DOMException)) throw error;
      }
      if (entry === null) return null;
      const winner = await fallback.putIfNewer(key, entry, current, merge);
      if (!accept(winner)) return null;
      return {
        data: winner.data,
        generatedAt: winner.generatedAt,
        requestStartedAt: winner.requestStartedAt,
      };
    },
    async put<T>(key: string, entry: CachedReport<T>, merge?: ReportCacheMerge) {
      const stored: StoredReportCacheEntry = { ...entry, schemaVersion: CACHE_SCHEMA_VERSION };
      const current = now();
      if (!isStoredEntry(stored) || stored.generatedAt > current) {
        throw new RangeError('Report cache timestamps are invalid.');
      }
      if (!isFresh(stored, current)) return;
      const local = await fallback.putIfNewer(key, stored, current, merge);
      try {
        const winner = await primary.putIfNewer(key, local, current, merge);
        await fallback.putIfNewer(key, winner, current, merge);
      } catch (error) {
        if (!(error instanceof DOMException)) throw error;
      }
    },
    async delete(key) {
      await fallback.delete(key);
      try {
        await primary.delete(key);
      } catch (error) {
        if (!(error instanceof DOMException)) throw error;
      }
    },
  };
}
