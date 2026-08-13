/**
 * Resolve a `metodo_pgto` Mercado Pago account into a ready-to-use server
 * context: the app-wide OAuth config (env / Secret Manager), the single-token
 * credential store (over the admin-only `metodo_pgto/{id}/credenciais`
 * subcollection), and the flows the routes drive — the consent URL, a
 * `resolveAccessToken()` that refreshes on expiry (persisting MP's rotated
 * refresh token), and `exchangeAndPersist()` for the OAuth callback. Mirrors
 * apps/mercado-livre/lib/marketplace/mercadoLivre.ts, adapted to the payments
 * (metodo_pgto) domain.
 *
 * The refresh is concurrency-safe the same way the Mercado Livre store is: MP's
 * single-use refresh-token rotation is the arbiter, and a caller that loses that
 * race falls back to the winner's credential rather than raising a re-consent
 * prompt. See `resolveAccessToken`. It is deliberately **not** wrapped in a
 * Firestore transaction — `runTransaction` retries its callback, which would
 * re-fire the non-idempotent refresh.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { TIPO_INTEGRACAO_PGTO } from '@delfrance/schemas';
import { metodoPagamentoCollection } from '@delfrance/data/admin/collections';
import {
  MercadoPagoHttpError,
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

/**
 * Wait between the loser fallback's two re-reads (see `resolveAccessToken`) —
 * long enough for the winner's `save()` to commit. Mirrors the Mercado Livre
 * store's constant, which took the value from the old Flutter app's own
 * abandoned transactional refresh.
 *
 * ⚠️ Widening `REFRESH_SKEW_MS` is NOT an alternative: the window being covered
 * is the MP round-trip plus one Firestore write, not the expiry threshold.
 */
export const LOSER_REREAD_DELAY_MS = 250;

/** Real timer. `ResolveAccessTokenOpts.sleep` replaces it so tests never wait. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface ResolveAccessTokenOpts {
  /** Injectable for tests; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

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
  /**
   * Build the MP consent URL for this account, embedding the signed `state` and,
   * when the registered app has PKCE on, the `code_challenge` (#1034).
   */
  authorizeUrl(
    state: string,
    pkce?: { codeChallenge: string; codeChallengeMethod?: 'S256' | 'plain' },
  ): string;
  /**
   * The live access token: the stored one while comfortably valid, or a freshly
   * refreshed one (persisting MP's rotated refresh token). Concurrency-safe —
   * a refresh that loses the single-use race falls back to the winner's
   * credential. Throws `MercadoPagoReauthRequiredError` only when there is no
   * usable credential and no concurrent refresh produced one (the account must
   * reconnect via OAuth).
   */
  resolveAccessToken(now?: number, opts?: ResolveAccessTokenOpts): Promise<string>;
  /**
   * Exchange an authorization code and persist the resulting credential.
   * `codeVerifier` is the PKCE proof (RFC 7636) minted by the connect route and
   * redeemed from the OAuth state record; omit it when PKCE is off for this MP
   * application. The refresh grant never carries one.
   */
  exchangeAndPersist(code: string, codeVerifier?: string, now?: number): Promise<void>;
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
    authorizeUrl(
      state: string,
      pkce?: { codeChallenge: string; codeChallengeMethod?: 'S256' | 'plain' },
    ): string {
      // Whether PKCE is in play is decided by the connect route, next to the flag
      // and the store that holds the matching verifier — not here.
      return buildAuthorizeUrl({
        clientId: oauthConfig.clientId,
        redirectUri: oauthConfig.redirectUri,
        state,
        codeChallenge: pkce?.codeChallenge,
        codeChallengeMethod: pkce?.codeChallengeMethod,
      });
    },
    async resolveAccessToken(
      now: number = Date.now(),
      opts: ResolveAccessTokenOpts = {},
    ): Promise<string> {
      const sleep = opts.sleep ?? defaultSleep;
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

      /**
       * The stored credential, but only if it is fresher than the one we just
       * failed to refresh — i.e. a concurrent winner's. `load()` returns the
       * fixed `current` doc whatever its state, so this skew check is what
       * separates the two: the stale credential fails it BY DEFINITION (failing
       * it is why we are refreshing at all).
       */
      const winnerToken = async (): Promise<string | null> => {
        const latest = await store.load();
        return latest && now < latest.expirationDate - REFRESH_SKEW_MS ? latest.access_token : null;
      };

      // Near/past expiry: trade the (rotating, single-use) refresh token for a
      // fresh pair.
      try {
        const resp = await refreshAccessToken(oauthConfig, cred.refresh_token);
        const fresh = credentialFromResponse(resp, now);
        await store.save(fresh);
        return fresh.access_token;
      } catch (err) {
        // "One wins" — the loser fallback, mirroring apps/mercado-livre's
        // tokenStore. MP rotates single-use refresh tokens, so two callers
        // crossing the skew boundary together cannot both succeed: MP serves
        // one and answers the other `invalid_grant`. Concurrency here is by
        // configuration, not accident — `processMercadoPagoNotification`
        // dispatches 3 tasks at a time. The winner wrote a fresh credential, so
        // read it instead of telling an operator to reconnect a healthy account.
        //
        // Two reads, not one: the first costs nothing when the winner's write
        // has already landed, the second covers the likelier ordering where it
        // had not — our rejection came back before the winner finished minting
        // and rotating. `now` stays the pre-POST value: conservative, and
        // deterministic under test.
        if (err instanceof MercadoPagoReauthRequiredError || err instanceof MercadoPagoHttpError) {
          const immediate = await winnerToken();
          if (immediate) return immediate;
          await sleep(LOSER_REREAD_DELAY_MS);
          const delayed = await winnerToken();
          if (delayed) return delayed;
        }
        throw err;
      }
    },
    async exchangeAndPersist(
      code: string,
      codeVerifier?: string,
      now: number = Date.now(),
    ): Promise<void> {
      const resp = await exchangeCode(oauthConfig, code, codeVerifier);
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
