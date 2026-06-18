import { defineCollection } from '@delfrance/data';
import { historicoEstadoPedidoSchema } from '@delfrance/schemas';

/**
 * Subcollection: `pedidos/{pedidoId}/historicoEstadoPedido` — the audit trail of
 * a pedido's `estado` transitions (newest-first in the Estado/Histórico tab).
 */
export const historicoEstadoCollection = defineCollection({
  path: 'pedidos/{pedidoId}/historicoEstadoPedido',
  schema: historicoEstadoPedidoSchema,
});
