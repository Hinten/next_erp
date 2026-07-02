import { logger } from 'firebase-functions';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { estoqueCollection } from '@delfrance/data/admin/collections';
import { produtoMeta } from '@delfrance/schemas';

import { getDb } from '../lib/admin';

/**
 * On `produtos/{produtoId}` delete (parent OR variation child), cascade-delete the
 * produto's `estoques` docs and each one's nested `historicoEstoque` (#226) — one
 * `recursiveDelete` over the `estoques` subcollection (the Admin SDK walks the
 * whole subtree via a BulkWriter). The client-side `deleteProdutoCascade` (#199)
 * only deletes the produto docs; this trigger reclaims the subcollections Firestore
 * would otherwise orphan (#136), with no dependency on the client.
 *
 * Scoped to the estoque subtree for this issue — a produto-wide
 * `recursiveDelete(produtoRef)` would be the broader #136 sweep. Targets the NAMED
 * `default` database (gotcha #8).
 */
export const onProdutoDeleted = onDocumentDeleted(
  {
    document: `${produtoMeta.collectionPath}/{produtoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    const { produtoId } = event.params;
    const db = getDb();
    await db.recursiveDelete(estoqueCollection.ref(db, { produtoId }));
    logger.info(`onProdutoDeleted: ${produtoId} → estoques subtree deleted`);
  },
);
