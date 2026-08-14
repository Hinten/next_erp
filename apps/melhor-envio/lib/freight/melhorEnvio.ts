/**
 * Resolve an `int_frete` Melhor Envio account into a ready-to-use server
 * context: the OAuth config (from the doc's `client_id`/`client_secret`
 * plus env), the Firestore token store, and an API client whose
 * `getAccessToken` runs `getOrRefreshAccessToken` (60s skew, single-token
 * refresh, re-auth on a dead refresh token).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { READ_CACHE_TTL, createCachedDocReader } from '@delfrance/data/admin/cache';
import { intFreteCollection } from '@delfrance/data/admin/collections';
import { INTEGRACAO_FRETE } from '@delfrance/schemas';
import {
  type MelhorEnvioApi,
  type OAuthConfig,
  type StoredToken,
  type TokenStore,
  createMelhorEnvioApi,
  exchangeCode,
  getOrRefreshAccessToken,
  melhorEnvioBaseUrl,
  refreshAccessToken,
  storedTokenFromResponse,
} from '@delfrance/integrations-freight-br';

import { createFirestoreTokenStore } from './tokenStore';

/** The account doc is missing, not a Melhor Envio tipo, or has no credentials. */
export class MelhorEnvioContaNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MelhorEnvioContaNotConfiguredError';
  }
}

/**
 * Server is misconfigured — the app-wide Melhor Envio OAuth credentials
 * (`MELHOR_ENVIO_CLIENT_ID` / `MELHOR_ENVIO_CLIENT_SECRET`) aren't set. These
 * identify the single registered ME application (one app, many connected
 * accounts), so they live in env / Cloud Secret Manager, not per-integration.
 * Maps to HTTP 500.
 */
export class MelhorEnvioConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MelhorEnvioConfigError';
  }
}

const DEFAULT_USER_AGENT = '@delfrance/erp-next (contato@delfrance.com.br)';

/** Sandbox unless `MELHOR_ENVIO_SANDBOX=false` is set (prod must opt out). */
function isSandbox(): boolean {
  return process.env.MELHOR_ENVIO_SANDBOX !== 'false';
}

/**
 * The OAuth redirect URI — must match what's registered in the ME app.
 *
 * ⚠️ A BLANK `MELHOR_ENVIO_PUBLIC_URL=` must fall back like an unset one. The old
 * `??` guarded only `undefined`/`null`, so a blank value produced `base === ''` and
 * sent the relative `"/api/oauth/melhor-envio/callback"` to ME as the `redirect_uri`
 * — which ME rejects as a mismatch, silently, since nothing on this path logged.
 * Same `??`-versus-empty-string hole #887 fixed for `*_TASKS_REGION`.
 *
 * The localhost default stays: local dev has no public origin. It is also why a
 * misconfigured deployed backend fails at ME rather than at boot — hence the value
 * being echoed in the callback's failure log.
 */
export function melhorEnvioRedirectUri(): string {
  const raw = process.env.MELHOR_ENVIO_PUBLIC_URL?.trim();
  const base = (raw && raw.length > 0 ? raw : 'http://localhost:3005').replace(/\/$/, '');
  return `${base}/api/oauth/melhor-envio/callback`;
}

export interface MelhorEnvioContext {
  readonly intFreteId: string;
  readonly oauthConfig: OAuthConfig;
  readonly store: TokenStore;
  readonly api: MelhorEnvioApi;
  /** Exchange an authorization code and persist the resulting token. */
  exchangeAndPersist(code: string, now?: number): Promise<StoredToken>;
}

/** Test-only clock indirection; see `__setMelhorEnvioCacheClockForTests`. */
let cacheClock: () => number = Date.now;

