import { produtoMeta, produtoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the `produtos` collection. Used by the storage cleanup
 * Cloud Function (`cleanupOrphanArquivos`) to scan `fotos`/`videos`/`anexos`
 * references when deciding which `Arquivo` docs are orphaned.
 */
export const produtoCollection = defineAdminCollection({
  path: produtoMeta.collectionPath,
  schema: produtoSchema,
});
