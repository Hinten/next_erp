/**
 * Resolve an `int_frete` Melhor Envio account into a ready-to-use server
 * context: the OAuth config (from the doc's `client_id`/`client_secret`
 * plus env), the Firestore token store, and an API client whose
 * `getAccessToken` runs `getOrRefreshAccessToken` (60s skew, single-token
 * refresh, re-auth on a dead refresh token).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { intFreteCollection } from '@delfrance/data/admin/collections';
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

const DEFAULT_USER_AGENT = '@delfrance/erp-next (contato@delfrance.com.br)';

/** Sandbox unless `MELHOR_ENVIO_SANDBOX=false` is set (prod must opt out). */
function isSandbox(): boolean {
  return process.env.MELHOR_ENVIO_SANDBOX !== 'false';
}

/** The OAuth redirect URI — must match what's registered in the ME app. */
export function melhorEnvioRedirectUri(): string {
  const base = (process.env.INTEGRATIONS_PUBLIC_URL ?? 'http://localhost:3001').replace(/\/$/, '');
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

export async function loadMelhorEnvioContext(
  db: Firestore,
  intFreteId: string,
): Promise<MelhorEnvioContext> {
  const snap = await intFreteCollection.docRef(db, {}, intFreteId).get();
  if (!snap.exists) {
    throw new MelhorEnvioContaNotConfiguredError(
      `Integração de frete ${intFreteId} não encontrada.`,
    );
  }
  const conta = intFreteCollection.parseRead(
    snap.data(),
    intFreteCollection.docPath({}, intFreteId),
  );
  if (conta.tipo !== 'melhorEnvios') {
    throw new MelhorEnvioContaNotConfiguredError(
      `Integração ${intFreteId} não é do tipo Melhor Envio.`,
    );
  }
  if (!conta.client_id || !conta.client_secret) {
    throw new MelhorEnvioContaNotConfiguredError(
      'Configure Client ID e Secret na integração antes de conectar.',
    );
  }

  const oauthConfig: OAuthConfig = {
    baseUrl: melhorEnvioBaseUrl(isSandbox()),
    clientId: conta.client_id,
    clientSecret: conta.client_secret,
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
