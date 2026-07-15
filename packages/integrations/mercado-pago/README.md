# `@delfrance/integrations-mercado-pago`

Mercado Pago plugin. Implements `PaymentGateway` from `@delfrance/core/plugins`.

## Status

**OAuth + REST client landed (#530).** `oauth.ts` (authorize URL, code exchange,
refresh — server-side only, mirrors `@delfrance/integrations-mercado-livre`)
and `api.ts` (`getMe`, `getPayment`) are real. Token persistence + refresh
scheduling live in the App-Hosting backend that owns the Firestore/Admin-SDK
dependency; this library stays platform-neutral (fetch-only).

`createMercadoPagoGateway()` still returns a stub for `createCharge` / `refund`
/ `webhook`; every one of those throws `MercadoPagoNotConfiguredError` until
#367 (Link de pagamento) and #531 (webhook reconciler) land on top of the
OAuth-connected account. The pagamentos UI in `apps/web` already calls into
the registry (`getGateway('mercado-pago')`) and degrades gracefully when the
lookup misses — enabling the Estornar button is a one-line change once those
land.
