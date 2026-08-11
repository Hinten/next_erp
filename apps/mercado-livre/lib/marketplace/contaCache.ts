/**
 * Process-scoped cache for the ONE Mercado Livre `integracao` document, and for
 * the seller-id lookup keyed off it.
 *
 * Three reads of the SAME document live in three different modules, and a single
 * `orders_v2` / `payments` / `shipments` notification pays all three: the
 * seller-id query (`notificacao.ts`), the context loader's doc get
 * (`mercadoLivre.ts`) and the conta bag's soft-read (`orderImport.ts`).
 * Separate caches would not share — the collapse needs ONE instance, keyed by
 * the resolved `integracao/{id}` path, which is why this is its own module.
 * The account is also re-read once per stock-send task, and a sweep enqueues up
 * to `maxTasksPerSweep()` of those per conta every 15 minutes: the highest
 * absolute read volume in the app, and where single-flight alone already wins.
 *
 * ⚠️ Cache the PARSED DOCUMENT, never the `MercadoLivreContext`. That object
 * closes over `db` and a live `TokenDuravelStore`, and the token must stay
 * uncached — ML refresh tokens are single-use and rotate, so a cached read turns
 * a survivable race into `invalid_grant`. The cacheable seam is the `.get()`,
 * which is the loader's only I/O.
 *
 * ⚠️ None of the three forbidden cases applies. No `tx.get` — every entry point
 * takes a `Firestore`, and the transactional `int_frete` lookups in
 * `intFreteSync.ts` deliberately do not route through here. No
 * read-modify-write: the one server-side writer of this document is
 * `exchangeAndPersist`, which merges a value it got from ML rather than from the
 * read, and evicts below. No token.
 *
 * ⚠️ `get` hands back the SAME object reference on every hit. `loadContaBag`
 * projects into a fresh object and `mercadoLivreAccountBag` builds a new one, so
 * nothing here is mutated today — keep it that way.
 *
 * Staleness: instances do not coordinate, so `READ_CACHE_TTL.config` (15 min)
 * IS the bound. Every other writer of `integracao` is apps/web's BROWSER client
 * (a client-SDK delete, and the schema-driven CRUD edit), unreachable from any
 * server process, so no server-side invalidation can exist for those. The one
 * drift that is NOT benign is handled by `resolveContaAtivaPorUserId`.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  READ_CACHE_TTL,
  createCachedDocReader,
  createReadCache,
} from '@delfrance/data/admin/cache';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import type { Integracao } from '@delfrance/schemas';

/**
 * Injectable clock. `createReadCache` captures `opts.now` ONCE at construction,
 * which for a module-scope cache is import time — so the caches below read this
 * binding through an arrow (`now: () => nowFn()`) rather than handing over the
 * reference, which would freeze it. Production never moves it.
 */
let nowFn: () => number = Date.now;

/**
 * The conta document itself.
 *
 * `maxEntries: 64` — one entry per `integracao` id looked up in this process.
 * The install has a handful of connected ML accounts (the enumeration in
 * `estoqueSweep.ts` is the population) and a parsed `integracao` is well under
 * 2 KB, so this bounds the cache at ~128 KB with an order of magnitude of
 * headroom. The LRU is a leak guard, not a working-set limit.
 *
 * `isFresh` — a conta that has never completed OAuth has no `user_id`, and
 * `exchangeAndPersist` back-fills it on a DIFFERENT instance from the ones that
 * will read it. Refusing such a document on every hit is what makes a 15-minute
 * TTL safe (ADR 0012). It costs nothing once the field is set, and it never runs
 * for a cached absence.
 *
 * `sampleEvery: 0` — the built-in sampler writes through `console.warn`, the
 * wrong severity for a metric, and at its default of 500 an instance serving
 * fewer gets logs nothing at all. Hit rates are reported structurally at the
 * function boundaries instead.
 */
const contaReader = createCachedDocReader(integracaoCollection, {
  name: 'ml:integracao',
  ttlMs: READ_CACHE_TTL.config,
  maxEntries: 64,
  isFresh: (conta) => conta.user_id != null,
  now: () => nowFn(),
  sampleEvery: 0,
});

