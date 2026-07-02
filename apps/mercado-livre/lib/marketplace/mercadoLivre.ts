/**
 * Resolve an `integracao` Mercado Livre account into a ready-to-use server
 * context: the plugin `MarketplaceChannel` (from `@delfrance/integrations-
 * mercado-livre`), the durable-token store (over the admin-only `tokenDuravel`
 * subcollection — the old Flutter wire shape, shared with the still-running
 * Flutter app during the dual-run migration), and a `resolveChannelContext()`
 * that builds the `ChannelContext` every contract method consumes, refreshing
 * the token (concurrency-safe) when it is near expiry. Mirrors
 * apps/melhor-envio/lib/freight/melhorEnvio.ts, adapted to the marketplace contract.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type { ChannelContext, MarketplaceChannel } from '@delfrance/core/plugins';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import {
  type MercadoLivreConfig,
  type MercadoLivreOAuthConfig,
  createMercadoLivreChannel,
  exchangeCode,
} from '@delfrance/integrations-mercado-livre';

import {
  type TokenDuravelStore,
  createTokenDuravelStore,
  getOrRefreshAccessToken,
  tokenDuravelFromResponse,
} from './tokenStore';

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

/** A ML operation still stubbed (webhook/functions processing, later steps). */
export class MercadoLivreNotImplementedError extends Error {
  constructor(operation: string) {
    super(`Mercado Livre "${operation}" ainda não implementado.`);
    this.name = 'MercadoLivreNotImplementedError';
  }
}

const CLIENT_SECRET_ENV_VAR = 'MERCADO_LIVRE_CLIENT_SECRET';

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

/**
 * App-wide OAuth config carrying the resolved `clientSecret`, for the token
 * exchange + refresh flow. Same env source as `mercadoLivreConfig()`.
 */
export function mercadoLivreOAuthConfig(): MercadoLivreOAuthConfig {
  const clientId = process.env.MERCADO_LIVRE_CLIENT_ID;
  const clientSecret = process.env[CLIENT_SECRET_ENV_VAR];
  if (!clientId || !clientSecret) {
    throw new MercadoLivreConfigError(
      'MERCADO_LIVRE_CLIENT_ID / MERCADO_LIVRE_CLIENT_SECRET não configurados no ambiente.',
    );
  }
  return { clientId, clientSecret, redirectUri: mercadoLivreRedirectUri() };
}

export interface MercadoLivreContext {
  readonly integracaoId: string;
  readonly channel: MarketplaceChannel;
  readonly store: TokenDuravelStore;
  /**
   * Build the live `ChannelContext` the contract methods consume: reads the
   * newest valid token (or refreshes it, concurrency-safe) and packs the
   * per-account `account` bag. Throws `MercadoLivreReauthRequiredError` when the
   * account must reconnect via OAuth.
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
  const oauthConfig = mercadoLivreOAuthConfig();
  const store = createTokenDuravelStore(db, integracaoId);

  // The per-account singularities (ML `user_id`, price tables, …) live on the
  // integracao doc (#289) and ride through `.passthrough()`. Pass them opaquely
  // in `account`; the plugin reads what it needs.
  const account: Readonly<Record<string, unknown>> = { user_id: extractUserId(conta) };

  return {
    integracaoId,
    channel,
    store,
    async resolveChannelContext(now: number = Date.now()): Promise<ChannelContext> {
      const accessToken = await getOrRefreshAccessToken(store, oauthConfig, { now });
      return { integracaoId, accessToken, account };
    },
    async exchangeAndPersist(code: string): Promise<void> {
      const resp = await exchangeCode(oauthConfig, code);
      await store.save(tokenDuravelFromResponse(resp, Date.now()));
    },
  };
}

function extractUserId(conta: Record<string, unknown>): unknown {
  return conta.user_id ?? null;
}
