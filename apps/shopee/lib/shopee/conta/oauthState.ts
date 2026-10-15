/**
 * This channel's binding to the SHARED OAuth connect primitives
 * (`@delfrance/data/admin/oauth-state`) — #821, extracted in #1034.
 *
 * Everything load-bearing lives in the shared module: the signed `state`, its
 * clock-skew guard, and the single-use attempt record that makes a replay
 * impossible. All that belongs here is what is genuinely per-channel — which
 * Firestore subcollection the record lives in.
 *
 * ⚠️ Do not reintroduce logic here. Three hand-copied copies of this is exactly
 * what #1034 removed, and the drift was silent: the clock-skew guard existed in
 * one of the three for months while the other two accepted forward-dated states
 * forever.
 *
 * ## No PKCE, and no flag for it
 *
 * Shopee's consent URL (`guide 20`, "Format A") carries five parameters —
 * `partner_id`, `auth_type`, `redirect_uri`, `response_type`, `state` — and no
 * `code_challenge` anywhere in the documentation. So `codeVerifier` is
 * PERMANENTLY `null` on this channel, and there is deliberately no
 * `SHOPEE_PKCE_ENABLED` env flag: a flag suggests a supported alternative that
 * does not exist, and the one thing worse than no PKCE is a switch that pretends
 * to turn it on.
 *
 * ⚠️ That makes the signed `state` the ONLY trust anchor on the callback. The
 * legacy Flutter app sent no `state` at all.
 */
import { oauthStateCollection } from '@delfrance/data/admin/collections';
import { createOauthStateStore } from '@delfrance/data/admin/oauth-state';

/** The per-attempt record under `integracao/{integracaoId}/oauthState`. */
export const shopeeOauthState = createOauthStateStore(oauthStateCollection, 'integracaoId');
