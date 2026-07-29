import { historicoEstadoPedidoMeta, historicoEstadoPedidoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `pedidos/{pedidoId}/historicoEstadoPedido` — the pedido
 * estado audit trail. Rows are written SOLELY by the `onPedidoEstadoChanged`
 * Cloud Function (`apps/functions/src/pedidos/registrarEstadoPedido.ts`), which
 * observes every pedido write and appends one row per genuine `estado`
 * transition. Neither server-side reconcile in `../pedidoReconcile.ts` appends
 * anything — not the Mercado Pago webhook receiver's `reconcilePedidoFromPagamento`
 * (#531) nor the callable-facing `reconcilePedidoEstado` behind the web client's
 * Pagamentos tab (#308): both only write the pedido, and the trigger turns that
 * write into the trail row. Because both run on the Admin SDK, the transitions
 * they cause are recorded with a null usuário.
 */
export const historicoEstadoPedidoCollection = defineAdminCollection({
  path: historicoEstadoPedidoMeta.collectionPath,
  schema: historicoEstadoPedidoSchema,
});
