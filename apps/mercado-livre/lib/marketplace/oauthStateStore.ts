/**
 * Per-attempt OAuth connect record — `integracao/{integracaoId}/oauthState` (#821).
 *
 * The signed `state` (`state.ts`) proves a callback was minted by us and is
 * still inside the freshness window. It cannot prove the callback has not run
 * ALREADY: an HMAC is stateless, so before this store a captured `state` was
 * replayable for the full window, and a replay overwrote the account's stored
 * credential with whoever drove the second callback. This module is the missing
 * half — the server-side record the callback consumes exactly once — and it
 * doubles as the parking spot for the PKCE `code_verifier`, which by definition
 * must not travel with the redirect.
 *
 * Fixed doc id, so a new connect attempt OVERWRITES the previous one: at most
 * one document per integração (no TTL policy, no sweep), and starting a second
 * connect invalidates the first — which is the behaviour you want anyway.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { oauthStateCollection } from '@delfrance/data/admin/collections';

import { MAX_AGE_MS, MarketplaceStateError } from './state';

/**
 * Fixed doc id. Unlike the `tokenDuravel` store there is no Flutter lineage to
 * co-exist with — this collection is new and server-only.
 */
const CURRENT_DOC_ID = 'current';

export interface PutOauthStateInput {
  /** The `nonce` embedded in the signed state this record backs. */
  readonly nonce: string;
  /** PKCE verifier, or `null` when PKCE is disabled. */
  readonly codeVerifier: string | null;
}

/**
 * Record a freshly minted connect attempt, replacing any previous one.
 *
 * A FULL overwrite on purpose — `merge()` would leave a previous attempt's
 * `consumidoEm` in place, and a record that is born consumed can never be
 * redeemed, which would break every connect instead of just the replays.
 */
export async function putOauthState(
  db: Firestore,
  integracaoId: string,
  input: PutOauthStateInput,
  now: number = Date.now(),
): Promise<void> {
  await oauthStateCollection.set(db, { integracaoId }, CURRENT_DOC_ID, {
    nonce: input.nonce,
    codeVerifier: input.codeVerifier,
    criadoEm: now,
    consumidoEm: null,
  });
}

export interface ConsumedOauthState {
  /** PKCE verifier to present at the token exchange, or `null` if PKCE was off. */
  readonly codeVerifier: string | null;
}

/**
 * Redeem the attempt behind `nonce`, exactly once. Throws
 * `MarketplaceStateError` — the same class the callback already narrows on — for
 * an absent, superseded, expired or already-consumed record.
 *
 * The stamp happens inside the transaction that read the record, and every
 * branch is re-derived from the `tx.get` snapshot rather than from anything
 * captured before it (root CLAUDE.md rule 7). Two callbacks racing the same
 * nonce therefore contend on Firestore's OCC: the retried loser re-reads a
 * record whose `consumidoEm` is now set and is rejected. Losing is the whole
 * point here — the second redemption of a single-use value must fail, and
 * failing closed costs nothing but a re-consent.
 */
export async function consumeOauthState(
  db: Firestore,
  integracaoId: string,
  nonce: string,
  now: number = Date.now(),
): Promise<ConsumedOauthState> {
  const ref = oauthStateCollection.docRef(db, { integracaoId }, CURRENT_DOC_ID);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new MarketplaceStateError('nenhuma tentativa de conexão pendente');
    }

    const record = oauthStateCollection.parseRead(
      snap.data(),
      oauthStateCollection.docPath({ integracaoId }, CURRENT_DOC_ID),
    );

    // A stale state whose attempt was superseded by a newer "Conectar": the
    // record exists and is unconsumed, but it is not THIS state's record.
    if (record.nonce !== nonce) {
      throw new MarketplaceStateError('state não corresponde à tentativa atual');
    }
    if (record.consumidoEm !== null) {
      throw new MarketplaceStateError('state já utilizado');
    }
    if (now - record.criadoEm > MAX_AGE_MS) {
      throw new MarketplaceStateError('tentativa de conexão expirada');
    }

    tx.update(ref, { consumidoEm: now });
    return { codeVerifier: record.codeVerifier };
  });
}
