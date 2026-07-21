import { historicoCustoMeta, historicoCustoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the `produtos/{produtoId}/historicoDeCusto`
 * subcollection. Used by the `onProdutoPrecoCustoChanged` Cloud Function
 * (apps/functions) to write one deterministic-id record per custo change —
 * the schema-validated counterpart of the removed client-side history write.
 * The path comes from the schema metadata so it stays a single source of truth.
 */
export const historicoCustoCollection = defineAdminCollection({
  path: historicoCustoMeta.collectionPath,
  schema: historicoCustoSchema,
});
