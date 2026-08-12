import { importacaoMercadoLivreSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `importacoesMercadoLivre` mass-import
 * job/checkpoint doc (#621) — the authed `importar-todos` route creates the
 * job, the nested Cloud Function (`processMercadoLivreMassImport`) drives it
 * to completion, and the status route reads it back for the UI to poll.
 * Admin-only / default-deny (the schema is not in `ALL_DOMAINS`), so there is
 * no client access and no generated rules block.
 */
export const importacaoMercadoLivreCollection = defineAdminCollection({
  path: 'importacoesMercadoLivre',
  schema: importacaoMercadoLivreSchema,
});
