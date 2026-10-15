# `@delfrance/integrations-mercado-pago`

Platform-neutral Mercado Pago library: fetch-only, no Firestore, no Admin SDK.
Paired with the `apps/mercado-pago` App Hosting backend, which holds every
stateful flow.

## What ships here

- `oauth.ts` — authorize URL (PKCE-aware), code exchange, refresh. Server-side
  only; mirrors `@delfrance/integrations-mercado-livre`.
- `api.ts` — `getMe`, `getPayment`, and for the payment links (#367)
  `createPreference`, `updatePreference`, `searchPayments`. Network-retry-with-backoff
  on a fetch throw only (`GET` and `PUT`; a `POST` is attempted once); any HTTP
  response is returned as-is.
- `types.ts` — response schemas. Every numeric field goes through
  `wireNumber()`/`wireInt()` (`@delfrance/core/wire`), because Mercado Pago quotes
  numbers on this resource — the same exposure Mercado Livre hit on the same
  underlying payment (#1251).
- `errors.ts` — the typed error taxonomy `apps/mercado-pago`'s `respond.ts` maps.
- `mapping/payment.ts` — `mpPaymentToPagamento`, pure. It also stamps the two
  server-owned attribution keys of the payment-link tab (#367): `linkPagamentoId`
  from the preference's `metadata.link_id` (snake_case only) and
  `primeiroNomePagador` (a FIRST name only — LGPD — from `payer.first_name`, else
  the cardholder). Both are omitted, never `undefined`, when unusable.

## Payment links (#367)

A link is a Checkout Pro **preference**: `POST /checkout/preferences` answers an
`init_point` the payer opens. This package owns the wire; `apps/mercado-pago`
(`lib/payments/links/`) owns everything stateful — eligibility, the Firestore
link doc, the pedido's estado flip, cancel, auto-close and sync.

- `requests.ts` — the STRICT schemas of what we send (`z.strictObject`, so an
  unknown key such as `notification_url` is refused before `fetch`). `types.ts`
  is the opposite on purpose (tolerant, response-only); the two never share a
  shape. `api.ts` validates every body before it fetches a token or touches the
  network and raises `MercadoPagoRequestError` (field **paths** only, never a
  value — a body can carry a payer's e-mail and CPF).
- `mapping/preference.ts` — `buildPreferenceRequest`, pure. One line item (the
  amount ONE payer is asked for), `external_reference` = the pedido id verbatim,
  `metadata.link_id` = the link doc id (Mercado Pago copies it onto the payment,
  which is how a payment is attributed back to its link), an explicit `-03:00`
  offset — never `Z` — on both expiry dates, and a checkout prefill only when the
  caller passes a `pagador`.
- **Deliberately NOT sent:** `notification_url` (would override the panel webhook
  of #564 and bake a host that changes at the cutover), `back_urls` /
  `auto_return` (no public return page), `binary_mode` (kills Pix and boleto),
  `purpose`, `statement_descriptor` and an `X-Idempotency-Key` (with the
  caller's expire-on-failure cleanup, an honoured key could answer a retry with
  the preference that cleanup already expired).
- **A preference has no native "max uses".** A per-person link is closed by the
  backend after its first approved payment (a shared one after N) with
  `updatePreference` — both `expiration_date_to` and `date_of_expiration` move,
  because a Pix issued earlier stays payable until the latter. The expire body
  alone allows `date_of_expiration` to be OMITTED: should Mercado Pago 400 a
  past deadline (unconfirmed until probe P5), the backend re-sends the patch
  without it so the checkout at least closes.
- `mpCauseCodes(err)` reads `cause[].code` off an error body; `2001` ("the same
  request within a minute") is what `searchPayments` answers on a quick repeat.
- `searchPayments` always sends `range`/`begin_date`/`end_date` explicitly:
  Mercado Pago's default window is three months, which would hide older links.

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
