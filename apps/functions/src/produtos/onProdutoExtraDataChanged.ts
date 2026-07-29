import { produtoExtraDataMeta } from '@delfrance/schemas';

import {
  makeModificationHistoryTrigger,
  type ModificationHistorySource,
} from '../lib/modificationHistory';

/**
 * `produtos/{produtoId}/extraData/{docId}` modification-history trigger (doc id
 * is always `singleton` — `PRODUTO_EXTRA_DATA_DOC_ID`). Churned by the produto
 * editor's SEO/marketing tab, which wholesale RE-SETS the singleton on every
 * save — `ignoreFields` drops only the two per-write stamps, so an identical
 * re-set (same content, new stamps) leaves an empty diff and
 * `buildModificationEntry` returns `null`: no entry is written, proven by the
 * emulator suite.
 *
 * `requireParentExists: true` guards the one racy case: a produto delete's
 * subtree walk (`onProdutoDeleted`) sweeps this whole subcollection too,
 * so a write here racing that cascade must not record (and therefore orphan)
 * an entry under an already-gone produto.
 *
 * Exported for the offline + emulator suites; `makeModificationHistoryTrigger`
 * targets the NAMED `default` database (gotcha #8).
 */
export const extraDataHistorySource: ModificationHistorySource = {
  subcolecao: 'extraData',
  ignoreFields: ['timestamp', 'ultimaModificacao'],
  requireParentExists: true,
  resolve(params) {
    // Both wildcards are always present at runtime; the Record index type
    // can't know that (same cast as `onEstoqueDeleted`).
    const { produtoId, docId } = params as { produtoId: string; docId: string };
    return { produtoId, docId, path: `produtos/${produtoId}/extraData/${docId}` };
  },
};

export const onProdutoExtraDataChanged = makeModificationHistoryTrigger(
  `${produtoExtraDataMeta.collectionPath}/{docId}`,
  extraDataHistorySource,
);
