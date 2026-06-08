import { arquivoMeta, arquivoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the `arquivos` collection (file metadata). Used by the
 * storage Cloud Functions (`apps/functions`): the resize function writes the
 * derivative `Arquivo` docs through it (schema-validated), and the cleanup
 * functions read/delete through it. The path comes from the schema metadata so
 * it stays a single source of truth.
 */
export const arquivoCollection = defineAdminCollection({
  path: arquivoMeta.collectionPath,
  schema: arquivoSchema,
});
