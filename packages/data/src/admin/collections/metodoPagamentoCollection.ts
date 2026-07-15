import { metodoPagamentoMeta, metodoPagamentoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the `metodo_pgto` collection — payment-gateway
 * configs (tipo-discriminated, today only Mercado Pago). The Mercado Pago
 * OAuth callback + refresh flow in apps/integrations reads/writes these
 * server-side to resolve the account before exchanging/refreshing a token
 * (the OAuth token lives in the admin-only `metodo_pgto/{id}/credenciais`
 * subcollection — see `credenciaisMetodoPgtoCollection`).
 */
export const metodoPagamentoCollection = defineAdminCollection({
  path: metodoPagamentoMeta.collectionPath,
  schema: metodoPagamentoSchema,
});
