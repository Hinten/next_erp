import { histPgtoMeta, histPgtoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `pedidos/{pedidoId}/pagamentos/{pagamentoId}/histpgto` —
 * the pagamento status-change audit trail.
 *
 * ONE writer: the `onPagamentoStatusChanged` trigger
 * (`apps/functions/src/pedidos/registrarHistoricoPagamento.ts`) observes every
 * write to `pedidos/{pedidoId}/pagamentos/{pagamentoId}` and appends a row per
 * `status_pagamento` transition (plus the opening row on creation).
 */
export const histPgtoCollection = defineAdminCollection({
  path: histPgtoMeta.collectionPath,
  schema: histPgtoSchema,
});
