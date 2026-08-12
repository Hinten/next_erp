import { notificacaoMercadoLivreSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `notificacoesMercadoLivre` inbound webhook log
 * — the receiver route persists here (keyed by the ML `_id`) and the nested
 * Cloud Functions read/reprocess. Admin-only / default-deny (the schema is not
 * in `ALL_DOMAINS`), so there is no client access and no generated rules block.
 */
export const notificacaoMercadoLivreCollection = defineAdminCollection({
  path: 'notificacoesMercadoLivre',
  schema: notificacaoMercadoLivreSchema,
});
