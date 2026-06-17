import { pedidoMeta, pedidoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the `pedidos` collection. The Melhor Envio freight
 * routes in apps/integrations use it to anchor a bought label
 * (`freteInicial.printLabelId`, persisted before checkout) and to apply
 * estado/codRastreio updates — including the webhook receiver, which finds the
 * pedido by `freteInicial.printLabelId`. Those writes use dot-path
 * `docRef().update(...)` (nested-field merge) rather than the full-schema
 * `set`/`merge`, so the rest of the pedido is never revalidated or clobbered.
 */
export const pedidoCollection = defineAdminCollection({
  path: pedidoMeta.collectionPath,
  schema: pedidoSchema,
});
