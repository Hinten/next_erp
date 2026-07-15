import { historicoEstadoPedidoMeta, historicoEstadoPedidoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `pedidos/{pedidoId}/historicoEstadoPedido` — the
 * pedido estado audit trail. The Mercado Pago webhook receiver's server-side
 * estado reconcile (#531, `reconcilePedidoFromPagamento`) appends a row here
 * whenever a verified payment notification drives an `estado` transition, the
 * same way the existing client-side reconcile does.
 */
export const historicoEstadoPedidoCollection = defineAdminCollection({
  path: historicoEstadoPedidoMeta.collectionPath,
  schema: historicoEstadoPedidoSchema,
});
