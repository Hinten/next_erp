import { usuarioSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Singleton handle for the `usuarios` Firestore collection. Document IDs are
 * Firebase Auth UIDs. User CREATION goes through the apps/integrations admin
 * endpoint (Admin SDK required to mint Auth users + set custom claims); the
 * web app reads/edits the doc directly.
 */
export const usuarioCollection = defineCollection({
  path: 'usuarios',
  schema: usuarioSchema,
});
