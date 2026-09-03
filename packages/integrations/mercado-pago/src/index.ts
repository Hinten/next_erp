/**
 * Mercado Pago channel library — platform-neutral (fetch-only, no Firestore).
 *
 * The OAuth core (`oauth.ts`), the REST client (`api.ts` — `getMe`, `getPayment`),
 * the error taxonomy (`errors.ts`), the response schemas (`types.ts`) and the pure
 * `mpPaymentToPagamento` mapper ship here. Token persistence, refresh, the webhook
 * receiver and every stateful flow are driven by the App Hosting backend
 * (`apps/mercado-pago`), which holds the Firestore/Admin-SDK dependency.
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
 *    charge id and a status — and needs `items[]`, `payer`, `back_urls`,
 *    `external_reference` and a per-pedido `notification_url`. That is #367.
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
export * from './oauth';
export * from './api';
export * from './mapping/payment';
