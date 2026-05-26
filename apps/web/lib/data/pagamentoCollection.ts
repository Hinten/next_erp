import { defineCollection } from '@delfrance/data';
import {
  metodoPagamentoSchema,
  pagamentoSchema,
} from '@delfrance/schemas';

/**
 * Subcollection: `pedidos/{pedidoId}/pagamento` (singular — matches the
 * Flutter ERP's wire format). Use the {pedidoId} placeholder in the
 * path context.
 */
export const pagamentoCollection = defineCollection({
  path: 'pedidos/{pedidoId}/pagamento',
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
