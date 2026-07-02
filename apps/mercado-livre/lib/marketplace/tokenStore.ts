/**
 * Firestore-backed Mercado Livre token store over the admin-only
 * `integracao/{integracaoId}/tokenDuravel` collection — the OLD Flutter wire
 * shape (#287 dual-run migration: the new app and the still-running Flutter app
 * share the same credential on the same ML application).
 *
 * ## Concurrency ("one wins")
 * ML refresh tokens are **single-use and rotate** on every refresh, so two
 * refreshes racing on the same `refresh_token` cannot both succeed: ML rotates
 * `RT0 → RT1` for the first caller and rejects the second's `RT0` with
 * `invalid_grant`. That single-use rotation is the arbiter (ported from the old
 * app's `api.dart`). `getOrRefreshAccessToken` layers on:
 *  - a **fast path** returning the newest still-valid token with no refresh;
 *  - a **re-check** of the newest token before POSTing (a concurrent refresh may
 *    have just landed — use it instead of refreshing again);
 *  - a **loser fallback**: if our POST loses the race (`invalid_grant` / HTTP
 *    error), re-read the newest valid token the winner just wrote and use it.
 *
 * The OAuth refresh is deliberately **NOT** wrapped in a Firestore transaction:
 * `runTransaction` retries its callback on contention, which would re-fire the
 * non-idempotent single-use refresh and cause spurious `invalid_grant`/rate-limit
 * failures. Firestore only ever performs plain reads/writes here.
 *
 * Reads always take the newest token by `expires_in`, spanning both the
 * Flutter-written docs and this app's `current` doc, so whichever app refreshed
 * last is the one everyone uses.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { tokenDuravelCollection } from '@delfrance/data/admin/collections';
import type { TokenDuravel } from '@delfrance/schemas';
import {
  MercadoLivreHttpError,
  type MercadoLivreOAuthConfig,
  MercadoLivreReauthRequiredError,
  type TokenResponse,
  refreshAccessToken,
} from '@delfrance/integrations-mercado-livre';

/**
 * Fixed doc id for THIS app's `tokenDuravel` writes. Flutter uses auto-ids, so a
 * stable id never collides; reads never key by id (they sort by `expires_in`),
 * so co-existing lineages are fine.
 */
const CURRENT_DOC_ID = 'current';

/** Refresh a token this close to (or past) its expiry, never mid-flight. */
export const REFRESH_SKEW_MS = 60_000;

/** Small guard subtracted from the computed expiry (mirrors the old app's -5s). */
const EXPIRY_GUARD_MS = 5_000;

/**
 * Map a fresh ML `/oauth/token` response to the durable wire shape. `expires_in`
 * becomes an **absolute** ms-since-epoch expiry (`now + expires_in*1000 - 5s`),
 * matching Flutter's `dateTimeToJson` storage.
 */
export function tokenDuravelFromResponse(resp: TokenResponse, now: number): TokenDuravel {
  return {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    token_type: resp.token_type,
    scope: resp.scope ?? '',
    expires_in: now + resp.expires_in * 1000 - EXPIRY_GUARD_MS,
    user_id: resp.user_id ?? null,
    expired: null,
  };
}

export interface TokenDuravelStore {
  /** Newest token with `expires_in > cutoff` (ms since epoch), or null. */
  loadValid(cutoff: number): Promise<TokenDuravel | null>;
  /** Newest token regardless of validity (its `refresh_token` drives a refresh). */
  loadLatest(): Promise<TokenDuravel | null>;
  /** Persist a fresh credential (initial connect / after a refresh). */
  save(fresh: TokenDuravel): Promise<TokenDuravel>;
}

export function createTokenDuravelStore(db: Firestore, integracaoId: string): TokenDuravelStore {
  const ctx = { integracaoId };
  const coll = tokenDuravelCollection.ref(db, ctx);

  function parse(doc: FirebaseFirestore.QueryDocumentSnapshot): TokenDuravel {
    return tokenDuravelCollection.parseRead(
      doc.data(),
      tokenDuravelCollection.docPath(ctx, doc.id),
    );
  }

  async function newest(query: FirebaseFirestore.Query): Promise<TokenDuravel | null> {
    const snap = await query.orderBy('expires_in', 'desc').limit(1).get();
    const d = snap.docs[0];
    return d ? parse(d) : null;
  }

  return {
    loadValid: (cutoff: number) => newest(coll.where('expires_in', '>', cutoff)),
    loadLatest: () => newest(coll),
    async save(fresh: TokenDuravel): Promise<TokenDuravel> {
      await tokenDuravelCollection
        .docRef(db, ctx, CURRENT_DOC_ID)
        .set(tokenDuravelCollection.parse(fresh));
      return fresh;
    },
  };
}

export interface GetOrRefreshOpts {
  readonly now?: number;
  readonly skewMs?: number;
  /** Injectable for tests; defaults to the real ML refresh. */
  readonly refresh?: (
    config: MercadoLivreOAuthConfig,
    refreshToken: string,
  ) => Promise<TokenResponse>;
}

/**
 * The live access token for a connected account: the newest valid one, or a
 * freshly refreshed one. Concurrency-safe per the module docstring. Throws
 * `MercadoLivreReauthRequiredError` when there is no usable credential and no
 * concurrent refresh produced one (the account must reconnect via OAuth).
 */
export async function getOrRefreshAccessToken(
  store: TokenDuravelStore,
  config: MercadoLivreOAuthConfig,
  opts: GetOrRefreshOpts = {},
): Promise<string> {
  const now = opts.now ?? Date.now();
  const cutoff = now + (opts.skewMs ?? REFRESH_SKEW_MS);
  const refresh = opts.refresh ?? refreshAccessToken;

  const valid = await store.loadValid(cutoff);
  if (valid) return valid.access_token;

  const latest = await store.loadLatest();
  if (!latest) {
    throw new MercadoLivreReauthRequiredError(
      'no_token',
      'Conta Mercado Livre não conectada. Conecte via OAuth primeiro.',
    );
  }
  // A concurrent refresh may have landed between the fast path and this read —
  // honor it instead of POSTing again.
  if (latest.expires_in > cutoff) return latest.access_token;

  try {
    const resp = await refresh(config, latest.refresh_token);
    const fresh = tokenDuravelFromResponse(resp, now);
    await store.save(fresh);
    return fresh.access_token;
  } catch (err) {
    // We lost the single-use race: another refresh (this app or Flutter) already
    // rotated the token, so our POST got invalid_grant / an HTTP error. The
    // winner just wrote a fresh token — re-read and use it. Only re-raise when
    // there is genuinely no valid credential.
    if (err instanceof MercadoLivreReauthRequiredError || err instanceof MercadoLivreHttpError) {
      const winner = await store.loadValid(cutoff);
      if (winner) return winner.access_token;
    }
    throw err;
  }
}
