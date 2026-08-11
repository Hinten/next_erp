/**
 * Resolve a `metodo_pgto` Mercado Pago account into a ready-to-use server
 * context: the app-wide OAuth config (env / Secret Manager), the single-token
 * credential store (over the admin-only `metodo_pgto/{id}/credenciais`
 * subcollection), and the flows the routes drive — the consent URL, a
 * `resolveAccessToken()` that refreshes on expiry (persisting MP's rotated
 * refresh token), and `exchangeAndPersist()` for the OAuth callback. Mirrors
 * apps/mercado-livre/lib/marketplace/mercadoLivre.ts, adapted to the payments
 * (metodo_pgto) domain.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { TIPO_INTEGRACAO_PGTO } from '@delfrance/schemas';
import { metodoPagamentoCollection } from '@delfrance/data/admin/collections';
import {
  type MercadoPagoOAuthConfig,
  MercadoPagoReauthRequiredError,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
} from '@delfrance/integrations-mercado-pago';

import {
  type CredentialStore,
  createCredentialStore,
  credentialFromResponse,
} from './credentialStore';
import { invalidateMercadoPagoMetodo, readMercadoPagoMetodo } from './metodoCache';

/** The account doc is missing, not a Mercado Pago tipo, or has no credentials. */
export class MercadoPagoContaNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MercadoPagoContaNotConfiguredError';
  }
}

/**
 * Server is misconfigured — the app-wide Mercado Pago OAuth credentials
 * (`MERCADO_PAGO_CLIENT_ID` / `MERCADO_PAGO_CLIENT_SECRET`) aren't set. These
 * identify the single registered MP application (one app, many connected
 * accounts), so they live in env / Cloud Secret Manager, not per-account.
 * Maps to HTTP 500.
 */
export class MercadoPagoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MercadoPagoConfigError';
  }
}

/** Refresh a credential this close to (or past) its expiry, never mid-flight. */
export const REFRESH_SKEW_MS = 60_000;

/** The OAuth redirect URI — must match what's registered in the MP app. */
export function mercadoPagoRedirectUri(): string {
  const base = (process.env.MERCADO_PAGO_PUBLIC_URL ?? 'http://localhost:3007').replace(/\/$/, '');
  return `${base}/api/oauth/mercado-pago/callback`;
}

/**
 * App-wide OAuth config carrying the resolved `clientSecret`, for the consent
 * URL + token exchange/refresh flow. Read from env (Cloud Secret Manager in
 * prod), never per-account.
 */
export function mercadoPagoOAuthConfig(): MercadoPagoOAuthConfig {
  const clientId = process.env.MERCADO_PAGO_CLIENT_ID;
  const clientSecret = process.env.MERCADO_PAGO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new MercadoPagoConfigError(
      'MERCADO_PAGO_CLIENT_ID / MERCADO_PAGO_CLIENT_SECRET não configurados no ambiente.',
    );
  }
  return { clientId, clientSecret, redirectUri: mercadoPagoRedirectUri() };
}

export interface MercadoPagoContext {
  readonly metodoId: string;
  /** The parsed metodo_pgto doc (extra fields ride through). */
  readonly conta: Readonly<Record<string, unknown>>;
  readonly store: CredentialStore;
  /** Build the MP consent URL for this account, embedding the signed `state`. */
  authorizeUrl(state: string): string;
  /**
   * The live access token: the stored one while comfortably valid, or a freshly
   * refreshed one (persisting MP's rotated refresh token). Throws
   * `MercadoPagoReauthRequiredError` when there is no usable credential or the
   * refresh grant is dead (the account must reconnect via OAuth).
   */
  resolveAccessToken(now?: number): Promise<string>;
  /** Exchange an authorization code and persist the resulting credential. */
  exchangeAndPersist(code: string, now?: number): Promise<void>;
}

export async function loadMercadoPagoContext(
  db: Firestore,
  metodoId: string,
): Promise<MercadoPagoContext> {
  // The cached reader replaces the READ, not the contract — both throws below
  // are unchanged, and a `null` stands in for `!snap.exists`. See
  // `metodoCache.ts` for why the cache is a separate module.
  const conta = await readMercadoPagoMetodo(db, metodoId);
  if (conta == null) {
    throw new MercadoPagoContaNotConfiguredError(`Método de pagamento ${metodoId} não encontrado.`);
  }
  if (conta.tipo !== TIPO_INTEGRACAO_PGTO.mercadoPago) {
    throw new MercadoPagoContaNotConfiguredError(
      `Método de pagamento ${metodoId} não é do tipo Mercado Pago.`,
    );
  }

  const oauthConfig = mercadoPagoOAuthConfig();
  const store = createCredentialStore(db, metodoId);

  return {
    metodoId,
    conta,
    store,
    authorizeUrl(state: string): string {
      return buildAuthorizeUrl({
        clientId: oauthConfig.clientId,
        redirectUri: oauthConfig.redirectUri,
        state,
      });
    },
    async resolveAccessToken(now: number = Date.now()): Promise<string> {
      const cred = await store.load();
      if (!cred) {
        throw new MercadoPagoReauthRequiredError(
          'no_token',
          'Conta Mercado Pago não conectada. Conecte via OAuth primeiro.',
        );
      }
      if (now < cred.expirationDate - REFRESH_SKEW_MS) {
        return cred.access_token; // still comfortably valid
      }
      // Near/past expiry: trade the (rotating, single-use) refresh token for a
      // fresh pair. `refreshAccessToken` throws MercadoPagoReauthRequiredError
      // on invalid_grant → the account must reconnect.
      const resp = await refreshAccessToken(oauthConfig, cred.refresh_token);
      const fresh = credentialFromResponse(resp, now);
      await store.save(fresh);
      return fresh.access_token;
    },
    async exchangeAndPersist(code: string, now: number = Date.now()): Promise<void> {
      const resp = await exchangeCode(oauthConfig, code);
      await store.save(credentialFromResponse(resp, now));
      // Denormalize the MP collector id (the seller's numeric user_id) onto the
      // metodo_pgto doc so an inbound webhook resolves this account with a single
      // equality query (mirrors `integracaoSchema.user_id`). Merge-only: never
      // touches other fields.
      if (resp.user_id != null) {
        await metodoPagamentoCollection.merge(db, {}, metodoId, { user_id: resp.user_id });
        // This process just wrote the document it caches. The merge also changes
        // the collector query's own predicate and flips the v1 scan's answer, so
        // those entries go too.
        invalidateMercadoPagoMetodo(metodoId, resp.user_id);
      }
    },
  };
}
