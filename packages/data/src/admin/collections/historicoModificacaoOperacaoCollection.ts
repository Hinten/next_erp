import { historicoModificacaoOperacaoMeta, historicoModificacaoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the `operacao/{operacaoId}/historicoDeModificacoes`
 * subcollection — the operação twin of {@link historicoModificacaoCollection}.
 *
 * Written by the `apps/functions` operação trigger family
 * (`onOperacaoChanged` for the operação document itself,
 * `onRegraImpostoChanged` for its covered `regras` subcollection), one
 * deterministic-id record per CloudEvent (`docId` = the triggering event's
 * `eventId`). Rows for the subcollection carry `subcolecao: 'regras'`, so the
 * whole operação reads as ONE chronological feed.
 *
 * The path comes from the schema metadata so it stays a single source of
 * truth; the collection is `meta.serverOwned` — no client ever writes it.
 */
export const historicoModificacaoOperacaoCollection = defineAdminCollection({
  path: historicoModificacaoOperacaoMeta.collectionPath,
  schema: historicoModificacaoSchema,
});
