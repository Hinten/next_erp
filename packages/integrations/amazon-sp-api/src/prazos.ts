/**
 * The per-call deadlines for the Amazon transport (#1094's rule: no `fetch`
 * without a bound).
 *
 * `fetch()` has no default timeout, so an endpoint that accepted the connection
 * and never answered would hold the caller until undici's own 300 s limits —
 * the whole request ceiling of an App Hosting backend. Every call opens one of
 * these deadlines (`abrirPrazo` from `@delfrance/core/wire`), reads the body
 * inside it, and a call that outlives it throws `AmazonTimeoutError` (the
 * `'documento'` and `'upload'` classes: `AmazonDocumentoEasyShipError` or
 * `AmazonDocumentoFeedError` with motivo `'prazo'`).
 *
 * ## Why the budget is keyed on the operation CLASS, not the endpoint
 *
 * The question a budget answers is "what does a cut HERE leave behind?" (the
 * Melhor Envio precedent, `freight-br/src/melhor-envio/prazos.ts`). Five
 * classes exist:
 *
 * - `'leitura'` — an SP-API `GET`. A cut one leaves nothing behind, and
 *   repeating it is harmless.
 * - `'lwa'` — the two token exchanges, `POST /auth/o2/token`.
 *   - A cut REFRESH exchange leaves nothing behind either: the SP-API refresh
 *     token does not rotate, so a second exchange works with the same one, and
 *     an access token minted by the cut one simply expires unused after an hour.
 *   - ⚠️ A cut AUTHORIZATION-CODE exchange may already have consumed the code,
 *     which is single-use and valid for five minutes. Repeating it then answers
 *     `invalid_grant`, and the only remedy is for the seller to consent again.
 *     So it must never be retried automatically — the budget is the same, but
 *     what the caller does after a timeout is not.
 * - `'escrita'` — an SP-API `POST` or `PATCH` through the write client
 *   (`escrita.ts`): every method other than `GET`.
 *   ⚠️ A cut write may already have been ingested: Amazon can hold it while
 *   the answer never arrived. So it is NEVER repeated in the same attempt — the
 *   caller re-reads the provider's state and decides from that. The budget is
 *   longer than a read's because the body (a whole document) travels up.
 * - `'documento'` — a `GET` of a pre-signed object on a non-SP-API host: the
 *   Easy Ship label document (`documentosEasyShip.ts`) and the feed processing
 *   report (`documentosFeed.ts`). A cut download leaves nothing behind; the
 *   caller may repeat the WHOLE label call (or report read), never the
 *   download alone (the URL may have expired).
 * - `'upload'` — a `PUT` of a feed document to a pre-signed URL
 *   (`documentosFeed.ts`). A cut upload leaves an unused document behind, never
 *   a seller write; the caller repeats the WHOLE submission, never the PUT
 *   alone.
 *
 * ⚠️ There is no `{ curto, longo }` pair and no row in
 * `http-client-timeout-ceiling.test.js`: that registry holds clients of OUR
 * backends whose `longo` tier must outlast the backend's request ceiling. This
 * is a server-to-provider client with no long tier; the test that the calls of
 * ONE request fit under the backend's ceiling arrives with the first route that
 * makes them (precedent: `apps/melhor-envio/lib/freight/prazos.test.ts`).
 */

/** The idempotency class of a call. */
export type ClasseOperacaoAmazon = 'leitura' | 'lwa' | 'escrita' | 'documento' | 'upload';

/**
 * Milliseconds per call, by class. `satisfies Record<ClasseOperacaoAmazon, …>`
 * makes a new class without a budget a compile error until someone decides what
 * a cut call of that class leaves behind.
 */
export const PRAZO_AMAZON_MS = {
  leitura: 20_000,
  lwa: 20_000,
  escrita: 30_000,
  documento: 20_000,
  upload: 30_000,
} as const satisfies Record<ClasseOperacaoAmazon, number>;
