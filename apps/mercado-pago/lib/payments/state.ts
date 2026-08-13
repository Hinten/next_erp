/**
 * Signed OAuth `state` for the Mercado Pago connect flow.
 *
 * ⚠️ The implementation moved to `@delfrance/data/admin/oauth-state` in #1034 —
 * this file is a re-export so the existing import sites keep working. Three
 * hand-copied per-channel copies is what #1034 removed; the drift was silent and
 * real, and this channel sat on both sides of it. It was the ONLY copy to carry
 * the clock-skew guard for months (Mercado Livre gained one in #998; Melhor
 * Envio only here) — yet, exactly like both siblings, its `nonce` was minted and
 * then discarded, leaving every `state` replayable for a full 10 minutes. On
 * this channel that means a stranger's MP collector receiving the customer
 * payments.
 *
 * `PaymentStateError` is kept as an alias of the shared `OauthStateError` so the
 * callback's narrow reads naturally in this app's vocabulary. It is the SAME
 * class, not a subclass — an alias, so `instanceof` works against anything the
 * shared module throws.
 */
export {
  MAX_AGE_MS,
  MAX_FUTURE_SKEW_MS,
  OauthStateError,
  OauthStateError as PaymentStateError,
  signState,
  verifyState,
} from '@delfrance/data/admin/oauth-state';
