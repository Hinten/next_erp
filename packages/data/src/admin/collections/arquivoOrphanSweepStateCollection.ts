import { arquivoOrphanSweepStateMeta, arquivoOrphanSweepStateSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/** The persisted round-robin cursor doc for `sweepUnreferencedArquivos` (#234). */
export const arquivoOrphanSweepStateCollection = defineAdminCollection({
  path: arquivoOrphanSweepStateMeta.collectionPath,
  schema: arquivoOrphanSweepStateSchema,
});
