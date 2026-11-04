/**
 * This channel's binding to the SHARED OAuth connect primitives
 * (`@delfrance/data/admin/oauth-state`, #821 / #1034).
 *
 * Everything load-bearing lives in the shared module: the signed `state`, its
 * clock-skew guard, and the single-use attempt record that makes a replay
 * impossible. All that belongs here is what is genuinely per-channel — which
 * Firestore subcollection the record lives in: `integracao/{id}/oauthState/current`.
 *
 * ⚠️ Do not reintroduce logic here: hand-copied copies of this are exactly what
 * #1034 removed, and the drift was silent.
 *
 * ## No PKCE, and no flag for it
 *
 * The SP-API website authorization workflow carries no `code_challenge`
 * (`pkce: 'nao'` in the channel's caps row), so `codeVerifier` is PERMANENTLY
 * `null` here and there is deliberately no flag: a flag suggests a supported
 * alternative that does not exist. That makes the signed `state` plus its
 * single-use record the ONLY trust anchors on the public callback.
 *
 * The record's lifetime is the seam's `MAX_AGE_MS` (10 minutes), unchanged —
 * it already equals Amazon's "a flow over 10 minutes may break" bound (step-2
 * plan §3 decision 8).
 */
import { oauthStateCollection } from '@delfrance/data/admin/collections';
import { createOauthStateStore } from '@delfrance/data/admin/oauth-state';

/** The per-attempt record under `integracao/{integracaoId}/oauthState/current`. */
export const amazonOauthState = createOauthStateStore(oauthStateCollection, 'integracaoId');
