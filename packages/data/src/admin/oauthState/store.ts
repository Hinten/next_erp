/**
 * The per-attempt OAuth connect record, shared by every channel (#821, #1034).
 *
 * The signed `state` (`./state.ts`) proves a callback was minted by us and is
 * still inside the freshness window. It cannot prove the callback has not run
 * ALREADY: an HMAC is stateless, so before this store a captured `state` was
 * replayable for the full window on all three channels, and a replay overwrote
 * the account's stored credential with whoever drove the second callback. This
 * module is the missing half — the server-side record the callback redeems
 * exactly once — and it doubles as the parking spot for the PKCE `code_verifier`,
 * which by definition must not travel with the redirect.
 *
 * Bound to a channel by passing its admin collection handle, so one
 * implementation serves `integracao/{id}/oauthState`,
 * `int_frete/{intFreteId}/oauthState` and `metodo_pgto/{metodoId}/oauthState`.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type { OauthStateSchema } from '@delfrance/schemas';

import type { AdminCollectionHandle } from '../defineAdminCollection';
import { MAX_AGE_MS, OauthStateError } from './state';

/**
 * Fixed doc id, so a new connect attempt OVERWRITES the previous one: at most one
 * document per account, which is what keeps this out of the migration window —
 * no TTL policy to deploy and no sweep to schedule. Starting a second "Conectar"
 * therefore invalidates the first, which is the behaviour you want anyway.
 */
const CURRENT_DOC_ID = 'current';

export interface PutOauthStateInput {
  /** The `nonce` embedded in the signed state this record backs. */
  readonly nonce: string;
  /**
   * PKCE verifier, or `null` when the channel has no PKCE (Melhor Envio) or its
   * flag is off. Always `null` rather than absent, so the record has one shape
   * across channels.
   */
  readonly codeVerifier: string | null;
}

export interface ConsumedOauthState {
  /** PKCE verifier to present at the token exchange, or `null` if PKCE was off. */
  readonly codeVerifier: string | null;
}

export interface OauthStateStore {
  /**
   * Record a freshly minted connect attempt, replacing any previous one.
   *
   * A FULL overwrite on purpose — a merge would leave a previous attempt's
   * `consumidoEm` in place, and a record that is born consumed can never be
   * redeemed, which would break every connect instead of just the replays.
   */
  put(db: Firestore, id: string, input: PutOauthStateInput, now?: number): Promise<void>;
  /**
   * Redeem the attempt behind `nonce`, exactly once. Throws
   * {@link OauthStateError} — the class every channel's callback already narrows
   * on — for an absent, superseded, expired or already-consumed record.
   *
   * The stamp happens inside the transaction that read the record, and every
   * branch is re-derived from the `tx.get` snapshot rather than from anything
   * captured before it (root CLAUDE.md rule 7). Two callbacks racing the same
   * nonce therefore contend on Firestore's OCC: the retried loser re-reads a
   * record whose `consumidoEm` is now set and is rejected. Losing is the whole
   * point here — the second redemption of a single-use value MUST fail, and
   * failing closed costs nothing but a re-consent.
   */
  consume(db: Firestore, id: string, nonce: string, now?: number): Promise<ConsumedOauthState>;
}

/**
 * Bind the store to one channel's subcollection.
 *
 * `pathKey` is the placeholder name in that handle's path (`integracaoId`,
 * `intFreteId`, `metodoId`) — the handle resolves `{…}` segments by name, so it
 * has to be passed rather than inferred.
 */
export function createOauthStateStore(
  collection: AdminCollectionHandle<OauthStateSchema>,
  pathKey: string,
): OauthStateStore {
  const ctxFor = (id: string): Record<string, string> => ({ [pathKey]: id });

  return {
    async put(db, id, input, now = Date.now()): Promise<void> {
      await collection.set(db, ctxFor(id), CURRENT_DOC_ID, {
        nonce: input.nonce,
        codeVerifier: input.codeVerifier,
        criadoEm: now,
        consumidoEm: null,
      });
    },

    async consume(db, id, nonce, now = Date.now()): Promise<ConsumedOauthState> {
      const ctx = ctxFor(id);
      const ref = collection.docRef(db, ctx, CURRENT_DOC_ID);

      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) {
          throw new OauthStateError('nenhuma tentativa de conexão pendente');
        }

        const record = collection.parseRead(snap.data(), collection.docPath(ctx, CURRENT_DOC_ID));

        // A stale state whose attempt was superseded by a newer "Conectar": the
        // record exists and is unconsumed, but it is not THIS state's record.
        if (record.nonce !== nonce) {
          throw new OauthStateError('state não corresponde à tentativa atual');
        }
        if (record.consumidoEm !== null) {
          throw new OauthStateError('state já utilizado');
        }
        if (now - record.criadoEm > MAX_AGE_MS) {
          throw new OauthStateError('tentativa de conexão expirada');
        }

        tx.update(ref, { consumidoEm: now });
        return { codeVerifier: record.codeVerifier };
      });
    },
  };
}
