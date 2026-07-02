/**
 * Firestore-backed Mercado Livre token store over the admin-only
 * `integracao/{integracaoId}/tokenDuravel` collection — the OLD Flutter wire
 * shape (#287 dual-run migration: the new app and the still-running Flutter app
 * share the same credential on the same ML application).
 *
 * ## Concurrency ("one wins")
 * ML refresh tokens are **single-use and rotate** on every refresh, so two
 * refreshes racing on the same `refresh_token` can't both succeed: ML rotates
 * `RT0 → RT1` for the first caller and rejects the second's `RT0` with
 * `invalid_grant`. That is the ultimate arbiter, ported from the old app.
 *
 * `getOrRefreshAccessToken` layers on top:
 *  - a **fast path** that returns the newest still-valid token without a refresh;
 *  - a **transaction** (`refreshAtomic`) that re-reads the newest token, so this
 *    app's own concurrent refreshes serialize and the loser sees the winner's
 *    fresh token instead of re-POSTing;
 *  - a **loser fallback**: if our POST loses the race (`invalid_grant` / HTTP
 *    error), we re-read the newest valid token the winner just wrote and use it.
 *
 * Reads always take the newest token by `expires_in` (`> cutoff`), which spans
 * both the Flutter-written docs and this app's `current` doc, so whichever app
 * refreshed last is the one everyone uses.
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
 * stable id never collides and gives the refresh transaction a consistent write
 * target. Reads never key by id (they sort by `expires_in`), so co-existing
 * lineages are fine.
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
  /**
   * Run `decide` inside a transaction that has read the newest token (valid or
   * not). `decide` returns the access token to use; if it minted a fresh token
   * it calls `persist`, and the transaction commits that write. Serializes this
   * app's concurrent refreshes on the newest-token read.
   */
  refreshAtomic(
    decide: (
      latest: TokenDuravel | null,
      persist: (fresh: TokenDuravel) => void,
    ) => Promise<string>,
  ): Promise<string>;
  /** Persist a fresh credential (initial connect / exchange). */
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

  return {
    async loadValid(cutoff: number): Promise<TokenDuravel | null> {
      const snap = await coll
        .where('expires_in', '>', cutoff)
        .orderBy('expires_in', 'desc')
        .limit(1)
        .get();
      const d = snap.docs[0];
      return d ? parse(d) : null;
    },

    async refreshAtomic(decide): Promise<string> {
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(coll.orderBy('expires_in', 'desc').limit(1));
        const d = snap.docs[0];
        const latest = d ? parse(d) : null;
        let toPersist: TokenDuravel | null = null;
        const result = await decide(latest, (fresh) => {
          toPersist = fresh;
        });
        if (toPersist) {
          tx.set(
            tokenDuravelCollection.docRef(db, ctx, CURRENT_DOC_ID),
            tokenDuravelCollection.parse(toPersist),
          );
        }
        return result;
      });
    },

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

  try {
    return await store.refreshAtomic(async (latest, persist) => {
      if (!latest) {
        throw new MercadoLivreReauthRequiredError(
          'no_token',
          'Conta Mercado Livre não conectada. Conecte via OAuth primeiro.',
        );
      }
      // A concurrent refresh may have landed between the fast path and this
      // transaction — honor it instead of POSTing again.
      if (latest.expires_in > cutoff) return latest.access_token;
      const resp = await refresh(config, latest.refresh_token);
      const fresh = tokenDuravelFromResponse(resp, now);
      persist(fresh);
      return fresh.access_token;
    });
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
