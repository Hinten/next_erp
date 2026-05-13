import { clienteSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Singleton handle for the `clientes` Firestore collection. Exposes a
 * Zod-validated converter, doc/collection refs, and a path resolver.
 */
export const clienteCollection = defineCollection({
  path: 'clientes',
  schema: clienteSchema,
});
