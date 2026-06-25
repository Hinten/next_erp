import { tabelaDeMedidasSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Singleton handle for the `tabMedi` (tabela de medidas / moda) Firestore
 * collection. Exposes a Zod-validated converter plus doc/collection refs.
 * The collection path matches the Flutter wire name so existing data keeps
 * working without a migration.
 */
export const tabelaDeMedidasCollection = defineCollection({
  path: 'tabMedi',
  schema: tabelaDeMedidasSchema,
});
