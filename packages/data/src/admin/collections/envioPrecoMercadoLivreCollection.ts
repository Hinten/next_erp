import { envioPrecoMercadoLivreSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `enviosPrecoMercadoLivre` price-sync
 * job/checkpoint doc (Step 11 PR-C) — the authed "Atualizar preços" route
 * creates the job (doc id = the job id; one ACTIVE job per conta, enforced by
 * the writer, `startPriceSyncJob`), the nested Cloud Function
 * (`processMercadoLivrePriceSync`) drives it to completion, and the status
 * route reads it back for the UI to poll. Admin-only / default-deny (the
 * schema is not in `ALL_DOMAINS`), so there is no client access and no
 * generated rules block.
 */
export const envioPrecoMercadoLivreCollection = defineAdminCollection({
  path: 'enviosPrecoMercadoLivre',
  schema: envioPrecoMercadoLivreSchema,
});
