/**
 * Resolve an `integracao` Mercado Livre account into a ready-to-use server
 * context: the durable-token store (over the admin-only `tokenDuravel`
 * subcollection — the old Flutter wire shape, which is how the migrated corpus
 * stores the credential) plus a `resolveChannelContext()` that builds the
 * `ChannelContext` every ML operation consumes, refreshing the token
 * (concurrency-safe) when it is near expiry. Mirrors
 * apps/melhor-envio/lib/freight/melhorEnvio.ts.
 *
 * ⚠️ It no longer carries a `channel` object. `createMercadoLivreChannel` was
 * deleted in #815: three of its four required members threw, and the single
 * member anything ever called (`oauthFlow.start`) is a wrapper around
 * `buildAuthorizeUrl`, which the connect route now calls directly. What the
 * channel supports is declared in `MARKETPLACE_TIPO_CAPS`
 * (`@delfrance/schemas`), not discovered by probing an object.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type { ChannelContext } from '@delfrance/core/marketplace';
import { INTEGRACAO_TIPO, type Integracao } from '@delfrance/schemas';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { type MercadoLivreOAuthConfig, exchangeCode } from '@delfrance/integrations-mercado-livre';

import { invalidateConta, readConta } from './contaCache';
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

/**
 * The OAuth redirect URI — must match what's registered in the ML app.
 *
 * ⚠️ A BLANK `MERCADO_LIVRE_PUBLIC_URL=` must fall back like an unset one. The old
 * `??` guarded only `undefined`/`null`, so a blank value produced `base === ''` and
 * sent the relative `"/api/oauth/mercado-livre/callback"` to ML as the `redirect_uri`
 * — which ML rejects at the token step with a 400 that this app could not report.
 * Same `??`-versus-empty-string hole #887 fixed for `*_TASKS_REGION`.
 *
 * The localhost default is deliberate and stays: local dev has no public origin.
 * It is also why a misconfigured deployed backend fails at ML rather than at boot —
 * the value is echoed in the callback's failure log so it can be seen.
 */
export function mercadoLivreRedirectUri(): string {
  const raw = process.env.MERCADO_LIVRE_PUBLIC_URL?.trim();
  const base = (raw && raw.length > 0 ? raw : 'http://localhost:3006').replace(/\/$/, '');
  return `${base}/api/oauth/mercado-livre/callback`;
}

/**
 * App-wide ML application config carrying the resolved `clientSecret` — one
 * registered ML application serves every connected account, so these live in env
 * / Secret Manager and never on the `integracao` doc. Drives the token exchange,
 * the refresh grant, and the consent URL the connect route builds.
 *
 * ⚠️ There used to be a second, near-identical `mercadoLivreConfig()` returning a
 * `MercadoLivreConfig` for the deleted channel factory. Two functions reading the
 * same two env vars and disagreeing about whether the secret was a VALUE or a
 * variable NAME is not a distinction worth keeping.
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
  /** The parsed integração doc (tabelas/depósito refs ride through). */
  readonly conta: Readonly<Record<string, unknown>>;
  readonly store: TokenDuravelStore;
  /**
   * Build the live `ChannelContext`: reads the newest valid token (or refreshes
   * it, concurrency-safe) and packs the per-account `account` bag. Throws
   * `MercadoLivreReauthRequiredError` when the account must reconnect via OAuth.
   */
  resolveChannelContext(now?: number): Promise<ChannelContext>;
  /**
   * Exchange an authorization code and persist the resulting credential.
   * `codeVerifier` is the PKCE proof (RFC 7636) minted by the connect route and
   * redeemed from the OAuth state record; omit it when PKCE is off for this ML
   * application. The refresh grant never carries one.
   */
  exchangeAndPersist(code: string, codeVerifier?: string): Promise<void>;
}

export async function loadMercadoLivreContext(
  db: Firestore,
  integracaoId: string,
): Promise<MercadoLivreContext> {
  // The cached reader replaces the READ, not the contract — both throws below
  // are unchanged, and a `null` stands in for `!snap.exists`.
  const conta = await readConta(db, integracaoId);
  if (conta == null) {
    throw new MercadoLivreContaNotConfiguredError(`Integração ${integracaoId} não encontrada.`);
  }
  if (conta.tipo !== INTEGRACAO_TIPO.mercadoLivre) {
    throw new MercadoLivreContaNotConfiguredError(
      `Integração ${integracaoId} não é do tipo Mercado Livre.`,
    );
  }
  return buildMercadoLivreContext(db, integracaoId, conta);
}

