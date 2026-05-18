import { lixeiraSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Singleton handle for the top-level `lixeira` collection — the snapshots of
 * deleted documents written by the `onDelete` Cloud Function trigger. Backs
 * the "Itens excluídos" recovery view.
 */
export const lixeiraCollection = defineCollection({
  path: 'lixeira',
  schema: lixeiraSchema,
});
