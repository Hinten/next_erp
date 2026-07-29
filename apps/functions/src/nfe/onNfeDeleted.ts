import { logger } from 'firebase-functions';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { deleteDocumentSubtree } from '@delfrance/data/admin';
import { nfev4Collection } from '@delfrance/data/admin/collections';
import { nfeMeta } from '@delfrance/schemas';

import { getDb } from '../lib/admin';

/**
 * On a DIRECT `pedidos/{pedidoId}/nfev4/{nfeId}` delete, sweep that NF-e's
 * `cartacorrecao` subcollection (Firestore never cascades subcollections) with a
 * `deleteDocumentSubtree` over the NF-e doc ref. The walk reaches the descendant
 * subtree regardless of whether the (already-gone) parent doc still exists, so it
 * reclaims the CC-e records the delete would otherwise orphan.
 *
 * ⚠️ NOT `db.recursiveDelete` (#728): that issues a kindless all-descendants
 * query billed at ~6,184 documents scanned per call on Firestore Enterprise,
 * whether or not the NF-e has a single CC-e. `deleteDocumentSubtree` asks
 * `listCollections()` (~5 read units) and then runs one kinded, key-bounded
 * query per subcollection that actually exists.
 *
 * Covers the STANDALONE case — a single NF-e document deleted server-side
 * (Admin SDK / orchestrator; nfev4 is client-read-only, so client deletes can't
 * reach here). The parent-`pedidos` subtree walk already reclaims the same
 * subtree when a whole pedido is deleted, so a re-fire from THAT path finds the
 * NF-e gone — deleting an absent doc is a no-op, so there is no double-delete
 * conflict.
 *
 * Mirrors the `onEstoqueDeleted` precedent (single-doc subtree reclaim). Targets
 * the repo's NAMED `default` Firestore database (gotcha #8); a trigger that omits
 * `database` binds to `(default)` and never fires.
 */
export async function cascadeNfeDeletion(
  db: Firestore,
  pedidoId: string,
  nfeId: string,
): Promise<void> {
  await deleteDocumentSubtree(db, nfev4Collection.docRef(db, { pedidoId }, nfeId));
}

export const onNfeDeleted = onDocumentDeleted(
  {
    document: `${nfeMeta.collectionPath}/{nfeId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    // The middle `{pedidoId}` wildcard sits inside the meta-derived path prefix,
    // so its type isn't inferred into `event.params` (only the trailing
    // `{nfeId}` is) — both are present at runtime.
    const { pedidoId, nfeId } = event.params as { pedidoId: string; nfeId: string };
    await cascadeNfeDeletion(getDb(), pedidoId, nfeId);
    logger.info(`onNfeDeleted: ${pedidoId}/${nfeId} → cartacorrecao deleted`);
  },
);
