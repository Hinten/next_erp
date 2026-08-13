/**
 * This channel's binding to the SHARED OAuth connect primitives
 * (`@delfrance/data/admin/oauth-state`) — #1034.
 *
 * Everything load-bearing lives in the shared module: the signed `state` and the
 * single-use attempt record that makes a replay impossible. All that belongs here
 * is the one genuinely per-channel fact — which Firestore subcollection the
 * record lives in.
 *
 * ℹ️ **No PKCE here.** Melhor Envio documents none: its authorization reference
 * lists only `client_id`, `redirect_uri`, `response_type`, `scope` and `state`,
 * and `@delfrance/integrations-freight-br`'s `buildAuthorizeUrl`/`exchangeCode`
 * carry no challenge parameters. So this channel always stores a `null`
 * verifier. The field stays on the shared record rather than being split away —
 * one permanently-null column is cheaper than two divergent record shapes.
 *
 * ⚠️ Do not reintroduce logic here. Three hand-copied copies of the state helper
 * is exactly what #1034 removed, and the drift was silent: this channel spent
 * months accepting forward-dated states that could never expire, because the
 * clock-skew guard existed only in Mercado Pago's copy.
 */
import { oauthStateIntFreteCollection } from '@delfrance/data/admin/collections';
import { createOauthStateStore } from '@delfrance/data/admin/oauth-state';

/** The per-attempt record under `int_frete/{intFreteId}/oauthState`. */
export const melhorEnvioOauthState = createOauthStateStore(
  oauthStateIntFreteCollection,
  'intFreteId',
);
