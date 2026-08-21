/**
 * Process-scoped cache for the `listaDePrecos` (price list) document — read
 * only for its `nome`, to name the table in `resolvePrice`'s blocked-publish
 * message alongside the raw Firestore id an operator otherwise has no way to
 * look up.
 *
 * The repeat: `tabelaNormalOuterRef` is a property of the INTEGRAÇÃO (conta),
 * so it resolves to the SAME price-list id for every produto published under
 * that conta — a bulk-publish run or a sequence of retries re-resolves the
 * identical id repeatedly. Mirrors `contaCache.ts`'s `contaReader`, simplified:
 * no `isFresh` (there is no back-filled field to guard, unlike `integracao`'s
 * `user_id`), and no second cache — there is no query on this path, only a
 * doc get.
 *
 * ⚠️ None of the three forbidden cases applies (`firestore-read-cache` skill):
 * no `tx.get`, no read-modify-write, no token. This is a plain read-only doc
 * get feeding a display string — the price VALUE that actually gates publish
 * still comes from `produto.precos`, read fresh (uncached) on every publish.
 *
 * Invalidation: NOT needed. `listaDePrecos` is written ONLY by apps/web's
 * BROWSER client (the schema-driven CRUD screen at `/listas-de-precos`) — no
 * server-side writer exists anywhere in `apps/mercado-livre`,
 * `packages/integrations/mercado-livre` or `packages/data`, so there is no
 * self-write for a server process to evict. (Contrast `contaReader`, which
 * DOES export `invalidateConta` — one of `integracao`'s writers,
 * `exchangeAndPersist`, is server-side.)
 *
 * Staleness: `READ_CACHE_TTL.config` (15 min) — the tier for "config a human
 * edits once or twice a year", which is exactly what a price list's `nome` is.
 * A stale `nome` for up to 15 minutes after a rename costs nothing worse than
 * a cosmetically out-of-date label in an error message; it never changes
 * whether a publish is blocked.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { READ_CACHE_TTL, createCachedDocReader } from '@delfrance/data/admin/cache';
import { listaDePrecosCollection } from '@delfrance/data/admin/collections';
import type { ListaDePrecos } from '@delfrance/schemas';

/**
 * Injectable clock. `createReadCache` captures `opts.now` ONCE at construction
 * — import time, for a module-scope cache — so this binding goes through an
 * arrow (`now: () => nowFn()`) rather than handing over the reference, which
 * would freeze it. Mirrors `contaCache.ts`. Production never moves it.
 */
let nowFn: () => number = Date.now;

/**
 * `maxEntries: 64` — a leak guard, not a working-set limit (same reasoning as
 * `contaReader`): a deployment has a handful of price lists, well under this
 * bound, and exceeding it only costs a few extra misses via LRU eviction —
 * never incorrect behaviour.
 */
const listaDePrecosReader = createCachedDocReader(listaDePrecosCollection, {
  name: 'ml:lista-de-precos',
  ttlMs: READ_CACHE_TTL.config,
  maxEntries: 64,
  now: () => nowFn(),
  sampleEvery: 0,
});

/** The parsed price-list document, or `null` when it does not exist. */
export function readListaDePrecos(db: Firestore, id: string): Promise<ListaDePrecos | null> {
  return listaDePrecosReader.get(db, {}, id);
}

/**
 * Test-only. Mirrors `__setContaCacheClockForTests` — the cache is
 * module-scope, so `now` cannot be passed per test the normal way. Pair with
 * `__resetAllReadCaches()`.
 */
export function __setListaDePrecosCacheClockForTests(now: () => number = Date.now): void {
  nowFn = now;
}
