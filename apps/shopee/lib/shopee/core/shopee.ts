/**
 * Resolve an `integracao` account into a ready-to-use Shopee server context:
 * the conta document, the partner configuration read from the environment, a
 * fresh read of the stored credential, and the code-exchange-and-persist step
 * the OAuth callback drives.
 *
 * Shaped on `apps/melhor-envio/lib/freight/melhorEnvio.ts`.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { READ_CACHE_TTL, createCachedDocReader } from '@delfrance/data/admin/cache';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { INTEGRACAO_TIPO, type CredenciaisIntegracao, type Integracao } from '@delfrance/schemas';
import {
  type ShopeeAuthSubject,
  type ShopeeOAuthConfig,
  exchangeCode,
} from '@delfrance/integrations-shopee';

import { type ShopeeConfig, shopeeConfig } from '../env';
import { createShopeeCredentialStore, credentialFromTokenPair } from './credentialStore';

/** The account doc is missing or is not a Shopee conta. Maps to HTTP 404. */
export class ShopeeContaNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopeeContaNotConfiguredError';
  }
}

export interface ShopeeContext {
  readonly integracaoId: string;
  readonly conta: Integracao;
  readonly config: ShopeeConfig;
  /**
   * The stored credential, read FRESH on every call — never cached.
   * See the cache docblock below for why.
   */
  readCredential(): Promise<CredenciaisIntegracao | null>;
  /** Exchange a consent `code` and persist the resulting pair. */
  exchangeAndPersist(code: string, subject: ShopeeAuthSubject, now?: number): Promise<void>;
}

/**
 * Injectable clock. `createReadCache` captures `opts.now` ONCE at construction,
 * which for a module-scope cache is import time — so the reader below reads this
 * binding through an arrow rather than handing over the reference, which would
 * freeze it. Production never moves it.
 */
let cacheClock: () => number = Date.now;

/**
 * The `integracao` document behind every Shopee call.
 *
 * ⚠️ **None of the three forbidden cases applies** (`@delfrance/data/admin/cache`):
 *
 *  - **No `tx.get`.** Nothing here runs inside a transaction.
 *  - **No read-modify-write.** `exchangeAndPersist` does not derive its patch
 *    from this document: `shop_id` / `main_account_id` come from the CALLBACK's
 *    own query parameters, and the cache is evicted immediately after the write.
 *  - **No token.** The OAuth credential lives in the `credenciais`
 *    subcollection and `readCredential()` below is an uncached `get` on every
 *    single call. Caching an OAuth token is the case the primitive names first.
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
 *
 * ℹ️ Inline rather than extracted, ME-style. When step 3 adds a second reader
 * (the receiver resolving a conta by `shop_id`), move both into
 * `lib/shopee/core/contaCache.ts` the way `apps/mercado-livre` did.
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

/** Drop the cached conta — call after any write that changes it. */
export function invalidateShopeeConta(integracaoId: string): void {
  contaReader.invalidate({}, integracaoId);
}

/**
 * Test-only. The cache is module-scope and captures `now` at construction, so
 * the clock is swapped through this binding rather than passed per call. Pair it
 * with `__resetAllReadCaches()`.
 */
export function __setShopeeCacheClockForTests(now: () => number = Date.now): void {
  cacheClock = now;
}

/** The package's OAuth config, from ours. Kept in one place so it cannot drift. */
function oauthConfigFrom(config: ShopeeConfig): ShopeeOAuthConfig {
  return { partnerId: config.partnerId, partnerKey: config.partnerKey, hosts: config.hosts };
}

export async function loadShopeeContext(
  db: Firestore,
  integracaoId: string,
): Promise<ShopeeContext> {
  // The cached reader replaces the READ, not the contract — both throws below
  // are unchanged, and a `null` stands in for `!snap.exists`.
  const conta = await contaReader.get(db, {}, integracaoId);
  if (conta == null) {
    throw new ShopeeContaNotConfiguredError(`Integração ${integracaoId} não encontrada.`);
  }
  if (conta.tipo !== INTEGRACAO_TIPO.shopee) {
    throw new ShopeeContaNotConfiguredError(`Integração ${integracaoId} não é do tipo Shopee.`);
  }

  // Throws `ShopeeConfigError` naming the missing variable. Called here so an
  // unconfigured backend answers 500 on OUR side rather than `error_sign` at
  // Shopee — and, in `oauth/start`, before any state is minted.
  const config = shopeeConfig();
  const store = createShopeeCredentialStore(db, integracaoId);

  return {
    integracaoId,
    conta,
    config,

    async readCredential(): Promise<CredenciaisIntegracao | null> {
      return store.load();
    },

    async exchangeAndPersist(
      code: string,
      subject: ShopeeAuthSubject,
      now: number = Date.now(),
    ): Promise<void> {
      const pair = await exchangeCode(oauthConfigFrom(config), code, subject);

      // ⚠️ ORDER IS LOAD-BEARING: the credential FIRST, the denorm second.
      //
      // The consent `code` is single-use, so a failure after Shopee has minted
      // the pair costs a re-consent. If the denorm landed first and the
      // credential write then failed, the conta would advertise a `shop_id` it
      // has no token for — and `isFresh` above would happily serve that
      // document from cache. The other order is recoverable: the credential
      // exists, the denorm is retried by the next connect.
      await store.save(credentialFromTokenPair(pair, subject, now));

      // ⚠️ `mergeIfExists`, never `merge`. `merge` is an UPSERT and
      // `parseMerge` fills no schema defaults, so a conta deleted mid-consent
      // would be recreated as a GHOST carrying only these keys and no `tipo` —
      // which `isFresh` would then accept forever once `shop_id` is set.
      //
      // ⚠️ Only the field the subject actually carries is written. Writing both
      // (with a `null` for the absent one) would wipe a previously stored
      // `main_account_id` on every shop-scoped reconnect — a silent loss, for
      // no gain: the callback knows exactly one of the two.
      const patch: Record<string, unknown> =
        subject.kind === 'shop'
          ? { shop_id: subject.shopId }
          : { main_account_id: subject.mainAccountId };
      const existia = await integracaoCollection.mergeIfExists(db, {}, integracaoId, patch);
      if (!existia) {
        // Logged, not thrown: the credential is already stored and the consent
        // succeeded. Failing here would tell the operator to reconnect, which
        // cannot fix a deleted document.
        console.warn(
          '[shopee/context] integração removida durante o consentimento; denormalização ignorada',
          { integracaoId },
        );
      }

      invalidateShopeeConta(integracaoId);
    },
  };
}
