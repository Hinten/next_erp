import { bandeiraCartaoSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Singleton handle for the `bandeirasCartao` Firestore collection. Exposes a
 * Zod-validated converter, doc/collection refs, and a path resolver.
 */
export const bandeiraCartaoCollection = defineCollection({
  path: 'bandeirasCartao',
  schema: bandeiraCartaoSchema,
});