/**
 * The context assembly with the account document ALREADY read. Everything here
 * is env-only plus a token store that performs no I/O at construction — the
 * `.get()` in `loadMercadoLivreContext` is the whole of the loader's Firestore
 * cost, so a caller that already holds the parsed conta can skip it entirely.
 *
 * Exists for the two sweeps. Both enumerate with a query that already downloads
 * the full document (`estoqueSweep.ts` / `orderBackfill.ts`, each proved by the
 * raw field read in their loop bodies), then re-read those same documents one at
 * a time.
 *
 * Skipping the loader there loses no validation. `loadMercadoLivreContext`
 * guards exactly two things — the document EXISTS, and `tipo === mercadoLivre`
 * — and an enumerated document satisfies both by construction: it exists because
 * the query returned it, and `tipo` is one of the query's own predicates. (The
 * enumerations also filter `ativo == true`, which the loader does NOT check at
 * all — an extra restriction, not a missing one. Callers that care about
 * `ativo` read it off `ctx.conta` themselves; `nfeUpload.ts` is the live
 * example.)
 *
 * A TTL cache cannot fix the redundant read: the sweep period (15 min) equals
 * `READ_CACHE_TTL.config`, so every tick would be a cold miss.
 * Passing the snapshot down costs nothing and has no staleness window at all —
 * the data is microseconds old, fresher than a re-read would be. Same shape as
 * the `estoqueMercadoLivreSync` state doc, which `runStockSweep` already reads
 * once per conta and threads into `sweepConta` as `stateRaw`.
 */
export function buildMercadoLivreContext(
  db: Firestore,
  integracaoId: string,
  conta: Integracao,
): MercadoLivreContext {
  const oauthConfig = mercadoLivreOAuthConfig();
  const store = createTokenDuravelStore(db, integracaoId);

  // The per-account singularity (ML `user_id`) is a typed field on
  // `integracaoSchema` (#289) rather than opaque passthrough. Pass the parsed
  // value through; the plugin reads what it needs.
  const account: Readonly<Record<string, unknown>> = mercadoLivreAccountBag(conta);

  return {
    integracaoId,
    conta,
    store,
    async resolveChannelContext(now: number = Date.now()): Promise<ChannelContext> {
      const accessToken = await getOrRefreshAccessToken(store, oauthConfig, { now });
      return {
        integracaoId,
        accessToken,
        // ⚠️ The thunk re-reads the clock and the store on every call; the
        // `accessToken` beside it is a SNAPSHOT of this moment. They differ for
        // anything long-running — a sweep page, a mass-import dispatch, a
        // resumable job can all outlive the grant the snapshot captured. New
        // code takes the thunk; the field stays because ~25 call sites read it.
        getAccessToken: () => getOrRefreshAccessToken(store, oauthConfig, { now: Date.now() }),
        account,
      };
    },
    async exchangeAndPersist(code: string, codeVerifier?: string): Promise<void> {
      const resp = await exchangeCode(oauthConfig, code, codeVerifier);
      await store.save(tokenDuravelFromResponse(resp, Date.now()));
      // Denormalize the ML seller id onto the integração doc so an inbound
      // webhook resolves this account with a single equality query (the old
      // `ContaMercadoLivre.user_id`). Merge-only: never touches other fields.
      if (resp.user_id != null) {
        await integracaoCollection.merge(db, {}, integracaoId, { user_id: resp.user_id });
        // This process just wrote the document it caches. Covers THIS instance;
        // elsewhere `isFresh` refuses the pre-back-fill copy and the drift check
        // in `resolveContaAtivaPorUserId` catches a reconnect to another account.
        invalidateConta(integracaoId);
      }
    },
  };
}

/**
 * The ML-relevant slice of an `integracao` account, typed off
 * `integracaoSchema` (#289) rather than an ad-hoc `Record<string, unknown>`
 * read: `user_id` (the ML seller id). The Mercado-Shops price-table refs the
 * bag used to carry were dropped with the schema fields (Mercado Shops was
 * discontinued 2025-12-31; nothing ever consumed them).
 */
export function mercadoLivreAccountBag(conta: Integracao): Readonly<Record<string, unknown>> {
  return {
    user_id: conta.user_id,
  };
}