/**
 * The `int_frete` config document behind every freight call.
 *
 * The repeat: `app/api/freight/melhor-envio/calculate/route.ts` re-reads it on
 * every quote — one per freight recalculation in the pedido form, so an operator
 * adjusting a package weight issues a burst of identical reads. Seven more
 * routes read it once each.
 *
 * ⚠️ None of the three forbidden cases applies, and this is the cleanest
 * adoption in the repo. No transactional read. No read-modify-write: nothing in
 * this app writes `int_frete` at all — every write goes to the `tokenMelEnv`
 * SUBCOLLECTION or to a pedido. No token: the OAuth credential lives in that
 * subcollection and still goes through `createFirestoreTokenStore` uncached on
 * every request.
 *
 * The one cross-app writer of `int_frete` is the ML int_frete sync, but it only
 * ever touches `tipo === mercadoLivre` documents, which the guard below rejects
 * — so it cannot poison this cache. The operator CRUD screen lives in a browser,
 * a different process, so there is nothing to evict there and the TTL is the
 * bound.
 *
 * No `isFresh`: the loader reads exactly one field of this document (`tipo`),
 * and no writer in the repo changes it. A predicate here would be cargo cult.
 *
 * `maxEntries: 16` — realistically one melhorEnvios document per tenant; this
 * is a memory guard with ~10x headroom, not a tuning knob.
 */
const intFreteReader = createCachedDocReader(intFreteCollection, {
  name: 'me:int-frete',
  ttlMs: READ_CACHE_TTL.config,
  maxEntries: 16,
  // Absence means an operator deleted the integration — never the steady state,
  // so caching it wins nothing and only delays the recovery.
  negativeTtlMs: 0,
  now: () => cacheClock(),
});

/**
 * Test-only. The cache is module-scope, and `createReadCache` captures `now`
 * once at construction, so the clock is swapped through this binding rather than
 * passed per test. Pair it with `__resetAllReadCaches()`.
 */
export function __setMelhorEnvioCacheClockForTests(now: () => number = Date.now): void {
  cacheClock = now;
}

export async function loadMelhorEnvioContext(
  db: Firestore,
  intFreteId: string,
): Promise<MelhorEnvioContext> {
  // The cached reader replaces the READ, not the contract — both throws below
  // are unchanged, and a `null` stands in for `!snap.exists`.
  const conta = await intFreteReader.get(db, {}, intFreteId);
  if (conta == null) {
    throw new MelhorEnvioContaNotConfiguredError(
      `Integração de frete ${intFreteId} não encontrada.`,
    );
  }
  if (conta.tipo !== INTEGRACAO_FRETE.melhorEnvios) {
    throw new MelhorEnvioContaNotConfiguredError(
      `Integração ${intFreteId} não é do tipo Melhor Envio.`,
    );
  }
  // App-wide ME application credentials — one registered ME app serves every
  // connected account (each integration stores its own OAuth token). Read from
  // env (Cloud Secret Manager in prod), never per-integration.
  const clientId = process.env.MELHOR_ENVIO_CLIENT_ID;
  const clientSecret = process.env.MELHOR_ENVIO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new MelhorEnvioConfigError(
      'MELHOR_ENVIO_CLIENT_ID / MELHOR_ENVIO_CLIENT_SECRET não configurados no ambiente.',
    );
  }

  const oauthConfig: OAuthConfig = {
    baseUrl: melhorEnvioBaseUrl(isSandbox()),
    clientId,
    clientSecret,
    redirectUri: melhorEnvioRedirectUri(),
    userAgent: process.env.MELHOR_ENVIO_USER_AGENT ?? DEFAULT_USER_AGENT,
  };

  const store = createFirestoreTokenStore(db, intFreteId);

  const api = createMelhorEnvioApi({
    baseUrl: oauthConfig.baseUrl,
    userAgent: oauthConfig.userAgent,
    getAccessToken: async () => {
      const token = await getOrRefreshAccessToken({
        store,
        refresh: (rt) => refreshAccessToken(oauthConfig, rt),
      });
      return token.access_token;
    },
  });

  return {
    intFreteId,
    oauthConfig,
    store,
    api,
    async exchangeAndPersist(code: string, now: number = Date.now()): Promise<StoredToken> {
      const resp = await exchangeCode(oauthConfig, code);
      return store.save(storedTokenFromResponse(resp, now));
    },
  };
}
