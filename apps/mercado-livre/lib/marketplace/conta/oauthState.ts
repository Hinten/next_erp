/**
 * This channel's binding to the SHARED OAuth connect primitives
 * (`@delfrance/data/admin/oauth-state`) — #821, extracted in #1034.
 *
 * Everything load-bearing lives in the shared module: the signed `state`, the
 * single-use attempt record that makes a replay impossible, and the PKCE
 * helpers. All that belongs here is what is genuinely per-channel — which
 * Firestore subcollection the record lives in, and which env var gates PKCE.
 *
 * ⚠️ Do not reintroduce logic here. Three hand-copied copies of this is exactly
 * what #1034 removed, and the drift was silent: the clock-skew guard existed in
 * one of the three for months while the other two accepted forward-dated states
 * forever.
 */
import { oauthStateCollection } from '@delfrance/data/admin/collections';
import { createOauthStateStore, pkceEnabledFor } from '@delfrance/data/admin/oauth-state';

/** The per-attempt record under `integracao/{integracaoId}/oauthState`. */
export const mercadoLivreOauthState = createOauthStateStore(oauthStateCollection, 'integracaoId');

/** The env flag gating PKCE — ON only when it is exactly `'1'`. */
export const PKCE_FLAG_ENV = 'MERCADO_LIVRE_PKCE_ENABLED';

/**
 * Whether to drive the connect flow with PKCE.
 *
 * ⚠️ Must match the PKCE toggle on the registered application named by
 * `MERCADO_LIVRE_CLIENT_ID`: ML's docs are explicit that once the DevCenter
 * toggle is on the `code_challenge` parameters become MANDATORY, so the two are
 * flipped together. The production application is shared with the legacy Flutter
 * connect screen, which sends no `code_challenge`; staging has its own.
 */
export function pkceEnabled(): boolean {
  return pkceEnabledFor(PKCE_FLAG_ENV);
}
