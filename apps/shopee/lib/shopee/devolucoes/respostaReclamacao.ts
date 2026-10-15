/**
 * What BOTH `reclamacao` routes answer for a Shopee refusal (#1525, step 17,
 * review R3-2): the two codes they share and {@link semFraseDaShopee}. One
 * home, so neither route imports the other and the panel's `incerto` rule
 * (`falhaDaAcaoShopee` in `apps/web`) keys on ONE spelling.
 *
 * PURE: no clock, no I/O, no `console` — the routes do the logging.
 */
import {
  ShopeeApiError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
} from '@delfrance/integrations-shopee';

import { codigoSeguro } from '@/lib/shopee/nfe/redacaoNfe';

import { MARCADOR_NAO_TOKEN } from './tokenParaLog';

/** The 404 — Shopee does not know the return. */
export const CODIGO_INEXISTENTE = 'SHOPEE_RECLAMACAO_INEXISTENTE';

/**
 * The 502 of a Shopee refusal neither route maps. ⚠️ A DEFINITE Shopee
 * answer, never an unknown outcome: the panel (`falhaDaAcaoShopee` in
 * `apps/web`) keys on this code.
 */
export const CODIGO_FALHA_SHOPEE = 'SHOPEE_RECLAMACAO_FALHA_SHOPEE';

/**
 * The same Shopee API error WITHOUT Shopee's sentence, for
 * `shopeeErrorResponse` — which logs and returns `err.message` verbatim, and
 * which both `reclamacao` routes reach for the kinds they do not map
 * themselves (re-auth, rate limits, Shopee's transients).
 *
 * The package formats every envelope error's `message` as `Shopee <path>
 * respondeu <code> (HTTP n) — <Shopee's sentence>` and keeps the sentence in
 * `providerMessage` too, so a filter on the message would be a reverse parser.
 * This REBUILDS the error instead, named field by field: the same class (the
 * mapper's 409-vs-502 rides on it), `kind`, `httpStatus`, `path` and — on a rate
 * limit — `retryAfterSeconds`; the `code` through `codigoSeguro` (a code it
 * refuses becomes `tokenParaLog`'s marker, never the code itself); a `message`
 * of OUR words only; and NO `providerMessage`, `warning` or `requestId`. The
 * mapper's status and code table stays its own — this changes what it SAYS,
 * never what it answers.
 *
 * ⚠️ It drops a `ShopeeApiPartialError`'s payload (the class falls back to the
 * base one): no returns operation is called with that tolerance, and the
 * mapper has no arm for it either.
 */
export function semFraseDaShopee(err: ShopeeApiError): ShopeeApiError {
  const code = codigoSeguro(err.code) ?? MARCADOR_NAO_TOKEN;
  const message = `Shopee ${err.path} respondeu ${code} (HTTP ${String(err.httpStatus)}).`;
  const init = { code, kind: err.kind, httpStatus: err.httpStatus, path: err.path };
  // ⚠️ The two SUBCLASSES first: both extend the base class.
  if (err instanceof ShopeeRateLimitError) {
    return new ShopeeRateLimitError(message, {
      ...init,
      kind: err.kind,
      retryAfterSeconds: err.retryAfterSeconds,
    });
  }
  if (err instanceof ShopeeReauthRequiredError) return new ShopeeReauthRequiredError(message, init);
  return new ShopeeApiError(message, init);
}
