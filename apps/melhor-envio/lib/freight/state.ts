/**
 * Signed OAuth `state` for the Melhor Envio connect flow.
 *
 * ⚠️ The implementation moved to `@delfrance/data/admin/oauth-state` in #1034 —
 * this file is a re-export so the existing import sites keep working. Three
 * hand-copied per-channel copies is what #1034 removed; the drift was silent and
 * real (this channel had no clock-skew guard for months, so a forward-dated
 * `iat` never expired, and its `nonce` was minted and discarded, leaving every
 * `state` replayable for a full 10 minutes).
 *
 * `FreightStateError` is kept as an alias of the shared `OauthStateError` so the
 * callback's narrow reads naturally in this app's vocabulary. It is the SAME
 * class, not a subclass — an alias, so `instanceof` works against anything the
 * shared module throws.
 */
export {
  MAX_AGE_MS,
  MAX_FUTURE_SKEW_MS,
  OauthStateError,
  OauthStateError as FreightStateError,
  signState,
  verifyState,
} from '@delfrance/data/admin/oauth-state';
