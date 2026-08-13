/**
 * Process-scoped caches for the `metodo_pgto` Mercado Pago account — the
 * document itself, and the collector lookup that resolves an inbound webhook to
 * it.
 *
 * A leaf module rather than two module-private caches, for one reason: the
 * writer that must evict (`exchangeAndPersist`, in `mercadoPago.ts`) and the
 * query that goes stale (`resolveMetodoByCollector`, in `notificacao.ts`) live
 * on opposite sides of an existing import edge, so a cache in either module
 * would force a cycle. Same shape as the Mercado Livre `contaCache`.
 *
 * ⚠️ `readMercadoPagoMetodo` performs NO tipo check. It replaces the read, not
 * the contract — `loadMercadoPagoContext` keeps both of its throws.
 *
 * ⚠️ The OAuth credential is NOT here and must never be. It lives in the
 * `metodo_pgto/{id}/credenciais` subcollection behind `createCredentialStore`,
 * and `resolveAccessToken` is a read-modify-write over a rotating, single-use
 * MP refresh token — the exact shape the cache forbids.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  READ_CACHE_TTL,
  createCachedDocReader,
  createReadCache,
} from '@delfrance/data/admin/cache';
import { metodoPagamentoCollection } from '@delfrance/data/admin/collections';

/**
 * Injectable clock. `createReadCache` captures `opts.now` once at construction —
 * import time for a module-scope cache — so both caches read this binding
 * through an arrow rather than handing over the reference, which would freeze
 * it. Production never moves it.
 */
let nowFn: () => number = Date.now;

/**
 * The `metodo_pgto` config document.
 *
 * The repeat: `notificacao.ts` loads a context per verified webhook AND per
 * re-drive in the 30-minute reprocess sweep; three routes read it besides.
 *
 * `isFresh` is the Mercado Livre analogue, exactly. `exchangeAndPersist` merges
 * `user_id` onto this document at connect time, the schema defaults that field
 * to `null`, and `user_id` is the predicate the collector query filters on. So
 * refusing a `user_id == null` document refuses precisely a pre-back-fill one,
 * on EVERY instance rather than only the one that handled the OAuth callback —
 * which is what makes a 15-minute TTL safe across processes. It converges
 * permanently at connect, so it costs nothing in steady state.
 *
 * `maxEntries: 16` — realistically one MP account per tenant (the v1 scan cap
 * says as much); a memory guard with ~10x headroom, not a tuning knob.
 */
const metodoReader = createCachedDocReader(metodoPagamentoCollection, {
  name: 'mp:metodo-pgto',
  ttlMs: READ_CACHE_TTL.config,
  maxEntries: 16,
  negativeTtlMs: 0,
  isFresh: (conta) => conta.user_id != null,
  now: () => nowFn(),
});

/** Outcome of resolving the owning `metodo_pgto` account for a notification. */
export type MetodoResolution =
  | { kind: 'resolved'; metodoId: string; userId: number | null }
  | { kind: 'failed'; reason: string };

/**
 * Collector → the owning account. ONE cache for BOTH query shapes: the v2
 * `user_id` equality and the v1-IPN scan. `null` marks the v1 branch, which
 * takes no input at all — so that key is input-independent and a single entry
 * serves 100% of v1 traffic.
 *
 * `volatile` (60 s), NOT `config`. This answer is derived from the SET of
 * `metodo_pgto` documents rather than from one config document, so "changes
 * twice a year" does not apply — it changes whenever any account is created,
 * connected or deleted. 60 s bounds the window in which the input-independent
 * v1 entry could name a superseded account, while still collapsing an IPN burst.
 *
 * That window is safe three layers deep even at its worst: the wrong account's
 * token makes MP return 404 for the payment (a deterministic park), the
 * post-refetch collector safety net parks anything that slips past, and the
 * 30-minute sweep re-drives. Never a wrong reconcile.
 *
 * `negativeTtlMs: 0` with `isNegative` covering BOTH failure kinds: a miss or an
 * ambiguity produces `kind: 'failed'`, which PERSISTS a `notificacoesMercadoPago`
 * document that only the sweep re-drives, past its own staleness window. Caching
 * that for a seller who connected moments ago costs a Firestore write and well
 * over an hour of delay. Failures re-run the query, so their reason strings stay
 * exact.
 */
const metodoByCollector = createReadCache<readonly [number | null], MetodoResolution>({
  name: 'mp:metodo-by-collector',
  ttlMs: READ_CACHE_TTL.volatile,
  maxEntries: 16,
  negativeTtlMs: 0,
  isNegative: (value) => value.kind !== 'resolved',
  now: () => nowFn(),
});

/** The parsed `metodo_pgto` document, or `null` when it does not exist. */
export function readMercadoPagoMetodo(
  db: Firestore,
  metodoId: string,
): ReturnType<typeof metodoReader.get> {
  return metodoReader.get(db, {}, metodoId);
}

/**
 * The cached collector resolve. `collectorUserId` is the ONLY variable
 * predicate — `tipo == mercadoPago` is constant on both branches, and the v1
 * scan's cap is a module constant — so it alone keys the entry, with `null`
 * naming the v1 branch.
 */
export function readMetodoByCollector(
  collectorUserId: number | null,
  load: () => Promise<MetodoResolution>,
): Promise<MetodoResolution> {
  return metodoByCollector.get([collectorUserId], load);
}

/**
 * Evict after a self-write to `metodo_pgto/{id}`. Both writers merge `user_id`:
 * `exchangeAndPersist` and the drift self-heal in the `conta` route.
 *
 * The merge changes the collector query's own predicate, so that entry goes too
 * — and so does the v1 entry, whose answer is derived from the set of connected
 * accounts, which is exactly what this write changes.
 *
 * ⚠️ This covers THIS instance only. The notification consumer is a different
 * process; there, `isFresh`, `negativeTtlMs: 0` and the 60-second collector TTL
 * carry the case. Do not read these evictions as cross-process coherence.
 */
export function invalidateMercadoPagoMetodo(metodoId: string, collectorUserId?: number): void {
  metodoReader.invalidate({}, metodoId);
  if (collectorUserId != null) metodoByCollector.invalidate([collectorUserId]);
  metodoByCollector.invalidate([null]);
}

/**
 * Test-only. The caches are module-scope, and the primitive captures `now` once
 * at construction, so the clock is swapped through this binding rather than
 * passed per test. Pair it with `__resetAllReadCaches()`.
 */
export function __setMercadoPagoCacheClockForTests(now: () => number = Date.now): void {
  nowFn = now;
}
