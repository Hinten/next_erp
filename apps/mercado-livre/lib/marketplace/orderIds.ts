/**
 * Deterministic ids for the Mercado Livre order-import — pure digests over
 * EXACT legacy preimage strings, so re-importing the same ML order/item/payment
 * always lands on the same Firestore doc (idempotent import; a retry after a
 * partial failure overwrites instead of duplicating). Ported character-for-
 * character from the legacy Dart `generateUid` helpers — no reformatting of the
 * interpolated strings, since a byte-for-byte match is what makes an already-
 * imported legacy pedido/pagamento resolve to the SAME id here.
 *
 * Sources:
 *  - Pedido.generateUid       `.old/packages/pedido/lib/src/models.dart:3736-3740`
 *  - ItemDoPedido.generateUid `.old/packages/pedido/lib/src/models.dart:149-153`
 *  - Pagamento.generateUid    `.old/packages/pedido/lib/src/models.dart:779-783`
 *  - Pagamento.generatePagamentoUid `.old/packages/pedido/lib/src/models.dart:2000-2002`
 *  - ML call site (pedido id) `.old/packages/canais_de_venda/mercado_livre/lib/src/models.dart:2997-3007`
 *  - ML call site (item id)   `.old/packages/canais_de_venda/mercado_livre/lib/src/models.dart:3179-3211`
 */
import { createHash } from 'node:crypto';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function sha1Hex(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex');
}

/**
 * Deterministic `pedidos/{id}` doc id for a Mercado Livre order. Mirrors
 * `Pedido.generateUid('mercadoLivre$contaId', packId ?? orderId)`, i.e.
 * `sha256(utf8("mercadoLivre${contaId}-${packId ?? orderId}"))`. When the order
 * belongs to a cart (`packId` present) the PACK id wins, so every order sharing
 * the same cart lands on the SAME pedido; otherwise the order id is used.
 */
export function makePedidoIdMercadoLivre(
  contaId: string,
  orderId: number,
  packId?: number | null,
): string {
  const idPart = packId ?? orderId;
  return sha256Hex(`mercadoLivre${contaId}-${idPart}`);
}

/**
 * Deterministic `ensureUniqueId` for one `order_items[]` line embedded in a
 * pedido. Mirrors `ItemDoPedido.generateUid(orderId.toString(), mktplaceId,
 * index)`, i.e. `sha256(utf8("${orderId}-${mktplaceId}-${index}"))`. `mktplaceId`
 * is the ML variation id (stringified) when the line has one, else the plain
 * item id (same rule the legacy call site applies — `variationId?.toString() ??
 * itemId`); `index` is the line's position in `order_items` and is what
 * disambiguates two lines that would otherwise share the same
 * `(orderId, mktplaceId)` pair.
 */
export function makeItemEnsureUniqueId(orderId: number, mktplaceId: string, index: number): string {
  return sha256Hex(`${orderId}-${mktplaceId}-${index}`);
}

/**
 * Deterministic `pedidos/{pedidoId}/pagamentos/{id}` doc id for one ML payment.
 * Mirrors `Pagamento.generatePagamentoUid(integracaoPath)` →
 * `Pagamento.generateUid(integracaoPath, id.toString())` →
 * `sha1(utf8(integracaoPath + id.toString()))`, where `integracaoPath` is the
 * conta's legacy Flutter `DocumentId.path` — `/documents/integracao/{contaId}`
 * (LEADING SLASH, and no separator before the payment id). This is a DIFFERENT
 * convention from the `documents/<col>/<id>` OuterRef wire format used
 * elsewhere in this app (which has no leading slash) — do not normalize this
 * preimage through `toOuterRef`, it would change the digest.
 */
export function makePagamentoIdMercadoLivre(contaId: string, paymentId: number | string): string {
  return sha1Hex(`/documents/integracao/${contaId}${paymentId}`);
}
