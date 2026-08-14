import { defineCollection } from '@delfrance/data';
import { histPgtoSchema } from '@delfrance/schemas';

/**
 * Subcollection: `pedidos/{pedidoId}/pagamentos/{pagamentoId}/histpgto` — the
 * read-only status-change audit trail of a pagamento (newest-first in the
 * pagamento history dialog). Written exclusively by the
 * `onPagamentoStatusChanged` Cloud Function; the client only ever reads it.
 */
export const histPgtoCollection = defineCollection({
  path: 'pedidos/{pedidoId}/pagamentos/{pagamentoId}/histpgto',
  schema: histPgtoSchema,
});
