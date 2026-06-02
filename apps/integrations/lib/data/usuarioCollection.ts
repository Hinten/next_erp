import { defineAdminCollection } from '@delfrance/data/admin';
import { usuarioMeta, usuarioSchema } from '@delfrance/schemas';

/**
 * Admin-SDK handle for the `usuarios` collection. Writes are validated against
 * `usuarioSchema` before they hit Firestore; the path comes from the schema's
 * metadata so it stays a single source of truth.
 */
export const usuarioCollection = defineAdminCollection({
  path: usuarioMeta.collectionPath,
  schema: usuarioSchema,
});
