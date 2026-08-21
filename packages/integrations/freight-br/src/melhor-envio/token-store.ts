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
 * ## Losing the refresh race (#966)
 *
 * Two callers crossing the skew boundary together both POST a refresh, and the
 * loser's grant comes back rejected. It then re-reads the store to pick up the
 * winner's token — **twice**, the second time after `LOSER_REREAD_DELAY_MS`.
 * One immediate read is not enough: the loser learns it lost *before* the winner
 * finishes, because rejecting a used token is cheaper for ME than minting and
 * rotating a pair. A single read therefore often beats the winner's `save()` and
 * surfaces a spurious "reconecte a conta" to an operator whose account is fine.
 *
 * Concurrency here is ordinary, not exotic: `apps/melhor-envio` has no task
 * queue, but its routes are multi-instance App Hosting handlers (the pedido
 * Frete tab re-quotes on every edit) and `getAccessToken` is wired **per ME API
 * call**, so one `comprar` flow re-enters this function several times.
 *
 * Same shape as `apps/mercado-livre/lib/marketplace/tokenStore.ts` and
 * `apps/mercado-pago/lib/payments/mercadoPago.ts` (#820) — all three OAuth
 * channels now read alike.
 *
 * ## Refresh-token rotation is NOT load-bearing
 *
 * Melhor Envio runs on Laravel Passport, whose refresh grant revokes the
 * previous refresh token when it issues a pair — so of two racers only one
 * should succeed. That used to be an *assumption* this file relied on. It no
 * longer is: the Firestore `TokenStore` guards its write with an update-if-newer
 * check on `expirationDate` (ADR 0011 tier 2, see
 * `apps/melhor-envio/lib/freight/tokenStore.ts`), so even if both refreshes
 * succeed the older credential cannot overwrite the newer one — and `save()`
 * hands the loser the stored winner back.
 *
 * The refresh is deliberately **not** wrapped in a Firestore transaction:
 * `runTransaction` retries its callback on contention, which would re-fire the
 * non-idempotent refresh grant.
 *
 * `firebase-admin` stays OUT of this package — the Firestore `TokenStore`
 * implementation is injected from `apps/melhor-envio`.
 */
import { MelhorEnvioHttpError, MelhorEnvioReauthRequiredError } from './errors';
import type { TokenResponse } from './types';

/** A persisted ME token. `expirationDate` is ms since epoch (`now + expires_in`). */
export interface StoredToken {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expirationDate: number;
}

/** Options for {@link TokenStore.save}. */
export interface SaveTokenOptions {
  /**
   * Write unconditionally, bypassing the store's update-if-newer guard.
   *
   * For the **authorization-code** flow only: a human just re-consented, so that
   * credential wins whatever is stored. A refresh must never pass this — its
   * whole point is that it might be the loser of a race.
   */
  readonly force?: boolean;
}

export interface TokenStore {
  /** The latest token (by `expirationDate` desc), or `null` if none exists. */
  load(): Promise<StoredToken | null>;
  /**
   * Persist `token` and delete every other token doc (single-token
   * semantics — at most one lives).
   *
   * ⚠️ Returns **the token that is now stored**, which is not necessarily
   * `token`: unless `options.force` is set the implementation may keep a
   * concurrently-written newer credential and hand that back instead. Callers
   * must use the return value, never assume their own argument won.
   */
  save(token: StoredToken, options?: SaveTokenOptions): Promise<StoredToken>;
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
  /** Injectable for tests; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_SKEW_MS = 60_000;

/**
 * Wait between the loser fallback's two re-reads — long enough for the winner's
 * `save()` to commit. Mirrors the Mercado Livre and Mercado Pago stores, which
 * took the value from the old Flutter app's own abandoned transactional refresh.
 *
 * ⚠️ Widening the skew (`GetOrRefreshDeps.skewMs`, default 60 s) is NOT an
 * alternative to this — the window being covered is the ME round-trip plus one
 * Firestore write, not the expiry threshold.
 */
export const LOSER_REREAD_DELAY_MS = 250;

/** Real timer. `GetOrRefreshDeps.sleep` replaces it so tests never wait. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A rejected grant that only a fresh authorization-code flow recovers from. */
function isDeadGrantStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

/**
 * Return a valid access token, refreshing if it's within `skewMs` of
 * expiry. Throws `MelhorEnvioReauthRequiredError` when the account isn't
 * connected or the refresh token is dead.
 */
export async function getOrRefreshAccessToken(deps: GetOrRefreshDeps): Promise<StoredToken> {
  const now = deps.now?.() ?? Date.now();
  const skewMs = deps.skewMs ?? DEFAULT_SKEW_MS;
  const sleep = deps.sleep ?? defaultSleep;

  const current = await deps.store.load();
  if (!current) {
    throw new MelhorEnvioReauthRequiredError('no_token', 'Conta Melhor Envio não conectada.');
  }
  if (now < current.expirationDate - skewMs) {
    return current; // still comfortably valid
  }

  /**
   * The stored token, but only if it clears the skew — i.e. a concurrent
   * winner's. `load()` returns whatever is stored regardless of freshness, so
   * this comparison is what separates the two: the token we just failed to
   * refresh fails it BY DEFINITION (failing it is why we are refreshing).
   */
  const winnerToken = async (): Promise<StoredToken | null> => {
    const latest = await deps.store.load();
    return latest && now < latest.expirationDate - skewMs ? latest : null;
  };

  let refreshed: TokenResponse;
  try {
    refreshed = await deps.refresh(current.refresh_token);
  } catch (err) {
    // A rejected refresh grant means the refresh token is dead (expired/
    // revoked) OR a concurrent worker already rotated it (single-token:
    // our refresh_token was invalidated when they saved).
    //
    // Every HTTP rejection reaches the fallback, not just the dead-grant
    // triple: a 429 from the token endpoint is plausible *precisely* when two
    // refreshes hit at once, and it is exactly a case where a re-read would
    // find the winner. Matches ML/MP, which catch their HttpError class flat.
    //
    // Two reads, not one. The first costs nothing when the winner's write has
    // already landed; the second covers the likelier ordering, where it had not
    // — our rejection came back before the winner finished minting. `now` stays
    // the PRE-POST value: conservative (the winner's token must clear the full
    // skew measured from the original `now`) and deterministic under test.
    if (err instanceof MelhorEnvioHttpError) {
      const immediate = await winnerToken();
      if (immediate) return immediate;
      await sleep(LOSER_REREAD_DELAY_MS);
      const delayed = await winnerToken();
      if (delayed) return delayed;

      // Nobody won and the grant itself is dead — only a fresh
      // authorization-code flow recovers. Anything else (429, 5xx) is transient
      // and keeps its ORIGINAL error, so a caller can tell "reconnect the
      // account" apart from "ME is having a bad minute".
      if (isDeadGrantStatus(err.status)) {
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
    }
    throw err; // transient/network — let the caller bubble it
  }

  // ⚠️ The return value, not the argument: `save()` keeps a concurrently-written
  // newer credential and hands it back, so a refresh that raced and lost on the
  // WRITE side still resolves to a usable token here.
  return deps.store.save(storedTokenFromResponse(refreshed, now));
}
