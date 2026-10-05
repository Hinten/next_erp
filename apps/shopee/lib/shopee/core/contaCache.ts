/**
 * Process-scoped cache for the Shopee `integracao` document, and for the
 * `shop_id → integração id` lookup the push receiver and the weekly
 * authorization-expiry sweep both resolve on.
 *
 * Extracted from `core/shopee.ts`, which said so in a note: the reader was
 * inline while one module read it, and step 3 added the second reader. Both must
 * be ONE instance to collapse — the sweep resolves a shop id and then reads the
 * very conta that lookup named, and separate caches would not share.
 *
 * ⚠️ **Token-free by construction.** Nothing here touches
 * `integracao/{id}/credenciais`: it reads the `integracao` document and queries
 * that same collection, and both readers hand back a parsed `Integracao`, never
 * a credential. That is not a convention — an OAuth token is the first case
 * `@delfrance/data/admin/cache` forbids, and Shopee's refresh token is
 * single-use and rotating, so a cached copy turns a survivable race into a burnt
 * pair. `readCredential()` in `core/shopee.ts` stays an uncached `get` on every
 * call, and the sweep never asks for one at all.
 *
 * ⚠️ The other two forbidden cases do not apply either. **No `tx.get`** — every
 * entry point takes a `Firestore`. **No read-modify-write**: the one server-side
 * writer of this document is `exchangeAndPersist`, whose patch comes from the
 * OAuth callback's own query parameters rather than from this read, and which
 * evicts through {@link invalidateShopeeConta} immediately after writing.
 *
 * Staleness: instances do not coordinate, so `READ_CACHE_TTL.config` (15 min) IS
 * the bound. The drift that is NOT benign is handled by the cross-check inside
 * {@link findIntegracaoByShopId}.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  READ_CACHE_TTL,
  createCachedDocReader,
  createReadCache,
} from '@delfrance/data/admin/cache';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { INTEGRACAO_TIPO, type Integracao } from '@delfrance/schemas';

/**
 * Injectable clock. `createReadCache` captures `opts.now` ONCE at construction,
 * which for a module-scope cache is import time — so the caches below read this
 * binding through an arrow rather than handing over the reference, which would
 * freeze it. Production never moves it.
 */
let cacheClock: () => number = Date.now;

/**
 * The `integracao` document behind every Shopee call.
 *
 * `isFresh: conta.shop_id != null` — a conta that has never completed the
 * consent has no `shop_id`, and `exchangeAndPersist` back-fills it on a
 * DIFFERENT instance from the ones that will read it. Refusing such a document
 * on every hit is what makes a 15-minute TTL safe, and it costs nothing once the
 * field is set.
 *
 * ⚠️ It is deliberately NOT `main_account_id != null`: a shop-scoped consent
 * (the normal BR case) never sets that field, so the predicate would refuse
 * every hit forever for a perfectly connected conta.
 *
 * `negativeTtlMs: 0` — an absent document means an operator deleted the
 * integração; caching that wins nothing and only delays the recovery.
 *
 * `sampleEvery: 0` — the built-in sampler logs through `console.warn`, the wrong
 * severity for a metric, and at its default of 500 an instance serving fewer
 * gets logs nothing at all.
 */
const contaReader = createCachedDocReader(integracaoCollection, {
  name: 'shopee:integracao',
  ttlMs: READ_CACHE_TTL.config,
  maxEntries: 64,
  isFresh: (conta) => conta.shop_id != null,
  negativeTtlMs: 0,
  now: () => cacheClock(),
  sampleEvery: 0,
});

/**
 * Shopee `shop_id` → the active conta's id: the three-predicate query paid once
 * per inbound push and once per shop enumerated by the weekly sweep.
 *
 * ⚠️ The key is `[shopId]` ALONE because the query's other two predicates are
 * constants (`tipo == shopee`, `ativo == true`). If either ever becomes a
 * variable it MUST join the key — omitting a predicate value is the one way to
 * get a wrong hit.
 *
 * `negativeTtlMs: 0` — an unmapped `shop_id` is what the receiver turns into a
 * DEFERRED notification, re-driven once a day rather than once a sweep interval,
 * and what makes the sweep skip a shop entirely. An operator who connects the
 * conta seconds later must be found by the very next delivery, so absence is
 * never cached.
 */
