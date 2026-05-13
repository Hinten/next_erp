import { defineCollection } from '@delfrance/data';
import { produtoSchema } from '@delfrance/schemas';

/**
 * Singleton handle for the `produtos` Firestore collection. Mirrors the
 * Flutter app's collection path so both apps coexist on the same docs.
 */
export const produtoCollection = defineCollection({
  path: 'produtos',
  schema: produtoSchema,
});
