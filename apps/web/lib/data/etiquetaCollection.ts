import { etiquetaSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Singleton handle for the `etiquetas` Firestore collection. Exposes a
 * Zod-validated converter, doc/collection refs, and a path resolver.
 */
export const etiquetaCollection = defineCollection({
  path: 'etiquetas',
  schema: etiquetaSchema,
});
