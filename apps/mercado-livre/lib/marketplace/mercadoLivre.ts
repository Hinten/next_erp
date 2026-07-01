/**
 * Resolve an `integracao` Mercado Livre account into a ready-to-use server
 * context: the plugin `MarketplaceChannel` (from `@delfrance/integrations-
 * mercado-livre`), the credential store (over the admin-only `credenciais`
 * subcollection, #287), and a `resolveChannelContext()` that builds the
 * `ChannelContext` every contract method consumes. Mirrors
 * apps/melhor-envio/lib/freight/melhorEnvio.ts, adapted to the marketplace
 * contract.
 *
 * NOTE (Phase 5): the actual ML token exchange + refresh are not implemented
 * yet — `exchangeAndPersist` and the refresh branch throw
 * `MercadoLivreNotImplementedError`. This scaffold wires the structure; the ML
 * REST calls land with the per-channel port.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type { ChannelContext, MarketplaceChannel } from '@delfrance/core/plugins';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import {
  type MercadoLivreConfig,
  createMercadoLivreChannel,
} from '@delfrance/integrations-mercado-livre';

import { type CredentialStore, createCredentialStore } from './tokenStore';

/** The account doc is missing, not a Mercado Livre tipo, or has no credentials. */
export class MercadoLivreContaNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MercadoLivreContaNotConfiguredError';
  }
}

/**
 * Server is misconfigured — the app-wide Mercado Livre OAuth credentials
 * (`MERCADO_LIVRE_CLIENT_ID` / `MERCADO_LIVRE_CLIENT_SECRET`) aren't set. These
 * identify the single registered ML application (one app, many connected
 * accounts), so they live in env / Cloud Secret Manager. Maps to HTTP 500.
 */
export class MercadoLivreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MercadoLivreConfigError';
  }
}

/** A Phase-5 ML REST operation that this scaffold does not implement yet. */
export class MercadoLivreNotImplementedError extends Error {
  constructor(operation: string) {
    super(`Mercado Livre "${operation}" ainda não implementado (Phase 5).`);
    this.name = 'MercadoLivreNotImplementedError';
  }
}

const CLIENT_SECRET_ENV_VAR = 'MERCADO_LIVRE_CLIENT_SECRET';
/** Refresh the token when it is within this window of expiring. */
const REFRESH_SKEW_MS = 60 * 1000;

/** The OAuth redirect URI — must match what's registered in the ML app. */
export function mercadoLivreRedirectUri(): string {
  const base = (process.env.MERCADO_LIVRE_PUBLIC_URL ?? 'http://localhost:3006').replace(/\/$/, '');
  return `${base}/api/oauth/mercado-livre/callback`;
}

/** App-wide ML application config (env / Secret Manager, never per-account). */
export function mercadoLivreConfig(): MercadoLivreConfig {
  const clientId = process.env.MERCADO_LIVRE_CLIENT_ID;
  const clientSecret = process.env[CLIENT_SECRET_ENV_VAR];
  if (!clientId || !clientSecret) {
    throw new MercadoLivreConfigError(
      'MERCADO_LIVRE_CLIENT_ID / MERCADO_LIVRE_CLIENT_SECRET não configurados no ambiente.',
    );
  }
  return {
    clientId,
    clientSecretEnvVar: CLIENT_SECRET_ENV_VAR,
    redirectUri: mercadoLivreRedirectUri(),
  };
}

export interface MercadoLivreContext {
  readonly integracaoId: string;
  readonly channel: MarketplaceChannel;
  readonly store: CredentialStore;
  /**
   * Build the live `ChannelContext` the contract methods consume: reads the
   * stored credential, refreshes it if near expiry, and packs the per-account
   * `account` bag. Throws `MercadoLivreContaNotConfiguredError` if the account
   * was never connected.
   */
  resolveChannelContext(now?: number): Promise<ChannelContext>;
  /** Exchange an authorization code and persist the resulting credential. */
  exchangeAndPersist(code: string): Promise<void>;
}

export async function loadMercadoLivreContext(
  db: Firestore,
  integracaoId: string,
): Promise<MercadoLivreContext> {
  const snap = await integracaoCollection.docRef(db, {}, integracaoId).get();
  if (!snap.exists) {
    throw new MercadoLivreContaNotConfiguredError(`Integração ${integracaoId} não encontrada.`);
  }
  const conta = integracaoCollection.parseRead(
    snap.data(),
    integracaoCollection.docPath({}, integracaoId),
  );
  if (conta.tipo !== INTEGRACAO_TIPO.mercadoLivre) {
    throw new MercadoLivreContaNotConfiguredError(
      `Integração ${integracaoId} não é do tipo Mercado Livre.`,
    );
  }

  const channel = createMercadoLivreChannel(mercadoLivreConfig());
  const store = createCredentialStore(db, integracaoId);

  // The per-account singularities (ML `user_id`, price tables, …) live on the
  // integracao doc (#289) and ride through `.passthrough()`. Pass them opaquely
  // in `account`; the plugin reads what it needs.
  const account: Readonly<Record<string, unknown>> = { user_id: extractUserId(conta) };

  return {
    integracaoId,
    channel,
    store,
    async resolveChannelContext(now: number = Date.now()): Promise<ChannelContext> {
      const cred = await store.load();
      if (!cred) {
        throw new MercadoLivreContaNotConfiguredError(
          `Integração ${integracaoId} não conectada (sem credencial). Conecte via OAuth primeiro.`,
        );
      }
      if (cred.expirationDate - now <= REFRESH_SKEW_MS) {
        // Phase 5: POST the ML token endpoint with the refresh_token, persist via
        // store.save (single-token), and continue with the new access_token.
        throw new MercadoLivreNotImplementedError('refresh de token');
      }
      return { integracaoId, accessToken: cred.access_token, account };
    },
    async exchangeAndPersist(_code: string): Promise<void> {
      // Phase 5: POST the ML token endpoint with the authorization code +
      // client_id/secret + redirect_uri, then store.save({ access_token,
      // refresh_token, expirationDate: now + expires_in * 1000 }).
      throw new MercadoLivreNotImplementedError('troca de código OAuth');
    },
  };
}

function extractUserId(conta: Record<string, unknown>): unknown {
  return conta.user_id ?? null;
}
