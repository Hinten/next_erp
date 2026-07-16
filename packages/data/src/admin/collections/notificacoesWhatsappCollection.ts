import { notificacoesWhatsappMeta, notificacoesWhatsappSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `notificacoesWhatsapp` inbound webhook log
 * — the apps/whatsapp receiver persists here (keyed by the WA `messageId`
 * when present) and the nested Cloud Functions read/reprocess. Admin-only /
 * default-deny (see `notificacoesWhatsappMeta`), so there is no client
 * access and no generated rules block. Mirrors
 * `notificacaoMercadoPagoCollection`.
 */
export const notificacoesWhatsappCollection = defineAdminCollection({
  path: notificacoesWhatsappMeta.collectionPath,
  schema: notificacoesWhatsappSchema,
});
