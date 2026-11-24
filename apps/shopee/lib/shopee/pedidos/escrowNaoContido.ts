/**
 * The `get_escrow_detail` failures the step-5 importer must NOT contain — the
 * ONE list, read by two callers that must agree:
 *
 *  - the importer's escrow containment (`importarPedido.ts`, `lerEscrowContido`),
 *    which rethrows these and turns every other wire failure into "price from
 *    the detail";
 *  - `capturar:pedido` (`capturarPedidoCli.ts`), which must not SAVE an escrow
 *    body that answers one of these: the replay serves a saved escrow verbatim,
 *    the importer rethrows, and the replay the capture told the operator to run
 *    fails.
 *
 * Two copies of this list would drift toward plausible while disagreeing
 * (root CLAUDE.md, #1369); one cannot.
 *
 * Why these two: containing a dead grant would import the order at detail-only
 * prices and report success, and containing a burst limit (or the daily quota)
 * would spend the retry on a payload already known to be incomplete.
 *
 * ⚠️ Both classes EXTEND `ShopeeApiError`, so a caller asks THIS before it asks
 * the base class — the base would otherwise swallow them.
 *
 * Imports the package's error classes and nothing else, so the capture CLI can
 * read it without loading the importer's graph (contexts, token store, admin).
 */
import { ShopeeRateLimitError, ShopeeReauthRequiredError } from '@delfrance/integrations-shopee';

export function falhaDeEscrowNaoContida(
  err: unknown,
): err is ShopeeReauthRequiredError | ShopeeRateLimitError {
  return err instanceof ShopeeReauthRequiredError || err instanceof ShopeeRateLimitError;
}
