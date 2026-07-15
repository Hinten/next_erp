import { mensagemMeta, mensagemSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `chat/{conversaId}/mensagem` — the per-conversa
 * message subcollection. Writes are validated against `mensagemSchema`
 * before they hit Firestore. Used by server-side channel pipelines (e.g.
 * the WhatsApp inbound webhook, #527, and the outbound sender, #529) that
 * write messages outside a browser session.
 */
export const mensagemCollection = defineAdminCollection({
  path: mensagemMeta.collectionPath,
  schema: mensagemSchema,
});
