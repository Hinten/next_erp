import { cargoMeta, cargoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/** Admin-SDK handle for the `cargos` collection (schema-validated reads/writes). */
export const cargoCollection = defineAdminCollection({
  path: cargoMeta.collectionPath,
  schema: cargoSchema,
});
