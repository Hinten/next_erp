import { historicoModificacaoPedidoMeta, historicoModificacaoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the `pedidos/{pedidoId}/historicoDeModificacoes`
 * subcollection — the pedido twin of {@link historicoModificacaoCollection}.
 *
 * Written by the `apps/functions` pedido trigger family
 * (`onPedidoEstadoChanged` for the pedido document itself, `onPagamentoChanged`
 * and `onIncidenteChanged` for its covered subcollections), one deterministic-id
 * record per CloudEvent (`docId` = the triggering event's `eventId`). Rows for
 * the subcollections carry `subcolecao: 'pagamentos' | 'incidentes'`, so the
 * whole pedido reads as ONE chronological feed.
 *
 * The path comes from the schema metadata so it stays a single source of truth;
 * the collection is `meta.serverOwned` — no client ever writes it.
 */
export const historicoModificacaoPedidoCollection = defineAdminCollection({
  path: historicoModificacaoPedidoMeta.collectionPath,
  schema: historicoModificacaoSchema,
});
