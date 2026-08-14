/**
 * Token lifecycle — port of the legacy `getOrRefreshToken` /
 * `refreshToken` (`.old/.../melhor_envio/lib/src/api/api.dart:193-268`),
 * with two fixes:
 *
 *  - **Refresh margin (skew).** The legacy `isExpired` was a bare
 *    `expirationDate < now`, so a token expiring mid-request was treated
 *    as valid → 401. Here we refresh `skewMs` (default 60s) early.
 *  - **Refresh-token expiry → re-auth.** ME refresh tokens die after 45
 *    days; the legacy only surfaced a generic failure. A rejected
 *    refresh (400/401/403) now raises `MelhorEnvioReauthRequiredError`
 *    so the route can answer 409 `ME_REAUTH`.
 *
 * `firebase-admin` stays OUT of this package — the Firestore `TokenStore`
 * implementation is injected from `apps/integrations`.
 */
import { MelhorEnvioHttpError, MelhorEnvioReauthRequiredError } from './errors';
import type { TokenResponse } from './types';

/** A persisted ME token. `expirationDate` is ms since epoch (`now + expires_in`). */
export interface StoredToken {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expirationDate: number;
}

export interface TokenStore {
  /** The latest token (by `expirationDate` desc), or `null` if none exists. */
  load(): Promise<StoredToken | null>;
  /**
   * Persist `token` and delete every other token doc (single-token
   * semantics — at most one lives). Returns the saved token.
   */
  save(token: StoredToken): Promise<StoredToken>;
}

/** Build a `StoredToken` from an OAuth response captured at `nowMs`. */
export function storedTokenFromResponse(resp: TokenResponse, nowMs: number): StoredToken {
  return {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    expirationDate: nowMs + resp.expires_in * 1000,
  };
}

export interface GetOrRefreshDeps {
  readonly store: TokenStore;
  /** Performs the ME refresh grant for a given refresh token. */
  readonly refresh: (refreshToken: string) => Promise<TokenResponse>;
  /** ms-epoch clock, injectable for tests. */
  readonly now?: () => number;
  /** Early-refresh margin in ms (default 60_000). */
  readonly skewMs?: number;
}

const DEFAULT_SKEW_MS = 60_000;

/**
 * Return a valid access token, refreshing if it's within `skewMs` of
 * expiry. Throws `MelhorEnvioReauthRequiredError` when the account isn't
 * connected or the refresh token is dead.
 */
export async function getOrRefreshAccessToken(deps: GetOrRefreshDeps): Promise<StoredToken> {
  const now = deps.now?.() ?? Date.now();
  const skewMs = deps.skewMs ?? DEFAULT_SKEW_MS;

  const current = await deps.store.load();
  if (!current) {
    throw new MelhorEnvioReauthRequiredError('no_token', 'Conta Melhor Envio não conectada.');
  }
  if (now < current.expirationDate - skewMs) {
    return current; // still comfortably valid
  }

  let refreshed: TokenResponse;
  try {
    refreshed = await deps.refresh(current.refresh_token);
  } catch (err) {
    // A rejected refresh grant means the refresh token is dead (expired/
    // revoked) OR a concurrent worker already rotated it (single-token:
    // our refresh_token was invalidated when they saved). Re-read first —
    // if a fresh token now exists, use it; otherwise the account needs a
    // new authorization-code flow.
    if (
      err instanceof MelhorEnvioHttpError &&
      (err.status === 400 || err.status === 401 || err.status === 403)
    ) {
      const latest = await deps.store.load();
      if (latest && now < latest.expirationDate - skewMs) {
        return latest;
      }
      throw new MelhorEnvioReauthRequiredError(
        'refresh_failed',
        'Sessão Melhor Envio expirada, reconecte a conta.',
        err.body,
        // The status is right here; dropping it left `status` permanently null
        // at the only production throw site, so the field existed but never
        // carried anything.
        err.status,
      );
    }
    throw err; // transient/network — let the caller bubble it
  }

  return deps.store.save(storedTokenFromResponse(refreshed, now));
}
