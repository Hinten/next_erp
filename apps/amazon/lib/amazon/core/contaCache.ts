/**
 * Process-scoped cache for the Amazon `integracao` document — the conta behind
 * every flow call. Used by `loadAmazonContext` ONLY.
 *
 * ⚠️ **Token-free by construction.** It reads `integracaoCollection` and nothing
 * else: the LWA credential lives in `integracao/{id}/credenciais/current`, which
 * is re-read UNCACHED on every request (`contexto.ts`). A cached credential
 * would replay a refused token for the whole TTL and is the first case
 * `@delfrance/data/admin/cache` forbids.
 *
 * ⚠️ **The routes, the callback and the sweep never come through here.** They
 * read the conta uncached (`contas.ts`), because each of them gates a write on
 * that read.
 *
 * Staleness: the conta's writers are the browser (every field but one) and the
 * OAuth callback (`selling_partner_id`), so `READ_CACHE_TTL.config` (15 min) IS
 * the bound on other instances. Three settings keep it harmless:
 *
 *  - `isFresh: ativo === true && selling_partner_id != null` — an INACTIVE or
 *    UNCONNECTED conta is never served from cache, so a reactivation or a first
 *    connect takes effect on the next call. The opposite edge — a deactivation
 *    — can lag up to the TTL on other warm instances (the Melhor Envio
 *    reasoning), and the context refuses it the moment the copy refreshes;
 *  - `negativeTtlMs: 0` — absence is never cached: a conta created a second ago
 *    must be found by the very next call;
 *  - the callback calls {@link invalidarContaEmCache} on its own instance after
 *    writing the seller id, and the intake task calls it before deciding a
 *    poll's irreversible `vendedor-mudou` drop, then reloads the context
 *    (`notificacoes/notificacao.ts`): a stale copy never drops a current poll.
 *    The backstop poll (step 4, `pedidos/pollPedidos.ts`) calls it before each
 *    conta's run: the seller its payloads carry, and its duplicate-seller
 *    check, must never come from a copy a reconnect left stale (a 15-minute
 *    tick would find the entry expired anyway).
 *
 * `sampleEvery: 0` — the built-in sampler logs through `console.warn`, the wrong
 * severity for a metric.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { READ_CACHE_TTL, createCachedDocReader } from '@delfrance/data/admin/cache';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import type { Integracao } from '@delfrance/schemas';

/**
 * Injectable clock. `createReadCache` captures `opts.now` once, at construction
 * — import time for a module-scope cache — so the reader goes through this
 * binding via an arrow. Production never moves it.
 */
let relogioDoCache: () => number = Date.now;

const contaReader = createCachedDocReader(integracaoCollection, {
  name: 'amazon:integracao',
  ttlMs: READ_CACHE_TTL.config,
  maxEntries: 16,
  isFresh: (conta) => conta.ativo === true && conta.selling_partner_id != null,
  negativeTtlMs: 0,
  now: () => relogioDoCache(),
  sampleEvery: 0,
});

/**
 * The parsed conta document, or `null` when it does not exist.
 *
 * ⚠️ No `tipo` check here — it replaces the read, not the contract. The
 * context loader keeps its own guard.
 */
export function lerContaEmCache(db: Firestore, integracaoId: string): Promise<Integracao | null> {
  return contaReader.get(db, {}, integracaoId);
}

/** Drop this conta's entry on THIS instance (other warm instances wait out the TTL). */
export function invalidarContaEmCache(integracaoId: string): void {
  contaReader.invalidate({}, integracaoId);
}

/**
 * Test-only. The cache is module-scope, so `now` cannot be passed per test.
 * Pair it with `__resetAllReadCaches()`.
 */
export function __setRelogioDoCacheParaTestes(now: () => number = Date.now): void {
  relogioDoCache = now;
}
