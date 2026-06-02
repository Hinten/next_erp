import { defineAdminCollection } from '@delfrance/data/admin';
import { cargoMeta, cargoSchema } from '@delfrance/schemas';

/** Admin-SDK handle for the `cargos` collection (schema-validated reads/writes). */
export const cargoCollection = defineAdminCollection({
  path: cargoMeta.collectionPath,
  schema: cargoSchema,
});
