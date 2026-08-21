/**
 * Process-scoped, TTL-bounded read cache with in-flight deduplication.
 *
 * Every server surface here is a long-lived Node process — Cloud Functions gen2
 * container instances persist across invocations, and each App Hosting / Cloud
 * Run Next server persists across requests — so module-scope state survives.
 * Firestore Enterprise bills **data scanned**, and several of the reads we repeat
 * are QUERIES rather than document gets, so deduplicating them saves scanned
 * bytes and not merely document counts.
 *
 * Instances do not coordinate. **The TTL *is* the staleness bound**: after a
 * write, a warm instance can serve the old value for up to `ttlMs`. Where that
 * window is unacceptable for one specific field, use `isFresh` (below) rather
 * than shrinking the TTL for everyone.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NEVER route these through a ReadCache
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. **Anything read inside `runTransaction`.** A `tx.get()` is a lock
 *    acquisition, not just a read: it enters the transaction's read set, and
 *    that is what makes a concurrent write abort and retry the closure.
 *    Substituting a cached value silently drops the document from that set and
 *    changes the transaction's consistency guarantee. Concrete instance:
 *    `apps/functions/src/estoques/sincronizarEstoquePedido.ts` reads `operacao`
 *    via `tx.get()` — it must stay a transactional read. This is also why the
 *    API takes a `Firestore`, never a `Transaction`.
 *
 * 2. **Read-modify-write.** Any value the caller conditionally writes back. The
 *    decision would be made on stale data and the write would clobber whatever
 *    landed in between. `apps/mercado-livre/lib/marketplace/importacao/import.ts` is the
 *    cautionary shape: it CREATES the produto when the SKU lookup misses, so a
 *    cached miss manufactures a duplicate produto.
 *
 * 3. **OAuth credentials / tokens.** `apps/mercado-livre/lib/marketplace/core/tokenStore.ts`
 *    picks the newest valid token by query, and its three reads are load-bearing
 *    precisely *because* they are fresh: the re-check honours a refresh that
 *    landed mid-flight, and the loser fallback exists to observe a write another
 *    process — a concurrent function instance, a Cloud Tasks retry — made
 *    microseconds earlier. ML
 *    refresh tokens are single-use and rotate, so a cached read resurrects a
 *    rotated-out token and turns a survivable race into `invalid_grant`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two further contracts:
 *
 * - **The cached value is SHARED by reference.** N callers receive the identical
 *   object or array — never mutate what `get` hands back. Copy first if you must.
 * - **`createReadCache` belongs at MODULE scope.** The registry behind
 *   `__resetAllReadCaches` holds a reference, and a per-request cache would both
 *   leak and never hit.
 *
 * Adoption guidance, TTL tiers and the invalidation checklist live in the
 * `firestore-read-cache` skill; the rationale and the rejected alternatives
 * (`onSnapshot` mirror, Redis, Firestore bundles) live in ADR 0012.
 */

import { type CacheKey, cacheKeyOf } from './cacheKey';

/** Env valve: `=1` turns every `get` into a straight passthrough. */
export const READ_CACHE_DISABLED_ENV = 'DATA_READ_CACHE_DISABLED';

/**
 * TTL tiers, so a call site names its intent instead of writing a magic number.
 *
 * `config` is the default choice. The documents it is sized for — `integracao`,
 * `metodo_pgto`, `int_frete`, `filial`, `operacao` — change once or twice a
 * YEAR, so a short TTL throws the win away for no real safety gain.
 */
export const READ_CACHE_TTL = {
  /** 15 min — config a human edits once or twice a year. The default choice. */
  config: 900_000,
  /** 60 s — a document the app itself mutates and must pick up quickly. */
  volatile: 60_000,
  /** 5 s — absent / negative results. */
  negative: 5_000,
} as const satisfies Record<string, number>;

/** Thrown by {@link createReadCache} on nonsensical options. */
export class ReadCacheConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadCacheConfigError';
  }
}

/** Where the sampled stats line goes. */
export type ReadCacheLogger = (line: string, fields: Record<string, unknown>) => void;

export interface ReadCacheStats {
  readonly name: string;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  /** Loads that rejected. A rejection is never cached, so this is pure signal. */
  readonly failures: number;
  readonly size: number;
  /** Entries whose load has not settled yet. */
  readonly inFlight: number;
}

export interface ReadCache<K extends CacheKey, V> {
  /**
   * Read through the cache. `load` runs at most once per key per TTL window,
   * and at most once concurrently (in-flight dedup).
   */
  get(key: K, load: () => Promise<V>): Promise<V>;
  /** Drop one key — call this after writing the document it caches. */
  invalidate(key: K): void;
  /** Drop every entry. Counters are cumulative and survive. */
  clear(): void;
  stats(): ReadCacheStats;
}

