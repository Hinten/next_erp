import { defineCollection } from '@delfrance/data';
import { incidenteSchema } from '@delfrance/schemas';

/**
 * Subcollection: `pedidos/{pedidoId}/incidentes` — order issues (mediation,
 * return, exchange, late delivery, …) shown + edited in the Incidentes tab.
 */
export const incidenteCollection = defineCollection({
  path: 'pedidos/{pedidoId}/incidentes',
  schema: incidenteSchema,
});
