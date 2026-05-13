import { categoriaSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Singleton handle for the `categorias` Firestore collection. Exposes a
 * Zod-validated converter, doc/collection refs, and a path resolver.
 */
export const categoriaCollection = defineCollection({
  path: 'categorias',
  schema: categoriaSchema,
});
