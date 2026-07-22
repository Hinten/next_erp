import { orderMLMeta, orderMLSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `pedidos/{pedidoId}/orderML` — the byte-faithful
 * Mercado Livre order mirror (dual-run coexistence with the still-deployed
 * Flutter app; see `orderMLSchema`'s doc comment). The Step 9 order-import
 * transaction (`apps/mercado-livre`) uses it to read every child order
 * IN-TRANSACTION (a pack pedido holds several) and to upsert the incoming
 * order's mirror doc at its deterministic `String(order.id)` key.
 */
export const orderMLCollection = defineAdminCollection({
  path: orderMLMeta.collectionPath,
  schema: orderMLSchema,
});
