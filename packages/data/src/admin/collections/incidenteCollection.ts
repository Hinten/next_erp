import { incidenteMeta, incidenteSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `pedidos/{pedidoId}/incidentes` — pedido incidents.
 * Server writer: the pedido→estoque sync (`sincronizarEstoquePedido`,
 * apps/functions) records two subtipos, both the queryable counterpart of a
 * log-only warning — `estoque-drift` when its `quantidadeReservada` clamp
 * absorbs a release (#408), and `estoque-reconstrucao-legado` when it had to
 * rebuild a Flutter-era pedido's applied state to move a pack sibling (#795).
 */
export const incidenteCollection = defineAdminCollection({
  path: incidenteMeta.collectionPath,
  schema: incidenteSchema,
});
