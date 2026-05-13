# `@delfrance/integrations-mercado-pago`

Mercado Pago plugin. Implements `PaymentGateway` from `@delfrance/core/plugins`.

## Status

**Scaffold only.** Phase 5 wires this on top of the official `mercadopago` npm SDK; webhook signature verification + idempotency reuse the helpers from `apps/integrations/lib/signatures/`.

`createMercadoPagoGateway()` returns a stub; every method throws `MercadoPagoNotConfiguredError`. The pagamentos UI in `apps/web` already calls into the registry (`getGateway('mercado-pago')`) and degrades gracefully when the lookup misses — enabling the Estornar button is a one-line change once this package lands its real implementation.
