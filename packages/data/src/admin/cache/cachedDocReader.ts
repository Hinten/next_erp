/**
 * Typed read-through cache for a single document of an `AdminCollectionHandle`.
 *
 * `AdminCollectionHandle` deliberately exposes no `get`, so the
 * "read one doc by id → parsed value or null" idiom is hand-copied at a dozen
 * call sites (`massImport.ts`' `readJob`, `precoSync.ts`, both `credentialStore.ts`,
 * `filial-cert.ts`). This wraps that idiom once and puts a TTL in front of it.
 *
 * The exclusions in `./readCache` apply unchanged — in particular this reader
 * takes a `Firestore`, never a `Transaction`, so a transactional read cannot
 * accidentally opt in.
 *
 * ⚠️ The cache key is the document PATH; `db` is not part of it. That is sound
 * because every app resolves one admin `Firestore` singleton per process — but
 * two different databases driven from one process would collide.
 *
 * The `firebase-admin/firestore` import is type-only (erased at emit via
 * `verbatimModuleSyntax` + `isolatedModules`) and this module makes no runtime
 * admin-SDK call — it operates on the `db` the app passes in.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { z } from 'zod';

import type { AdminCollectionHandle, PathContext } from '../defineAdminCollection';
import { type ReadCacheLogger, type ReadCacheStats, createReadCache } from './readCache';

export interface CachedDocReaderOptions<T extends z.ZodTypeAny> {
  /** Stable identifier for logs and `stats()`. Convention: `<scope>:<what>`. */
  name: string;
  /** Positive-result lifetime. Prefer a `READ_CACHE_TTL` tier over a literal. */
  ttlMs: number;
  /** Hard upper bound on entries; least-recently-used is evicted first. */
  maxEntries: number;
  /**
   * Lifetime for "document absent". Defaults to the shared negative tier; pass
   * `0` wherever absence drives an irreversible decision.
   */
  negativeTtlMs?: number;
  /**
   * Freshness check on every hit of a PRESENT document; returning `false` evicts
   * and re-reads. An absent (cached-`null`) entry is governed by `negativeTtlMs`
   * alone and is never passed here.
   */
  isFresh?: (value: z.infer<T>) => boolean;
  /** Injectable clock. Tests set this instead of sleeping. */
  now?: () => number;
  log?: ReadCacheLogger;
  sampleEvery?: number;
}

export interface CachedDocReader<T extends z.ZodTypeAny> {
  /** Parsed document, or `null` when it does not exist. */
  get(db: Firestore, ctx: PathContext, id: string): Promise<z.infer<T> | null>;
  /**
   * Drop this document's entry. Call it right after writing the document from
   * this process — e.g. `exchangeAndPersist` merges `user_id` onto the very
   * `integracao` document its own loader read. Covers THIS instance only; other
   * warm instances stay stale until the TTL, which is what `isFresh` is for.
   */
  invalidate(ctx: PathContext, id: string): void;
  clear(): void;
  stats(): ReadCacheStats;
}

/**
 * ```ts
 * // module scope
 * const integracaoReader = createCachedDocReader(integracaoCollection, {
 *   name: 'ml:integracao',
 *   ttlMs: READ_CACHE_TTL.config,
 *   maxEntries: 64,
 *   isFresh: (conta) => conta.user_id != null,
 * });
 *
 * // in the loader — keep the throw, the reader only replaces the read
 * const conta = await integracaoReader.get(db, {}, integracaoId);
 * if (conta == null) throw new MercadoLivreContaNotConfiguredError(...);
 * ```
 */
export function createCachedDocReader<T extends z.ZodTypeAny>(
  handle: AdminCollectionHandle<T>,
  opts: CachedDocReaderOptions<T>,
): CachedDocReader<T> {
  type Value = z.infer<T> | null;

  const userIsFresh = opts.isFresh;
  const cache = createReadCache<string, Value>({
    name: opts.name,
    ttlMs: opts.ttlMs,
    maxEntries: opts.maxEntries,
    negativeTtlMs: opts.negativeTtlMs,
    now: opts.now,
    log: opts.log,
    sampleEvery: opts.sampleEvery,
    isFresh:
      userIsFresh == null
        ? undefined
        : (value: Value): boolean => value == null || userIsFresh(value),
  });

  return {
    get(db, ctx, id) {
      // The resolved `collection/id` path is the key: pure string concat, no `db`
      // needed, and it namespaces subcollections for free (two filiais' configs
      // cannot collide).
      const path = handle.docPath(ctx, id);
      return cache.get(path, async () => {
        const snap = await handle.docRef(db, ctx, id).get();
        if (!snap.exists) return null;
        // `path` doubles as the soft-read label, so a schema drift warning names
        // the concrete document.
        return handle.parseRead(snap.data(), path);
      });
    },

    invalidate(ctx, id) {
      cache.invalidate(handle.docPath(ctx, id));
    },

    clear() {
      cache.clear();
    },

    stats() {
      return cache.stats();
    },
  };
}
