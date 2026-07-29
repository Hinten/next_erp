import { impostoProdutoMeta } from '@delfrance/schemas';

import {
  makeModificationHistoryTrigger,
  type ModificationHistorySource,
} from '../lib/modificationHistory';

/**
 * `produtos/{produtoId}/imposto/{docId}` modification-history trigger (doc id
 * is the operação id — one doc per operação override). Churned by the
 * produto editor's Impostos tab. `id` mirrors the doc id (never a meaningful
 * edit) and `timestamp` is the per-write stamp every save touches, so both
 * are dropped from the diff. A delete of an imposto doc records a
 * `kind: 'delete'` entry carrying the pre-delete values of every
 * NON-ignored field (`old` = the values, `new` = null; `id`/`timestamp`
 * stay out) — the factory's default delete behavior, exercised by the
 * emulator suite.
 *
 * `requireParentExists: true` guards the same cascade race as extraData: a
 * produto delete's subtree walk (`onProdutoDeleted`) sweeps this
 * subcollection too, so a delete-of-imposto write racing that cascade must
 * not record (and therefore orphan) an entry under an already-gone produto.
 *
 * Exported for the offline + emulator suites; `makeModificationHistoryTrigger`
 * targets the NAMED `default` database (gotcha #8).
 */
export const impostoHistorySource: ModificationHistorySource = {
  subcolecao: 'imposto',
  ignoreFields: ['id', 'timestamp'],
  requireParentExists: true,
  resolve(params) {
    // Both wildcards are always present at runtime; the Record index type
    // can't know that (same cast as `onEstoqueDeleted`).
    const { produtoId, docId } = params as { produtoId: string; docId: string };
    return { produtoId, docId, path: `produtos/${produtoId}/imposto/${docId}` };
  },
};

export const onProdutoImpostoChanged = makeModificationHistoryTrigger(
  `${impostoProdutoMeta.collectionPath}/{docId}`,
  impostoHistorySource,
);
