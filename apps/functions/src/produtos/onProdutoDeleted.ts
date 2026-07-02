import { logger } from 'firebase-functions';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { produtoCollection } from '@delfrance/data/admin/collections';
import { produtoMeta } from '@delfrance/schemas';

import { getDb } from '../lib/admin';

/**
 * Cascade a produto delete server-side (parent OR variation child):
 *
 *  1. **Subcollection orphans (#136).** `recursiveDelete` on the produto's OWN
 *     document ref deletes the (already-gone) doc plus its ENTIRE descendant
 *     subtree — every subcollection Firestore would otherwise orphan (`estoques`
 *     + `historicoEstoque`, `imposto`, `historicoDePrecos`, `historicoDeCusto`,
 *     `extraData`, and the marketplace links `produtomercadolivre` / `variacoesml`
 *     / `produtoshopee` / …). No name enumeration; new subcollections are swept
 *     automatically. `recursiveDelete` walks subcollections regardless of whether
 *     the parent doc still exists, so it reclaims the orphans.
 *  2. **Variation children (#199).** Children are SIBLING top-level docs
 *     (`produtos where paiId == deletedId`), not descendants, so the sweep above
 *     does not touch them. Each is deleted via its own `recursiveDelete` so its
 *     subtree goes too — cleanup never depends on recursive trigger re-delivery.
 *     Variations are one level deep (children have no children), so the child
 *     delete re-fires this trigger as an idempotent no-op.
 *
 * The client `deleteProdutoCascade` now only deletes the parent doc — this trigger
 * is the authoritative cascade, with no dependency on the client/e2e cleanup.
 * Idempotent (Flutter still cascades on its own deletes). Targets the NAMED
 * `default` database (gotcha #8).
 */
export async function cascadeProdutoDeletion(db: Firestore, produtoId: string): Promise<void> {
  // #136 — the produto's own subtree (all subcollections) in one BulkWriter walk.
  await db.recursiveDelete(produtoCollection.docRef(db, {}, produtoId));

  // #199 — variation children (top-level produtos pointing back via `paiId`).
  const children = await produtoCollection
    .ref(db, {})
    .where('paiId', '==', produtoId)
    .select()
    .get();
  for (const child of children.docs) {
    if (child.id === produtoId) continue; // defensive: never recurse on self
    await db.recursiveDelete(child.ref);
  }
}

export const onProdutoDeleted = onDocumentDeleted(
  {
    document: `${produtoMeta.collectionPath}/{produtoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    const { produtoId } = event.params;
    await cascadeProdutoDeletion(getDb(), produtoId);
    logger.info(`onProdutoDeleted: ${produtoId} → subtree + variation children cascaded`);
  },
);
