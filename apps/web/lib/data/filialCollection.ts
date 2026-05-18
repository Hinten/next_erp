import { filialSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Singleton handle for the `filiais` Firestore collection — the fiscal units
 * (CNPJ) of the grupo econômico. Exposes a Zod-validated converter, doc/
 * collection refs, and a path resolver.
 */
export const filialCollection = defineCollection({
  path: 'filiais',
  schema: filialSchema,
});
