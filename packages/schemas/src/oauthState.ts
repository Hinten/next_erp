import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';

/* -------------------------------------------------------------------------- */
/*             OauthState (subcollection) — #821 / #1034, all channels         */
/* -------------------------------------------------------------------------- */

/**
 * Per-attempt OAuth connect record, one shape for every channel that runs an
 * authorization-code flow: Mercado Livre, Melhor Envio, Mercado Pago.
 *
 * The signed `state` alone cannot be made single-use: an HMAC proves integrity,
 * not freshness-of-use, so before this record a captured `state` could be
 * replayed for the whole 10-minute window and drive a callback that overwrote the
 * account's credential with the attacker's. Non-replayability needs a
 * server-side record to redeem, and PKCE needs somewhere to park the
 * `code_verifier` between the consent redirect and the callback — one document
 * answers both.
 *
 * **Fixed doc id `'current'`** (same convention as the token stores), so a new
 * connect attempt OVERWRITES the previous record: at most one document per
 * account, no TTL policy and no sweep to deploy, and starting a second connect
 * correctly invalidates the first. `nonce` is what binds a given signed `state`
 * to this record — without it a stale state would match whatever record happens
 * to be current.
 *
 * A cookie was the alternative and does not work here: every channel's
 * `oauth/start` answers an XHR from `apps/web` on a DIFFERENT origin than the
 * channel backend, so the cookie would be third-party and subject to browser
 * cookie policy.
 *
 * **Admin-only / default-deny** — same posture as `credenciaisIntegracao`: the
 * doc holds a live `code_verifier`, so none of the three metas is registered in
 * `ALL_DOMAINS` (see the NOTE below) and Firestore default-denies every client
 * read/write. Only the Admin SDK (each channel's OAuth start + callback routes)
 * reaches it.
 */
export const oauthStateSchema = z
  .object({
    /** Random per-attempt id, mirrored in the signed `state` payload. */
    nonce: z.string().min(1),
    /**
     * PKCE `code_verifier` (RFC 7636) — `null` when the channel has no PKCE or
     * its flag is off. Mercado Livre and Mercado Pago both support PKCE behind a
     * per-application dashboard toggle; **Melhor Envio documents none**, so it
     * always stores `null`. A permanently-null field on one channel is cheaper
     * than two divergent record shapes.
     *
     * Each callback sends whatever is stored here and never re-reads the feature
     * flag, so flipping the flag mid-consent cannot strand an in-flight attempt.
     */
    codeVerifier: z.string().nullable().default(null),
    /** When the attempt was minted, ms since epoch. */
    criadoEm: millisSinceEpoch(),
    /**
     * When the callback redeemed the attempt, ms since epoch — `null` while
     * unused. A non-null value is what makes a second callback a REPLAY and not
     * a retry, so it is stamped inside the same transaction that reads it.
     */
    consumidoEm: millisSinceEpoch().nullable().default(null),
  })
  .passthrough();
export type OauthState = z.infer<typeof oauthStateSchema>;
/** The schema's own type, for typing the shared admin collection handles. */
export type OauthStateSchema = typeof oauthStateSchema;

/**
 * Build the admin-only meta for one channel's `oauthState` subcollection.
 *
 * Zero permission bits are placeholders: none of these is registered in
 * `ALL_DOMAINS`, so rules-gen emits no match block and Firestore default-denies
 * every client read/write. Only the Admin SDK reaches the code verifier. Mirrors
 * `credenciaisIntegracaoMeta` / `credenciaisMetodoPgtoMeta`.
 */
function oauthStateMetaFor(collectionPath: string): CollectionMetadata {
  return {
    collectionPath,
    permissions: {
      read: 0n,
      write: 0n,
      delete: 0n,
    },
  };
}

/** Mercado Livre — `integracao/{integracaoId}/oauthState`. */
export const oauthStateIntegracaoMeta = oauthStateMetaFor('integracao/{integracaoId}/oauthState');

/** Melhor Envio — `int_frete/{intFreteId}/oauthState`. */
export const oauthStateIntFreteMeta = oauthStateMetaFor('int_frete/{intFreteId}/oauthState');

/** Mercado Pago — `metodo_pgto/{metodoId}/oauthState`. */
export const oauthStateMetodoPgtoMeta = oauthStateMetaFor('metodo_pgto/{metodoId}/oauthState');

// NOTE: intentionally NOT exported as `{ schema, meta }` DomainSchemas and NOT
// added to `ALL_DOMAINS` — that would make the rules generator grant clients read
// access to a live PKCE `code_verifier`, which would defeat the point of PKCE
// entirely. Admin-only = default-deny (see `oauthStateMetaFor`, mirroring
// `credenciaisIntegracaoMeta`). The admin collection handles consume the paths +
// schema directly; the server-side cascade on each parent's delete frees the
// subcollection without a rules block.
