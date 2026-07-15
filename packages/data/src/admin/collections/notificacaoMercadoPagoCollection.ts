import { notificacaoMercadoPagoSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `notificacoesMercadoPago` inbound webhook log
 * — the apps/mercado-pago receiver persists here (keyed by the MP
 * notification `id`) and the nested Cloud Functions read/reprocess.
 * Admin-only / default-deny (the schema is not in `ALL_DOMAINS`), so there is
 * no client access and no generated rules block. Mirrors
 * `notificacaoMercadoLivreCollection`.
 */
export const notificacaoMercadoPagoCollection = defineAdminCollection({
  path: 'notificacoesMercadoPago',
  schema: notificacaoMercadoPagoSchema,
});