const integracaoByShopId = createReadCache<readonly [number], string | null>({
  name: 'shopee:integracao-by-shop-id',
  ttlMs: READ_CACHE_TTL.config,
  maxEntries: 64,
  negativeTtlMs: 0,
  now: () => cacheClock(),
  sampleEvery: 0,
});

/** The parsed conta document, or `null` when it does not exist. */
export function readConta(db: Firestore, integracaoId: string): Promise<Integracao | null> {
  return contaReader.get(db, {}, integracaoId);
}

/**
 * Drop this conta's cached entry — call it right after writing the document from
 * this process. Covers THIS instance only; other warm instances stay stale until
 * the TTL, which is what `isFresh` and the cross-check below are for.
 */
export function invalidateShopeeConta(integracaoId: string): void {
  contaReader.invalidate({}, integracaoId);
}

/**
 * The uncached query. `tipo == shopee`, the denormalized `shop_id`, and `ativo`
 * — an inactive integração must not claim a shop's pushes.
 *
 * ⚠️ Enterprise auto-creates no index and does not fail an unindexed query: it
 * silently full-scans and bills data scanned. The matching composite
 * `integracao (tipo ASC, shop_id ASC, ativo ASC)` ships with this step and is
 * deployed in the migration window.
 *
 * A transient Firestore failure propagates (throws) so the caller treats it as
 * retryable; `null` means "no active Shopee integração names this shop", which
 * is a normal answer.
 */
async function consultarIntegracaoPorShopId(db: Firestore, shopId: number): Promise<string | null> {
  const snap = await integracaoCollection
    .ref(db, {})
    .where('tipo', '==', INTEGRACAO_TIPO.shopee)
    .where('shop_id', '==', shopId)
    .where('ativo', '==', true)
    .limit(1)
    .get();
  return snap.docs[0]?.id ?? null;
}

/**
 * The cached `shop_id` resolve, cross-checked against the conta it names.
 *
 * `shop_id` changes exactly once in a conta's life that matters here: when the
 * operator reconnects the same integração to a DIFFERENT shop. `isFresh` cannot
 * see that — a stale copy still has `shop_id != null`, so it passes — and only
 * the instance that ran the OAuth callback can evict. On every OTHER warm
 * instance the stale mapping would make this app act on one shop's event under
 * another shop's conta.
 *
 * The fix is free: the caller carries the AUTHORITATIVE shop id (a push names
 * it; the sweep read it from `get_shops_by_partner`), so a cached conta whose
 * `shop_id` disagrees is provably stale. On disagreement both entries are
 * dropped — the query's predicate IS `shop_id == shopId`, so it is stale too —
 * and the query re-runs once. Bounded by construction: one eviction, one retry,
 * no loop.
 *
 * ⚠️ A DELETED conta is the same staleness and is treated the same way. Handing
 * back an id whose document is gone would make the caller's context loader throw
 * `ShopeeContaNotConfiguredError`, which the pipeline reads as retryable and
 * eventually persists as a failure — strictly worse than not caching, since the
 * uncached query resolves `null` and the delivery goes to the deferred lane
 * instead. Deletion arrives from `apps/web`'s BROWSER client, so no server-side
 * evict can front-run it and this check is the only guard.
 *
 * In steady state this costs one cache hit and PRE-WARMS the conta entry the
 * caller needs microseconds later.
 */
export async function findIntegracaoByShopId(
  db: Firestore,
  shopId: number,
): Promise<string | null> {
  const consultar = (): Promise<string | null> => consultarIntegracaoPorShopId(db, shopId);

  const id = await integracaoByShopId.get([shopId], consultar);
  if (id == null) return null;

  const conta = await contaReader.get(db, {}, id);
  if (conta != null && conta.shop_id === shopId) return id;

  integracaoByShopId.invalidate([shopId]);
  contaReader.invalidate({}, id);
  return integracaoByShopId.get([shopId], consultar);
}

/**
 * Test-only. The caches are module-scope — they must be, since a per-request
 * cache never hits — so `now` cannot be passed per test the way the primitive's
 * own suites do. Pair it with `__resetAllReadCaches()`.
 */
export function __setShopeeCacheClockForTests(now: () => number = Date.now): void {
  cacheClock = now;
}