export interface ReadCacheOptions<V> {
  /** Stable identifier for logs and `stats()`. Convention: `<scope>:<what>`. */
  name: string;
  /**
   * Positive-result lifetime. REQUIRED — there is no global default and no
   * infinite mode. Prefer a {@link READ_CACHE_TTL} tier over a literal.
   */
  ttlMs: number;
  /** Hard upper bound on entries. REQUIRED — evicts least-recently-used first. */
  maxEntries: number;
  /**
   * Lifetime for a negative result. Defaults to `min(READ_CACHE_TTL.negative,
   * ttlMs)`. **Pass `0` to never cache absence** — mandatory wherever an absent
   * value drives an irreversible decision (e.g. a deterministic webhook ack:
   * caching "no account" for a just-connected seller drops its notifications).
   */
  negativeTtlMs?: number;
  /** Which resolved values count as negative. Defaults to `value == null`. */
  isNegative?: (value: V) => boolean;
  /**
   * Extra freshness check run on every HIT of a settled entry; returning `false`
   * evicts and re-reads (counted as a miss).
   *
   * This is the repo's existing substitute for a short TTL — `filial-cert.ts`
   * re-runs its cert-expiry assertion on every hit rather than time-bounding the
   * entry. It converts the one real hazard of a long TTL into a check that costs
   * nothing in steady state: an `integracao` reader can pass
   * `(conta) => conta.user_id != null` and refuse a document that predates the
   * connect-time back-fill, on every instance rather than only the one that
   * handled the OAuth callback.
   */
  isFresh?: (value: V) => boolean;
  /** Injectable clock. Tests set this instead of sleeping. */
  now?: () => number;
  /** Defaults to a `console.warn` line prefixed `[read-cache]`. */
  log?: ReadCacheLogger;
  /** Emit one stats line every N `get`s. Default 500; `0` disables logging. */
  sampleEvery?: number;
}

interface Entry<V> {
  promise: Promise<V>;
  /** `null` while the load is in flight — an unsettled entry never expires. */
  expiresAt: number | null;
  /** Boxed resolved value, so `isFresh` can inspect it synchronously on a hit. */
  settled: { readonly value: V } | null;
}

interface RegisteredCache {
  readonly name: string;
  stats(): ReadCacheStats;
  reset(): void;
}

/**
 * Every cache built by {@link createReadCache}, so tests can reset them all and
 * a surface can log every hit rate at one boundary. Caches re-register
 * themselves on `get`, which is what makes emptying this set on reset safe.
 */
const registry = new Set<RegisteredCache>();

const defaultLogger: ReadCacheLogger = (line, fields) => {
  // `warn` is the only non-error console channel `@delfrance/config-eslint`
  // allows (`no-console` → `{ allow: ['warn', 'error'] }`), so it carries this
  // info-grade line — same choice as `apps/nfe/lib/nfe/tasks.ts`' mode notice.
  console.warn(line, fields);
};

function requirePositive(label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ReadCacheConfigError(`${label} must be a finite number > 0, got ${String(value)}`);
  }
}

/**
 * Build a process-scoped read cache. Read the exclusions at the top of this file
 * before adopting it anywhere.
 *
 * ```ts
 * // module scope — one cache per read shape
 * const integracaoByUserId = createReadCache<readonly [number], string | null>({
 *   name: 'ml:integracao-by-user-id',
 *   ttlMs: READ_CACHE_TTL.config,
 *   maxEntries: 64,
 *   negativeTtlMs: 0, // "no account" drives a deterministic ack — never cache it
 * });
 *
 * // call site
 * const id = await integracaoByUserId.get([userId], () =>
 *   resolveIntegracaoByUserId(db, userId),
 * );
 * ```
 */
