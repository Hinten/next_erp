/**
 * Mercado Pago channel library — platform-neutral (fetch-only, no Firestore).
 *
 * The OAuth core (`oauth.ts`), the REST client (`api.ts` — `getMe`, `getPayment`,
 * and for the payment links of #367 `createPreference`, `updatePreference`,
 * `searchPayments`), the error taxonomy (`errors.ts`), the tolerant response
 * schemas (`types.ts`), the STRICT request schemas (`requests.ts`) and the pure
 * mappers `mpPaymentToPagamento` and `buildPreferenceRequest` ship here. Token
 * persistence, refresh, the webhook receiver and every stateful flow are driven
 * by the App Hosting backend (`apps/mercado-pago`), which holds the
 * Firestore/Admin-SDK dependency.
 *
 * ⚠️ **There is no `createMercadoPagoGateway` any more (#1429).** It returned a
 * `PaymentGateway` whose `createCharge`, `refund` and `webhook` all threw, and it
 * had zero importers — `apps/mercado-pago` imports fifteen symbols from this
 * package and never imported that one. The contract is deleted; each member was
 * wrong in its own way:
 *
 *  - `webhook` had **already shipped**, outside the contract, in
 *    `apps/mercado-pago/lib/payments/notificacao.ts` on
 *    `defineNotificationPipeline`. Its real form needs the whole `Request` (raw
 *    body for the HMAC manifest, `x-signature`/`x-request-id`, and the query
 *    string — a v1 IPN carries the payment id only in `?id=`), a Firestore handle,
 *    a token refresher and a Cloud Tasks queue, and it answers with a four-valued
 *    disposition. A `(payload) => {orderId?, status}` cannot express any of that.
 *  - `createCharge` mis-described the one real write. The operation is
 *    `POST /checkout/preferences`, which returns a **link and an expiry** — not a
 *    charge id and a status. That is #367, and it now exists as
 *    `MercadoPagoApi.createPreference` + `buildPreferenceRequest`. The comment that
 *    stood here claimed the preference needs `back_urls` and a per-pedido
 *    `notification_url`; the built body deliberately sends NEITHER (no public
 *    return page, and a per-preference URL would override the panel webhook of
 *    #564 and bake a host that changes at the cutover) — see `requests.ts`.
 *  - `refund` had no precedent at all: the legacy app never refunded either, and
 *    the ERP only ever *observes* a refund through `STATUS_PAGAMENTO`.
 *
 * ⚠️ Its `MercadoPagoConfig` also contradicted the built architecture — it
 * described one app-wide static token, while the live app is per-account OAuth with
 * rotating refresh tokens in `metodo_pgto/{id}/credenciais`.
 *
 * See ADR 0015 for the reasoning, and `tipoIntegracaoPgtoSchema`
 * (`@delfrance/schemas`) for the procedure a second payment provider follows.
 */

export * from './errors';
export * from './types';
export * from './requests';
export * from './oauth';
export * from './api';
export * from './mapping/payment';
export * from './mapping/preference';
