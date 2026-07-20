import { categoriaMeta, categoriaSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the `categorias` collection. Used by the ML import (#442)
 * to create the ERP Categoria chain from an ML category.
 */
export const categoriaCollection = defineAdminCollection({
  path: categoriaMeta.collectionPath,
  schema: categoriaSchema,
});
