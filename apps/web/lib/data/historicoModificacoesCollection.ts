import { defineCollection } from '@delfrance/data';
import { historicoModificacaoMeta, historicoModificacaoSchema } from '@delfrance/schemas';

/**
 * Unified modification history — `produtos/{id}/historicoDeModificacoes`.
 * One doc per Firestore CloudEvent that touches the produto, written
 * EXCLUSIVELY by the `onProdutoChanged` trigger family (Admin SDK, see
 * `apps/functions`); this client handle is read-only (`meta.serverOwned`).
 * Supersedes the per-field `historicoDePrecos`/`historicoDeCusto`
 * subcollections as the source for `ProdutoHistoryButton` — those legacy
 * subcollections hold migrated rows from the old Flutter app but no client
 * code here reads them anymore.
 */
export const historicoModificacoesCollection = defineCollection({
  path: historicoModificacaoMeta.collectionPath,
  schema: historicoModificacaoSchema,
});
