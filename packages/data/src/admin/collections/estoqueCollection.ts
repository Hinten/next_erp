import { estoqueProdutoMeta, estoqueProdutoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the `produtos/{produtoId}/estoques` subcollection
 * (per-warehouse stock). Used by the estoque Cloud Functions (`apps/functions`):
 * the `aplicarEstoque` callable creates/updates the estoque doc through it
 * (schema-validated) inside a transaction, and the cascade triggers
 * (`onProdutoDeleted` / `onEstoqueDeleted`) list/delete through it. The path
 * comes from the schema metadata so it stays a single source of truth.
 */
export const estoqueCollection = defineAdminCollection({
  path: estoqueProdutoMeta.collectionPath,
  schema: estoqueProdutoSchema,
});