export function createReadCache<K extends CacheKey, V>(opts: ReadCacheOptions<V>): ReadCache<K, V> {
  requirePositive('ttlMs', opts.ttlMs);
  if (!Number.isInteger(opts.maxEntries) || opts.maxEntries < 1) {
    throw new ReadCacheConfigError(
      `maxEntries must be an integer >= 1, got ${String(opts.maxEntries)}`,
    );
  }
  const negativeTtlMs = opts.negativeTtlMs ?? Math.min(READ_CACHE_TTL.negative, opts.ttlMs);
  if (!Number.isFinite(negativeTtlMs) || negativeTtlMs < 0) {
    throw new ReadCacheConfigError(
      `negativeTtlMs must be a finite number >= 0, got ${String(negativeTtlMs)}`,
    );
  }
  for (const existing of registry) {
    if (existing.name === opts.name) {
      console.warn(
        `[read-cache] duplicate cache name '${opts.name}' — stats and logs will be ambiguous. ` +
          'Was createReadCache called per request instead of at module scope?',
      );
      break;
    }
  }

  const { name, ttlMs, maxEntries } = opts;
  const nowMs = opts.now ?? Date.now;
  const isNegative = opts.isNegative ?? ((value: V): boolean => value == null);
  const isFresh = opts.isFresh;
  const log = opts.log ?? defaultLogger;
  const sampleEvery = opts.sampleEvery ?? 500;

  const entries = new Map<string, Entry<V>>();
  let hits = 0;
  let misses = 0;
  let evictions = 0;
  let failures = 0;
  let gets = 0;

  function stats(): ReadCacheStats {
    let inFlight = 0;
    for (const entry of entries.values()) {
      if (entry.expiresAt == null) inFlight += 1;
    }
    return { name, hits, misses, evictions, failures, size: entries.size, inFlight };
  }

  function reset(): void {
    entries.clear();
    hits = 0;
    misses = 0;
    evictions = 0;
    failures = 0;
    gets = 0;
  }

  const registered: RegisteredCache = { name, stats, reset };
  registry.add(registered);

  /**
   * Usable = in flight, or settled and neither expired nor refused by `isFresh`.
   * The TTL boundary is exclusive: at exactly `expiresAt` the entry is expired.
   */
  function isUsable(entry: Entry<V>): boolean {
    if (entry.expiresAt == null) return true;
    if (entry.expiresAt <= nowMs()) return false;
    if (isFresh != null && entry.settled != null && !isFresh(entry.settled.value)) return false;
    return true;
  }

  function evictOverflow(): void {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done === true) return;
      entries.delete(oldest.value);
      evictions += 1;
    }
  }

  function maybeLog(): void {
    if (sampleEvery <= 0 || gets % sampleEvery !== 0) return;
    const snapshot = stats();
    log(
      `[read-cache] ${name}: ${snapshot.hits} hits, ${snapshot.misses} misses, ` +
        `${snapshot.evictions} evictions, ${snapshot.failures} failures, size ${snapshot.size}`,
      { ...snapshot },
    );
  }

  return {
    get(key, load) {
      // Read per call rather than at module load: it matches the repo's
      // `process.env.X_DISABLED === '1'` idiom, lets a test flip it by
      // reference, and one env lookup is nothing against a Firestore round trip.
      if (process.env[READ_CACHE_DISABLED_ENV] === '1') return load();
      // Idempotent — re-registers a module-scope cache that a test reset removed.
      registry.add(registered);
      gets += 1;

      const encoded = cacheKeyOf(key);
      const hit = entries.get(encoded);
      if (hit != null && isUsable(hit)) {
        hits += 1;
        // LRU touch: delete + reinsert moves the entry to the tail of the
        // insertion-ordered Map, so `evictOverflow` drops the least recently
        // USED key rather than the oldest inserted one.
        entries.delete(encoded);
        entries.set(encoded, hit);
        maybeLog();
        return hit.promise;
      }
      if (hit != null) entries.delete(encoded);
      misses += 1;

      // Both settle handlers identify "their" entry by the promise they are
      // attached to — a self-reference in the initializer, legal because the
      // handlers only run once `promise` is bound.
      const promise: Promise<V> = load().then(
        (value) => {
          // A different promise under this key means `invalidate` / `clear` /
          // eviction ran while we were in flight. That decision wins.
          const current = entries.get(encoded);
          if (current?.promise === promise) {
            const ttl = isNegative(value) ? negativeTtlMs : ttlMs;
            if (ttl <= 0) {
              entries.delete(encoded);
            } else {
              current.settled = { value };
              current.expiresAt = nowMs() + ttl;
            }
          }
          return value;
        },
        (err: unknown) => {
          // A rejection is NEVER cached: a transient failure must not poison the
          // key for the whole TTL. There is no `catch` clause anywhere in this
          // module, so CLAUDE.md rule 6 holds structurally — this handler
          // rethrows unconditionally.
          failures += 1;
          if (entries.get(encoded)?.promise === promise) entries.delete(encoded);
          throw err;
        },
      );
      entries.set(encoded, { promise, expiresAt: null, settled: null });
      evictOverflow();
      maybeLog();
      return promise;
    },

    invalidate(key) {
      entries.delete(cacheKeyOf(key));
    },

    clear() {
      entries.clear();
    },

    stats,
  };
}

/**
 * Hit rates for every registered cache, for one structured log line at a natural
 * boundary (the end of a sweep tick, the end of a task handler).
 */
export function readCacheStatsSnapshot(): readonly ReadCacheStats[] {
  return [...registry].map((cache) => cache.stats());
}

/**
 * Test-only: clear every registered cache's entries AND counters.
 *
 * Mandatory in `beforeEach`/`afterEach` of any suite that touches a cached read
 * — `*.storage.test.ts` files share one process, so without it a cache set up by
 * one test serves the next. Mirrors `__resetFilialCertCacheForTests`.
 *
 * Also empties the registry, so per-test caches do not accumulate; a module-scope
 * cache re-registers itself on its next `get`.
 */
export function __resetAllReadCaches(): void {
  for (const cache of registry) cache.reset();
  registry.clear();
}
