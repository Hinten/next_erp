import { motivoIncidenteSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Singleton handle for the `motivosincidentes` Firestore collection. Exposes
 * a Zod-validated converter, doc/collection refs, and a path resolver.
 */
export const motivoIncidenteCollection = defineCollection({
  path: 'motivosincidentes',
  schema: motivoIncidenteSchema,
});
