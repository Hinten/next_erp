/**
 * Only derived access tokens live here. Refresh credentials and every query in
 * the refresh/recheck/loser-recovery algorithm always come from Firestore.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { createReadCache, READ_CACHE_TTL } from '@delfrance/data/admin/cache';
import {
  type MercadoLivreOAuthConfig,
  MercadoLivreReauthRequiredError,
} from '@delfrance/integrations-mercado-livre';

import {
  type AccessTokenWithExpiry,
  type GetOrRefreshOpts,
  type TokenDuravelStore,
  getOrRefreshAccessTokenWithExpiry,
  REFRESH_SKEW_MS,
} from './tokenStore';

export type AccessTokenScope = readonly [
  firestoreNamespace: string,
  databaseId: string,
  clientId: string,
  integracaoId: string,
];

// A handle identifies its project/database without reading private SDK fields.
const firestoreNamespaces = new WeakMap<Firestore, string>();
let nextFirestoreNamespace = 0;

let nowFn: () => number = () => Date.now();

const accessTokens = createReadCache<AccessTokenScope, AccessTokenWithExpiry>({
  name: 'ml:access-token',
  ttlMs: READ_CACHE_TTL.volatile,
  maxEntries: 64,
  negativeTtlMs: 0,
  isFresh: (token) => token.expiresAt > nowFn() + REFRESH_SKEW_MS,
  now: () => nowFn(),
  sampleEvery: 0,
});

export function accessTokenScope(
  db: Firestore,
  clientId: string,
  integracaoId: string,
): AccessTokenScope {
  let namespace = firestoreNamespaces.get(db);
  if (namespace === undefined) {
    nextFirestoreNamespace += 1;
    namespace = String(nextFirestoreNamespace);
    firestoreNamespaces.set(db, namespace);
  }
  return [namespace, db.databaseId, clientId, integracaoId];
}

/** A delayed 401 for an old token must leave its replacement alone. */
export function invalidateCachedAccessToken(scope: AccessTokenScope, rejectedToken?: string): void {
  accessTokens.invalidate(
    scope,
    rejectedToken === undefined ? undefined : (token) => token.accessToken === rejectedToken,
  );
}

/** Validate every return, including new loads and shared in-flight promises. */
export async function getCachedAccessToken(
  scope: AccessTokenScope,
  store: TokenDuravelStore,
  config: MercadoLivreOAuthConfig,
  opts: GetOrRefreshOpts = {},
): Promise<string> {
  const startedAt = nowFn();
  // Preserve the explicit-now seam while still accounting for time spent in I/O.
  const currentTime = () =>
    opts.now === undefined ? nowFn() : opts.now + Math.max(0, nowFn() - startedAt);
  const skewMs = opts.skewMs ?? REFRESH_SKEW_MS;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await accessTokens.get(scope, () =>
      getOrRefreshAccessTokenWithExpiry(store, config, { ...opts, now: currentTime() }),
    );
    if (token.expiresAt > currentTime() + skewMs) return token.accessToken;
    invalidateCachedAccessToken(scope, token.accessToken);
  }

  throw new MercadoLivreReauthRequiredError(
    'refresh_failed',
    'Token do Mercado Livre expirou durante a consulta. Tente novamente.',
  );
}

/** Injectable clock for deterministic expiry/TTL tests; reset after each test. */
export function __setAccessTokenCacheClockForTests(clock?: () => number): void {
  nowFn = clock ?? (() => Date.now());
}
