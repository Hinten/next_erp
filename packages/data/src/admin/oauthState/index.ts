/**
 * Shared OAuth authorization-code primitives — the signed single-use `state`,
 * the per-attempt record that makes it single-use, and the PKCE helpers
 * (#821, #1034).
 *
 * ⚠️ One implementation for Mercado Livre, Melhor Envio and Mercado Pago. Before
 * this, all three carried hand-copied siblings and the drift was silent and real:
 * `MAX_FUTURE_SKEW_MS` existed in exactly one of them for months, and the missing
 * `nonce` store made every channel's `state` replayable for a full 10 minutes.
 * Add behaviour HERE, never in a channel.
 */
export { MAX_AGE_MS, MAX_FUTURE_SKEW_MS, OauthStateError, signState, verifyState } from './state';

export {
  type CodeChallengeMethod,
  codeChallengeS256,
  createCodeVerifier,
  pkceEnabledFor,
} from './pkce';

export {
  type ConsumedOauthState,
  type OauthStateStore,
  type PutOauthStateInput,
  createOauthStateStore,
} from './store';
