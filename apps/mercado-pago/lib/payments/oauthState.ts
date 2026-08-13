/**
 * This channel's binding to the SHARED OAuth connect primitives
 * (`@delfrance/data/admin/oauth-state`) — #1034.
 *
 * Everything load-bearing lives in the shared module: the signed `state`, the
 * single-use attempt record that makes a replay impossible, and the PKCE
 * helpers. All that belongs here is what is genuinely per-channel — which
 * Firestore subcollection the record lives in, and which env var gates PKCE.
 *
 * ⚠️ Do not reintroduce logic here. Three hand-copied copies of the state helper
 * is exactly what #1034 removed.
 */
import { oauthStateMetodoPgtoCollection } from '@delfrance/data/admin/collections';
import { createOauthStateStore, pkceEnabledFor } from '@delfrance/data/admin/oauth-state';

/** The per-attempt record under `metodo_pgto/{metodoId}/oauthState`. */
export const mercadoPagoOauthState = createOauthStateStore(
  oauthStateMetodoPgtoCollection,
  'metodoId',
);

/** The env flag gating PKCE — ON only when it is exactly `'1'`. */
export const PKCE_FLAG_ENV = 'MERCADO_PAGO_PKCE_ENABLED';

/**
 * Whether to drive the connect flow with PKCE.
 *
 * ⚠️ Must match the PKCE toggle on the registered application named by
 * `MERCADO_PAGO_CLIENT_ID`. MP's docs are explicit that once the dashboard
 * toggle is on the `code_challenge` parameters become MANDATORY, so the two are
 * flipped together: code without the toggle sends parameters MP ignores; the
 * toggle without the code breaks every connect.
 */
export function pkceEnabled(): boolean {
  return pkceEnabledFor(PKCE_FLAG_ENV);
}
