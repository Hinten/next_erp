import { logger } from 'firebase-functions';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { deleteDocumentSubtree } from '@delfrance/data/admin';
import type { CollectionMetadata } from '@delfrance/schemas';

import { getDb } from './admin';

/**
 * CARO GENÉRICO — one delete cascade that works for any collection, at a price
 * per delete that only makes sense when deletes are RARE.
 *
 * Firestore never cascades subcollections, so a client `deleteDoc` on a parent
 * leaves every child orphaned forever. The five domains that cared enough wrote
 * a bespoke trigger each (`onProdutoDeleted`, `onOperacaoDeleted`,
 * `onCategoriaDeleted`, `onBalancoDeleted`, `onNfeDeleted`), and they are all
 * the same fifteen lines. This factory is those fifteen lines, once.
 *
 * ## Why "caro"
 *
 * `deleteDocumentSubtree` discovers children with `listCollections()` on **every
 * document it reaches**, leaves included — a document with no subcollections
 * still costs a call to find that out. So the toll scales with the SIZE of the
 * subtree, not just with what has to be deleted: a parent with 50 leaf children
 * pays 51 discovery calls, 50 of them returning nothing.
 *
 * That is a bargain next to the alternative (below) and invisible on a
 * two-document credential subtree deleted a few times a month. It is NOT
 * invisible on a hot delete path or a wide subtree. **Use this factory where the
 * delete flow is low; write something targeted where it is not** — a known,
 * single subcollection wants one kinded paged sweep and zero discovery.
 *
 * ## Why not `db.recursiveDelete` (#728 / #729)
 *
 * It is the obvious tool and it is banned here. It issues one **kindless**
 * all-descendants query — `COLLECTION_GROUP * SELECT __name__ LIMIT 5000` — that
 * Firestore Enterprise cannot index and cannot be GIVEN an index for: no
 * wildcard index exists and there is no field predicate to seek on, so the
 * console's "create index" button opens a blank form. Nothing throws; Enterprise
 * simply bills data scanned. Measured on staging: **~6,184 documents per call**,
 * 9,234 calls in 7 days = 93% of the project's read volume. And the query fires
 * *before anything is known about the subtree*, so "this delete is rare" buys
 * less than it looks — the price is identical for an empty subtree and a huge
 * one. Verify live with `scripts/check-delete-cost.mjs`.
 *
 * ## Why the walk is discovery-driven, not meta-driven
 *
 * It would be tidier to sweep exactly the paths a domain declares in
 * `meta.cascade`. It would also be WRONG: Flutter writes subcollections this
 * repo never registered, and `integracaoMeta.cascade` already omits
 * `brandshopee`, which this factory reclaims anyway. See the ⚠️ in
 * `packages/data/src/admin/deleteSubtree.ts`.
 */

/**
 * Delete `<collectionPath>/<docId>` and everything beneath it.
 *
 * Exported so the emulator suite drives the SAME code the trigger runs — the
 * convention every `*.storage.test.ts` in this package follows, since trigger
 * delivery on a named database is awkward to exercise in the emulator.
 *
 * Idempotent, and safe on a document that is already gone: subcollections
 * outlive their parent, which is exactly the orphan an `onDocumentDeleted`
 * cascade exists to reclaim. That matters beyond retries — the legacy Flutter
 * app still runs its own `deleteCascade` against these same documents.
 */
export async function cascadeCaroGenerico(
  db: Firestore,
  collectionPath: string,
  docId: string,
): Promise<void> {
  const report = await deleteDocumentSubtree(db, db.collection(collectionPath).doc(docId));

  // The cost the name warns about, per delete, in production rather than in
  // folklore: `collectionsVisited` IS the listCollections() count.
  logger.info(
    `cascadeCaroGenerico: ${collectionPath}/${docId} → ` +
      `${report.documentsDeleted} docs, ${report.collectionsVisited} listCollections, ` +
      `${report.queriesIssued} queries`,
    { truncated: report.truncated, failedDeletes: report.failedDeletes },
  );

  if (report.failedDeletes > 0) {
    logger.error(
      `cascadeCaroGenerico: ${collectionPath}/${docId} left ${report.failedDeletes} document(s) behind`,
      report.firstError,
    );
  }
}

/**
 * Build the `onDocumentDeleted` trigger for a collection's subtree cascade.
 *
 * ⚠️ Targets the repo's NAMED `default` Firestore database (gotcha #8); a
 * trigger that omits `database` binds to `(default)` and never fires — silently,
 * which is the worst way for a cascade to fail.
 */
export function defineCascadeCaroGenerico(meta: CollectionMetadata) {
  return onDocumentDeleted(
    {
      document: `${meta.collectionPath}/{docId}`,
      database: process.env.FIREBASE_DATABASE_ID ?? 'default',
    },
    async (event) => {
      const { docId } = event.params as { docId: string };
      await cascadeCaroGenerico(getDb(), meta.collectionPath, docId);
    },
  );
}
