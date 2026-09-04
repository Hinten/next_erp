import { webchatSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Singleton handle for the `webchat` Firestore collection — embeddable
 * webchat widget configurations (`/canais/webchat`). Exposes a Zod-validated
 * converter, doc/collection refs, and a path resolver.
 */
export const webchatCollection = defineCollection({
  path: 'webchat',
  schema: webchatSchema,
});
