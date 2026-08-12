import { logger } from 'firebase-functions';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { deleteDocumentSubtree } from '@delfrance/data/admin';
import { estoqueCollection } from '@delfrance/data/admin/collections';
import { estoqueProdutoMeta } from '@delfrance/schemas';

import { getDb } from '../lib/admin';

/**
 * On `produtos/{produtoId}/estoques/{estoqueId}` delete, sweep that estoque's
 * `historicoEstoque` records (Firestore never cascades subcollections). Covers
 * the standalone case — one estoque deleted via the UI or a future reconcile
 * sweep; the produto-wide cascade (`onProdutoDeleted`) already walks the same
 * subtree, so re-fires from THAT path find it gone (a no-op).
 *
 * ⚠️ NOT `db.recursiveDelete` (#728). That issued a kindless all-descendants
 * query — ~6,184 documents scanned per call on Firestore Enterprise, which
 * auto-creates no indexes and bills data scanned. This trigger is the worst
 * amplifier of that cost: the produto cascade sweeps every estoque doc, and each
 * one re-fires this trigger. `deleteDocumentSubtree` asks `listCollections()`
 * (~5 read units) and runs one kinded, key-bounded query per subcollection that
 * actually holds documents.
 *
 * The walk starts at the estoque DOC ref rather than its `historicoEstoque`
 * collection ref. Equivalent — the doc is already gone when the trigger fires,
 * so deleting it again is a no-op — but it means a subcollection added to an
 * estoque later is reclaimed without touching this file.
 */
export async function cascadeEstoqueDeletion(
  db: Firestore,
  produtoId: string,
  estoqueId: string,
): Promise<void> {
  await deleteDocumentSubtree(db, estoqueCollection.docRef(db, { produtoId }, estoqueId));
}

/**
 * Targets the repo's NAMED `default` Firestore database (gotcha #8); a trigger
 * that omits `database` binds to `(default)` and never fires.
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
    await cascadeEstoqueDeletion(getDb(), produtoId, estoqueId);
    logger.info(`onEstoqueDeleted: ${produtoId}/${estoqueId} → historicoEstoque deleted`);
  },
);
