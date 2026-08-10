import { defineCollection } from '@delfrance/data';
import { movimentoBalancoSchema } from '@delfrance/schemas';

/**
 * The `balanco/{balancoId}/movimentos` subcollection — one doc per lançamento
 * (a scan or a manual entry), append-only from the counting screen.
 *
 * This is a tally, not stock: the client writes here freely, and nothing
 * reaches `estoques` until the `finalizarBalanco` callable aggregates it
 * server-side. Cancelling a lançamento is a `merge()` setting `removido: true`
 * — never a delete, so the withdrawal stays auditable.
 */
export const movimentoBalancoCollection = defineCollection({
  path: 'balanco/{balancoId}/movimentos',
  schema: movimentoBalancoSchema,
});
