# `@delfrance/integrations-mercado-pago`

Platform-neutral Mercado Pago library: fetch-only, no Firestore, no Admin SDK.
Paired with the `apps/mercado-pago` App Hosting backend, which holds every
stateful flow.

## What ships here

- `oauth.ts` — authorize URL (PKCE-aware), code exchange, refresh. Server-side
  only; mirrors `@delfrance/integrations-mercado-livre`.
- `api.ts` — `getMe`, `getPayment`. Network-retry-with-backoff on a fetch throw
  only; any HTTP response is returned as-is.
- `types.ts` — response schemas. Every numeric field goes through
  `wireNumber()`/`wireInt()` (`@delfrance/core/wire`), because Mercado Pago quotes
  numbers on this resource — the same exposure Mercado Livre hit on the same
  underlying payment (#1251).
- `errors.ts` — the typed error taxonomy `apps/mercado-pago`'s `respond.ts` maps.
- `mapping/payment.ts` — `mpPaymentToPagamento`, pure.

## ⚠️ This is a library, not a plugin

It implemented no contract as of #1429. `createMercadoPagoGateway()` — a
`PaymentGateway` whose three members all threw — was deleted along with the
contract itself: it had zero importers, `registerPayment` had one caller (a unit
test), and the one live consumer was a permanently disabled button.

This README previously claimed _"enabling the Estornar button is a one-line change
once [#367 and #531] land"_. That was false and worth recording: **#531 landed and
the stub did not move**, because #531 was built where it belongs —
`apps/mercado-pago/lib/payments/notificacao.ts`, on the shared
`defineNotificationPipeline`.

Adding a second payment provider: the procedure is on `tipoIntegracaoPgtoSchema`
in `@delfrance/schemas`. Background: ADR 0015.
