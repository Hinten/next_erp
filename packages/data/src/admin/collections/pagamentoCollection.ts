import { pagamentoMeta, pagamentoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `pedidos/{pedidoId}/pagamentos` — pedido payments. The
 * server-side estado reconcile (`reconcilePedidoFromPagamento`, driven by the
 * Mercado Pago webhook) uses it to read the whole payment set IN-TRANSACTION —
 * the atomic read the client SDK can't do — and to upsert the incoming payment
 * at its gateway-stable id.
 */
export const pagamentoCollection = defineAdminCollection({
  path: pagamentoMeta.collectionPath,
  schema: pagamentoSchema,
});
