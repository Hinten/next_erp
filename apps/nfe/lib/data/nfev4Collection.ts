import { defineAdminCollection } from '@delfrance/data/admin';
import { nfeMeta, nfeSchema } from '@delfrance/schemas';

/**
 * Admin-SDK handle for the per-pedido `nfev4` subcollection
 * (`pedidos/{pedidoId}/nfev4`). Every NF-e document write — the
 * `estado='enviando'` anchor, the placeholder, and the post-SOAP state
 * patches — is schema-validated through this handle. The path is taken
 * from the schema metadata so it stays a single source of truth.
 */
export const nfev4Collection = defineAdminCollection({
  path: nfeMeta.collectionPath,
  schema: nfeSchema,
});
