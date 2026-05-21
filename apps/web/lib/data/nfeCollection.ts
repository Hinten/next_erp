import { defineCollection } from '@delfrance/data';
import { nfeSchema } from '@delfrance/schemas';

/**
 * Subcollection: `pedidos/{pedidoId}/nfev4`. Use the {pedidoId}
 * placeholder in the path context. Each doc is keyed by NFe `chave`
 * (44-digit). The TableView's NF cell subscribes to the latest doc
 * (orderBy timestamp desc, limit 1) to display the current state.
 */
export const nfeCollection = defineCollection({
  path: 'pedidos/{pedidoId}/nfev4',
  schema: nfeSchema,
});
