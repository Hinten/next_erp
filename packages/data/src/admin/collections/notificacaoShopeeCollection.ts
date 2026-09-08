import { notificacaoShopeeSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `notificacoesShopee` inbound push log — the
 * apps/shopee receiver persists here (keyed by a doc id DERIVED from the push,
 * since Shopee sends no event id) and the nested Cloud Functions
 * read/reprocess. Admin-only / default-deny (the schema is not in
 * `ALL_DOMAINS`), so there is no client access and no generated rules block.
 * Mirrors `notificacaoMercadoPagoCollection`.
 */
export const notificacaoShopeeCollection = defineAdminCollection({
  path: 'notificacoesShopee',
  schema: notificacaoShopeeSchema,
});
