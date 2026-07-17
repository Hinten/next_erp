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

/**
 * Collection-group id for `collectionGroup('nfev4')` queries — the last
 * segment of `nfeCollection`'s path. Shared by the mass-export query
 * (`lib/nfe/export/exportQuery.ts`) and the comunicações chave resolution
 * (`app/(app)/nfe/comunicacoes/_lib/resolveChaves.ts`).
 */
export const NFEV4_COLLECTION_GROUP = 'nfev4';
