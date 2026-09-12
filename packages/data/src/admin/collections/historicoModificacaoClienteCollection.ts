import { historicoModificacaoClienteMeta, historicoModificacaoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the `clientes/{clienteId}/historicoDeModificacoes`
 * subcollection — the cliente twin of {@link historicoModificacaoCollection}.
 *
 * Written by the `apps/functions` cliente trigger family (`onClienteChanged`
 * for the cliente document itself, `onEnderecoChanged` for its covered
 * `enderecos` subcollection), one deterministic-id record per CloudEvent
 * (`docId` = the triggering event's `eventId`). Rows for the subcollection
 * carry `subcolecao: 'enderecos'`, so the whole cliente reads as ONE
 * chronological feed.
 *
 * The path comes from the schema metadata so it stays a single source of
 * truth; the collection is `meta.serverOwned` — no client ever writes it.
 */
export const historicoModificacaoClienteCollection = defineAdminCollection({
  path: historicoModificacaoClienteMeta.collectionPath,
  schema: historicoModificacaoSchema,
});
