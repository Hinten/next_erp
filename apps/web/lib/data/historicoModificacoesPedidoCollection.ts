import { defineCollection } from '@delfrance/data';
import { historicoModificacaoPedidoMeta, historicoModificacaoSchema } from '@delfrance/schemas';

/**
 * Unified modification history — `pedidos/{pedidoId}/historicoDeModificacoes`.
 *
 * One doc per Firestore CloudEvent that touches the pedido OR one of its
 * covered subcollections (`pagamentos`, `incidentes` — tagged by `subcolecao`),
 * written EXCLUSIVELY by the pedido trigger family in `apps/functions`. This
 * client handle is read-only (`meta.serverOwned` denies every client write, with
 * no `su` bypass), and it is what the pedido editor's Modificações tab reads.
 */
export const historicoModificacoesPedidoCollection = defineCollection({
  path: historicoModificacaoPedidoMeta.collectionPath,
  schema: historicoModificacaoSchema,
});
