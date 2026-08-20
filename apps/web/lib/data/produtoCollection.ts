import { defineCollection } from '@delfrance/data';
import { produtoSchema } from '@delfrance/schemas';

/**
 * Singleton handle for the `produtos` Firestore collection. Mirrors the
 * Flutter app's collection path, which is where the migrated corpus sits.
 */
export const produtoCollection = defineCollection({
  path: 'produtos',
  schema: produtoSchema,
});
