import { historicoModificacaoMeta, historicoModificacaoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the `produtos/{produtoId}/historicoDeModificacoes`
 * subcollection. Used by the `onProdutoChanged` Cloud Function
 * (apps/functions) to write one deterministic-id record (`docId` = the
 * triggering event's `eventId`) per changed produto write. The path comes
 * from the schema metadata so it stays a single source of truth; the
 * collection itself is `meta.serverOwned` — no client ever writes it.
 */
export const historicoModificacaoCollection = defineAdminCollection({
  path: historicoModificacaoMeta.collectionPath,
  schema: historicoModificacaoSchema,
});
