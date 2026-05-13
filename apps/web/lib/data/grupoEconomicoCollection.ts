import { GRUPO_ECONOMICO_COLLECTION_PATH, grupoEconomicoSchema } from '@delfrance/core/tenant';
import { defineCollection } from '@delfrance/data';

export const grupoEconomicoCollection = defineCollection({
  path: GRUPO_ECONOMICO_COLLECTION_PATH,
  schema: grupoEconomicoSchema,
});
