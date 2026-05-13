import { defineCollection } from '@delfrance/data';
import {
  metodoPagamentoSchema,
  pagamentoSchema,
} from '@delfrance/schemas';

/**
 * Subcollection: `pedidos/{pedidoId}/pagamentos`. Use the {pedidoId}
 * placeholder in the path context.
 */
export const pagamentoCollection = defineCollection({
  path: 'pedidos/{pedidoId}/pagamentos',
  schema: pagamentoSchema,
});

/**
 * Top-level: `metodo_pgto`. Configured payment methods (one entry per
 * gateway integration, today only Mercado Pago).
 */
export const metodoPagamentoCollection = defineCollection({
  path: 'metodo_pgto',
  schema: metodoPagamentoSchema,
});
