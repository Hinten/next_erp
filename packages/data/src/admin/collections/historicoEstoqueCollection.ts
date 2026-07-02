import { historicoEstoqueMeta, historicoEstoqueSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the
 * `produtos/{produtoId}/estoques/{estoqueId}/historicoEstoque` subcollection
 * (the per-movement audit log). Used by the estoque Cloud Functions: the
 * `aplicarEstoque` callable appends one validated record per movement inside the
 * transaction, and the cascade triggers sweep it on estoque/produto deletion.
 * The path comes from the schema metadata so it stays a single source of truth.
 */
export const historicoEstoqueCollection = defineAdminCollection({
  path: historicoEstoqueMeta.collectionPath,
  schema: historicoEstoqueSchema,
});
