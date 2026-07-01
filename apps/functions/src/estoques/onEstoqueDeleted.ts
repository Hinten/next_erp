import { logger } from 'firebase-functions';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { historicoEstoqueCollection } from '@delfrance/data/admin/collections';
import { estoqueProdutoMeta } from '@delfrance/schemas';

import { getDb } from '../lib/admin';

/**
 * On `produtos/{produtoId}/estoques/{estoqueId}` delete, sweep that estoque's
 * `historicoEstoque` records (Firestore never cascades subcollections) with a
 * single `recursiveDelete`. Covers the standalone case — one estoque deleted via
 * the UI or a future reconcile sweep; the produto-wide cascade (`onProdutoDeleted`)
 * already deletes history directly, so re-fires from THAT path find it gone (a
 * no-op).
 *
 * Targets the repo's NAMED `default` Firestore database (gotcha #8); a trigger that
 * omits `database` binds to `(default)` and never fires.
 */
export const onEstoqueDeleted = onDocumentDeleted(
  {
    document: `${estoqueProdutoMeta.collectionPath}/{estoqueId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    // The middle `{produtoId}` wildcard sits inside the meta-derived path prefix,
    // so its type isn't inferred into `event.params` (only the trailing
    // `{estoqueId}` is) — both are present at runtime.
    const { produtoId, estoqueId } = event.params as { produtoId: string; estoqueId: string };
    const db = getDb();
    await db.recursiveDelete(historicoEstoqueCollection.ref(db, { produtoId, estoqueId }));
    logger.info(`onEstoqueDeleted: ${produtoId}/${estoqueId} → historicoEstoque deleted`);
  },
);
