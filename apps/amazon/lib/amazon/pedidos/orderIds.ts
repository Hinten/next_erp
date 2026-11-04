/**
 * Deterministic ids for the Amazon order import (master plan step 5, PR 5-a):
 * the `pedidos/{id}` document of one Amazon order, and its ONE
 * `pedidos/{id}/pagamentos/{id}` document. Pure digests over ONE exact
 * preimage string, so re-importing the same order (a push redelivery, the
 * reprocess sweep, the backstop poll) always lands on the same documents — root
 * `CLAUDE.md` rule 7, tier 0: the race is made impossible rather than compared.
 *
 * ## ⚠️ The preimage is `<contaId>-<AmazonOrderId>` and nothing else
 *
 * - `<contaId>` is the BARE `integracao` document id of the Amazon conta, never
 *   a path (`integracao/<id>`, `documents/integracao/<id>`, `/documents/…`) and
 *   never the seller id: two contas may sell through one seller over time, and
 *   the ERP's owner of a pedido is the conta.
 * - One ASCII hyphen-minus (U+002D), then the 3-7-7 order id VERBATIM, dashes
 *   included. UTF-8, sha256, lowercase hex.
 *
 * The reason is not taste. The legacy corpus survives the cutover WITH ITS IDS
 * (root `CLAUDE.md` rule 8), and the legacy Amazon importer wrote each pedido
 * at exactly this digest. A different spelling forks EVERY migrated Amazon
 * pedido on its first re-import: two pedidos for one sale, the operator looking
 * at the other. `orderIds.test.ts` pins the digests character for character,
 * with the spellings the other channels use (and the plausible slips) asserted
 * UNEQUAL, so a "harmless" reformat of the template literal fails there instead
 * of in the migration window.
 *
 * ## ⚠️ The PAGAMENTO id is the SAME digest
 *
 * Unlike Shopee and Loja Integrada (`integracao/<contaId>-<order>`) and Mercado
 * Livre (`/documents/integracao/<contaId>-<payment>`), the legacy Amazon
 * importer keyed the order's one pagamento with the pedido's own preimage, so
 * the document path is `pedidos/{d}/pagamentos/{d}`. Both ids therefore come
 * from {@link preimagemPedidoAmazon}, the ONE template literal: there is no
 * second spelling to drift.
 *
 * ## A malformed id is a bug, not an input
 *
 * Both ids are validated upstream (the task payload's grammar, the importer's
 * identity check), so a value outside `CONTA_ID_AMAZON_REGEX` or
 * `PEDIDO_AMAZON_REGEX` here throws a `RangeError` (its message names the
 * grammar, never the value) rather than minting a document id from it.
 *
 * The algorithm and the encoding are `sha256Hex`'s (`@delfrance/data/admin`);
 * this file owns only the preimage.
 */
import { sha256Hex } from '@delfrance/data/admin';
import { CONTA_ID_AMAZON_REGEX, PEDIDO_AMAZON_REGEX } from '@delfrance/schemas';

/**
 * The ONE preimage of both ids: `"<contaId>-<AmazonOrderId>"`, byte for byte.
 *
 * @throws {RangeError} a conta id outside `CONTA_ID_AMAZON_REGEX` (a path, an
 *   empty string, a `/`) or an order id outside `PEDIDO_AMAZON_REGEX`.
 */
export function preimagemPedidoAmazon(contaId: string, orderId: string): string {
  if (!CONTA_ID_AMAZON_REGEX.test(contaId)) {
    throw new RangeError('preimagemPedidoAmazon: id de conta fora de CONTA_ID_AMAZON_REGEX');
  }
  if (!PEDIDO_AMAZON_REGEX.test(orderId)) {
    throw new RangeError('preimagemPedidoAmazon: id de pedido fora de PEDIDO_AMAZON_REGEX');
  }
  return `${contaId}-${orderId}`;
}

/** The digest both ids share: one producer, so the two can never disagree. */
function digestoDoPedidoAmazon(contaId: string, orderId: string): string {
  return sha256Hex(preimagemPedidoAmazon(contaId, orderId));
}

/**
 * The `pedidos/{id}` document id of Amazon order `orderId` of conta `contaId`:
 * `sha256(utf8("<contaId>-<orderId>"))`, the legacy id.
 *
 * @throws {RangeError} see {@link preimagemPedidoAmazon}.
 */
export function makePedidoIdAmazon(contaId: string, orderId: string): string {
  return digestoDoPedidoAmazon(contaId, orderId);
}

/**
 * The `pedidos/{pedidoId}/pagamentos/{id}` document id of the same order: the
 * SAME digest as {@link makePedidoIdAmazon} (module header), through the same
 * producer.
 *
 * @throws {RangeError} see {@link preimagemPedidoAmazon}.
 */
export function makePagamentoIdAmazon(contaId: string, orderId: string): string {
  return digestoDoPedidoAmazon(contaId, orderId);
}
