import { logger } from 'firebase-functions';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { deleteDocumentSubtree } from '@delfrance/data/admin';
import { balancoCollection } from '@delfrance/data/admin/collections';
import { balancoMeta } from '@delfrance/schemas';

import { getDb } from '../lib/admin';

/**
 * On a `balanco/{balancoId}` delete, sweep its `movimentos` and `relatorios`
 * (Firestore never cascades subcollections).
 *
 * This trigger is not optional the way most cascades are: `relatorios` is
 * `serverOwned`, so the generated rules deny every client write to it — the
 * client physically cannot cascade its own delete, and a deleted balanço would
 * otherwise leave its report orphaned forever.
 *
 * ⚠️ NOT `db.recursiveDelete` (#728): it issues a kindless all-descendants
 * query this Enterprise edition cannot index, full-scans silently, and bills
 * data scanned. `deleteDocumentSubtree` asks `listCollections()` and runs one
 * kinded, key-bounded query per subcollection that actually holds documents.
 *
 * The walk starts at the balanço DOC ref rather than each subcollection, so a
 * subcollection added later is reclaimed without touching this file.
 */
export async function cascadeBalancoDeletion(db: Firestore, balancoId: string): Promise<void> {
  await deleteDocumentSubtree(db, balancoCollection.docRef(db, {}, balancoId));
}

/**
 * Targets the repo's NAMED `default` Firestore database (gotcha #8); a trigger
 * that omits `database` binds to `(default)` and never fires.
 */
export const onBalancoDeleted = onDocumentDeleted(
  {
    document: `${balancoMeta.collectionPath}/{balancoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    const { balancoId } = event.params;
    await cascadeBalancoDeletion(getDb(), balancoId);
    logger.info(`onBalancoDeleted: ${balancoId} → movimentos + relatorios deleted`);
  },
);
