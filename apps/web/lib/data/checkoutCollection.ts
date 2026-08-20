import { defineCollection } from '@delfrance/data';
import { checkoutFretePedidoSchema } from '@delfrance/schemas';

/**
 * Subcollection: `pedidos/{pedidoId}/checkout` — the dispatch/checkout audit doc
 * written when a warehouse operator finishes scanning a paid pedido's contents.
 * Leaf name is EXACTLY `checkout` (legacy parity; that is the leaf the migrated
 * corpus sits under). Read-back + the "Outros Checkouts" collection-group query consume
 * this handle (see the checkout port plan §7 PR 4/6).
 */
export const checkoutCollection = defineCollection({
  path: 'pedidos/{pedidoId}/checkout',
  schema: checkoutFretePedidoSchema,
});