/**
 * ML seller `user_id` → the active conta's id, i.e. the three-predicate query
 * in `notificacao.ts` paid once per inbound notification.
 *
 * ⚠️ The key is `[userId]` ALONE because the query's other two predicates are
 * constants (`tipo == mercadoLivre`, `ativo == true`). If either ever becomes a
 * variable it MUST join the key — omitting a predicate value is the one way to
 * get a wrong hit.
 *
 * `negativeTtlMs: 0` — a `null` here produces `{ kind: 'no-account' }`, which
 * `toDisposition` turns into `{ kind: 'fail' }`. The pipeline then PERSISTS a
 * `notificacoesMercadoLivre` failure document and only the 30-minute sweep
 * re-drives it. Caching that for a seller who connected 30 seconds ago
 * manufactures failure rows for notifications that would have succeeded.
 */
const integracaoByUserId = createReadCache<readonly [number], string | null>({
  name: 'ml:integracao-by-user-id',
  ttlMs: READ_CACHE_TTL.config,
  maxEntries: 64,
  negativeTtlMs: 0,
  now: () => nowFn(),
  sampleEvery: 0,
});

/** The parsed conta document, or `null` when it does not exist. */
export function readConta(db: Firestore, integracaoId: string): Promise<Integracao | null> {
  return contaReader.get(db, {}, integracaoId);
}

/**
 * Drop this conta's cached entry. Call it right after writing the document from
 * this process — `exchangeAndPersist` merges `user_id` onto the very document
 * its own loader read. Covers THIS instance only; other warm instances stay
 * stale until the TTL, which is what `isFresh` and the drift check below are
 * for.
 */
export function invalidateConta(integracaoId: string): void {
  contaReader.invalidate({}, integracaoId);
}

/**
 * The cached seller-id resolve, cross-checked against the conta it names.
 *
 * `user_id` changes exactly once in a conta's life that matters here: when the
 * operator disconnects and reconnects with a DIFFERENT ML account (A → B).
 * `isFresh` cannot see that — a stale copy still has `user_id: A != null`, so it
 * passes — and only the instance that ran the OAuth callback can evict. On every
 * OTHER warm instance the stale `A` would reach the seller guard in
 * `orderImport.ts`, which returns `skipped: 'seller-mismatch'`; the dispatcher
 * logs that and still returns `{ kind: 'done' }` → `{ kind: 'resolve' }`.
 * NOTHING is persisted, so the 30-minute sweep never re-drives it and the order
 * is SILENTLY LOST for up to the TTL. That is a regression the uncached code
 * does not have, so it is fixed here rather than accepted.
 *
 * The fix is free: the notification carries the AUTHORITATIVE seller id, so a
 * cached conta whose `user_id` disagrees with it is provably stale. On
 * disagreement both entries are dropped — the query's predicate IS
 * `user_id == userId`, so it is stale too — and the query re-runs once against
 * Firestore. Bounded by construction: one eviction, one retry, no loop.
 *
 * In steady state this costs one cache hit and PRE-WARMS the entry that
 * `loadMercadoLivreContext` and `loadContaBag` need microseconds later.
 */
export async function resolveContaAtivaPorUserId(
  db: Firestore,
  userId: number,
  load: () => Promise<string | null>,
): Promise<string | null> {
  const id = await integracaoByUserId.get([userId], load);
  if (id == null) return null;

  const conta = await contaReader.get(db, {}, id);
  if (conta == null || conta.user_id === userId) return id;

  integracaoByUserId.invalidate([userId]);
  contaReader.invalidate({}, id);
  return integracaoByUserId.get([userId], load);
}

/**
 * Test-only. The caches are module-scope — they must be, since a per-request
 * cache never hits — so `now` cannot be passed per test the way the primitive's
 * own suites do. Mirrors `__resetFilialCertCacheForTests` in
 * `apps/nfe/lib/nfe/filial-cert.ts`. Pair it with `__resetAllReadCaches()`.
 */
export function __setContaCacheClockForTests(now: () => number = Date.now): void {
  nowFn = now;
}
