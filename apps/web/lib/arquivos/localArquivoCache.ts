/**
 * Browser IndexedDB cache for arquivo bytes — port of the Flutter
 * `downloadArquivoUsingLocalCache` idea (`.old/lib/global/download/downloadUsingLocalCache.dart`).
 *
 * Next-owned store (not the Flutter `localArquivoCacheDB` base64 DB) so we can
 * keep ArrayBuffer payloads + metadata in our own format.
 *
 * Soft-prunes oldest entries when the store exceeds {@link MAX_CACHE_ENTRIES}.
 */

export const ARQUIVO_CACHE_DB = 'delfrance-arquivo-cache';
export const ARQUIVO_CACHE_STORE = 'arquivos';
export const ARQUIVO_CACHE_VERSION = 1;
/** Soft cap — drop oldest `cachedAt` entries when exceeded after a put. */
export const MAX_CACHE_ENTRIES = 50;

export interface CachedArquivo {
  readonly contentType: string;
  readonly fileName: string;
  readonly bytes: ArrayBuffer;
  readonly cachedAt: number;
}

export interface ArquivoCache {
  get(arquivoId: string): Promise<CachedArquivo | null>;
  put(arquivoId: string, entry: CachedArquivo): Promise<void>;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(ARQUIVO_CACHE_DB, ARQUIVO_CACHE_VERSION);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ARQUIVO_CACHE_STORE)) {
        db.createObjectStore(ARQUIVO_CACHE_STORE);
      }
    };
  });
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDBRequest failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IDBTransaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IDBTransaction aborted'));
  });
}

/**
 * Default browser-backed cache. Safe to call from the client only
 * (`indexedDB` is unavailable in SSR / Node unit tests — inject a memory
 * cache there).
 */
export function createIdbArquivoCache(): ArquivoCache {
  return {
    async get(arquivoId) {
      const db = await openDb();
      try {
        const tx = db.transaction(ARQUIVO_CACHE_STORE, 'readonly');
        const store = tx.objectStore(ARQUIVO_CACHE_STORE);
        const raw = await idbReq(store.get(arquivoId));
        await txDone(tx);
        if (!raw || typeof raw !== 'object') return null;
        const entry = raw as CachedArquivo;
        if (!(entry.bytes instanceof ArrayBuffer)) return null;
        return entry;
      } finally {
        db.close();
      }
    },

    async put(arquivoId, entry) {
      const db = await openDb();
      try {
        const writeTx = db.transaction(ARQUIVO_CACHE_STORE, 'readwrite');
        writeTx.objectStore(ARQUIVO_CACHE_STORE).put(entry, arquivoId);
        await txDone(writeTx);
        await pruneIfNeeded(db);
      } finally {
        db.close();
      }
    },
  };
}

/**
 * Drop oldest entries (by `cachedAt`) until count ≤ {@link MAX_CACHE_ENTRIES}.
 * No-op when under the cap. Failures are swallowed so a prune bug never blocks
 * a download.
 */
async function pruneIfNeeded(db: IDBDatabase): Promise<void> {
  try {
    const readTx = db.transaction(ARQUIVO_CACHE_STORE, 'readonly');
    const store = readTx.objectStore(ARQUIVO_CACHE_STORE);
    const keys = (await idbReq(store.getAllKeys())) as IDBValidKey[];
    const values = (await idbReq(store.getAll())) as CachedArquivo[];
    await txDone(readTx);
    if (keys.length <= MAX_CACHE_ENTRIES) return;

    const rows = keys.map((key, i) => ({
      key,
      cachedAt: typeof values[i]?.cachedAt === 'number' ? values[i]!.cachedAt : 0,
    }));
    rows.sort((a, b) => a.cachedAt - b.cachedAt);
    const drop = rows.slice(0, rows.length - MAX_CACHE_ENTRIES);
    if (drop.length === 0) return;

    const delTx = db.transaction(ARQUIVO_CACHE_STORE, 'readwrite');
    const delStore = delTx.objectStore(ARQUIVO_CACHE_STORE);
    for (const row of drop) delStore.delete(row.key);
    await txDone(delTx);
  } catch (err) {
    // Best-effort prune — private mode / quota must never block put.
    if (!(err instanceof DOMException)) throw err;
  }
}

/** In-memory cache for unit tests (and as a seam override). */
export function createMemoryArquivoCache(
  seed?: ReadonlyMap<string, CachedArquivo>,
): ArquivoCache & { readonly map: Map<string, CachedArquivo> } {
  const map = new Map<string, CachedArquivo>(seed);
  return {
    map,
    async get(id) {
      return map.get(id) ?? null;
    },
    async put(id, entry) {
      map.set(id, entry);
      if (map.size <= MAX_CACHE_ENTRIES) return;
      const ranked = [...map.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt);
      const drop = ranked.slice(0, map.size - MAX_CACHE_ENTRIES);
      for (const [k] of drop) map.delete(k);
    },
  };
}
