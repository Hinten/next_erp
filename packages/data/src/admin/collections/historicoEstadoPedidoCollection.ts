import { historicoEstadoPedidoMeta, historicoEstadoPedidoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `pedidos/{pedidoId}/historicoEstadoPedido` — the pedido
 * estado audit trail.
 *
 * ONE writer, and it is not in this package: the `onPedidoChanged` trigger
 * (`apps/functions/src/pedidos/registrarHistoricoPedido.ts`) observes every write
 * to `pedidos/{pedidoId}` and appends a row per `estado` transition. Both admin
 * reconciles in `../pedidoReconcile.ts` deliberately write NOTHING here — they
 * did until #697, which moved the append off the call sites so coverage would be
 * total (they covered 3 of ~12 estado-changing paths) and so
 * `historicoEstadoPedidoMeta.serverOwned` could deny every client write.
 */
export const historicoEstadoPedidoCollection = defineAdminCollection({
  path: historicoEstadoPedidoMeta.collectionPath,
  schema: historicoEstadoPedidoSchema,
});
