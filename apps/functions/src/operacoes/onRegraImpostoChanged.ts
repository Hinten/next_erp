import { regraImpostoMeta } from '@delfrance/schemas';

import { OPERACAO_HISTORY_ROOT } from '../lib/historyRoots';
import {
  makeModificationHistoryTrigger,
  type ModificationHistorySource,
} from '../lib/modificationHistory';

/**
 * `operacao/{operacaoId}/regras/{docId}` modification-history trigger. Rows
 * land in the OPERAÇÃO's `historicoDeModificacoes` (tagged
 * `subcolecao: 'regras'`), not in a subcollection of the regra — the same
 * shape the pedido `pagamentos`/`incidentes` sources and the produto
 * `extraData`/`imposto` sources already use.
 *
 * `id` mirrors the document id (never a meaningful edit — same reasoning as
 * `impostoHistorySource`). `dataCadastro`/`timeStamp` are NOT ignored: the
 * `MacrosTab` editor (`apps/web`) preserves `dataCadastro` verbatim on every
 * edit rather than re-stamping it (it is the list's sort key), so it never
 * churns on its own and needs no guard.
 *
 * `requireParentExists: true` guards the same cascade race as the produto
 * `extraData`/`imposto` sources: an operação delete's subtree walk
 * (`onOperacaoDeleted`) sweeps this subcollection too, so a write here racing
 * that cascade must not record (and therefore orphan) an entry under an
 * already-gone operação.
 *
 * Exported for the offline + emulator suites; `makeModificationHistoryTrigger`
 * targets the NAMED `default` database (gotcha #8).
 */
export const regraImpostoHistorySource: ModificationHistorySource = {
  root: OPERACAO_HISTORY_ROOT,
  subcolecao: 'regras',
  ignoreFields: ['id'],
  requireParentExists: true,
  resolve(params) {
    // Both wildcards are always present at runtime; the Record index type
    // can't know that (same cast as `onEstoqueDeleted`).
    const { operacaoId, docId } = params as { operacaoId: string; docId: string };
    return { parentId: operacaoId, docId, path: `operacao/${operacaoId}/regras/${docId}` };
  },
};

export const onRegraImpostoChanged = makeModificationHistoryTrigger(
  `${regraImpostoMeta.collectionPath}/{docId}`,
  regraImpostoHistorySource,
);
