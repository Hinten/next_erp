import { historicoPrecoMeta, historicoPrecoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the `produtos/{produtoId}/historicoDePrecos`
 * subcollection. Used by the `onProdutoPrecoCustoChanged` Cloud Function
 * (apps/functions) to write one deterministic-id record per price change —
 * the schema-validated counterpart of the removed client-side history write.
 * The path comes from the schema metadata so it stays a single source of truth.
 */
export const historicoPrecoCollection = defineAdminCollection({
  path: historicoPrecoMeta.collectionPath,
  schema: historicoPrecoSchema,
});
