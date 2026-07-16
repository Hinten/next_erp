import { credenciaisWhatsappMeta, credenciaisWhatsappSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `integracao/{integracaoId}/credenciaisWhatsapp` — the
 * WhatsApp permanent-token store. Admin-only / default-deny (see
 * `credenciaisWhatsappMeta`); server-side only, the browser never touches
 * these. Mirrors `credenciaisIntegracaoCollection`.
 */
export const credenciaisWhatsappCollection = defineAdminCollection({
  path: credenciaisWhatsappMeta.collectionPath,
  schema: credenciaisWhatsappSchema,
});
