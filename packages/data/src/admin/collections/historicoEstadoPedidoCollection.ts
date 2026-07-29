import { historicoEstadoPedidoMeta, historicoEstadoPedidoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `pedidos/{pedidoId}/historicoEstadoPedido` — the
 * pedido estado audit trail. The Mercado Pago webhook receiver's server-side
 * estado reconcile (#531, `reconcilePedidoFromPagamento`) appends a row here
 * whenever a verified payment notification drives an `estado` transition, the
 * same way the callable-facing `reconcilePedidoEstado` does for the web
 * client's Pagamentos tab (#308) — both live in `../pedidoReconcile.ts`.
 */
export const historicoEstadoPedidoCollection = defineAdminCollection({
  path: historicoEstadoPedidoMeta.collectionPath,
  schema: historicoEstadoPedidoSchema,
});
