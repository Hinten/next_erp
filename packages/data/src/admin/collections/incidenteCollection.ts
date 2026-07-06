import { incidenteMeta, incidenteSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `pedidos/{pedidoId}/incidentes` — pedido incidents.
 * Server writer: the pedido→estoque sync (`sincronizarEstoquePedido`,
 * apps/functions) records an `estoque-drift` incidente when its
 * `quantidadeReservada` clamp absorbs a release (#408) — the queryable
 * counterpart of the log-only warning.
 */
export const incidenteCollection = defineAdminCollection({
  path: incidenteMeta.collectionPath,
  schema: incidenteSchema,
});
