import { depositoSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Singleton handle for the `depositos` Firestore collection. Exposes a
 * Zod-validated converter, doc/collection refs, and a path resolver.
 */
export const depositoCollection = defineCollection({
  path: 'depositos',
  schema: depositoSchema,
});
