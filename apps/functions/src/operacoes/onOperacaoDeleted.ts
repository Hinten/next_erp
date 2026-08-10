import { logger } from 'firebase-functions';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { deleteDocumentSubtree } from '@delfrance/data/admin';
import { operacaoCollection } from '@delfrance/data/admin/collections';
import { operacaoMeta } from '@delfrance/schemas';

import { getDb } from '../lib/admin';

/**
 * On `operacao/{id}` delete, sweep the `regras` subcollection PR #352's
 * client-side `deleteOperacaoCascade` used to batch-delete itself (Firestore
 * never cascades subcollections). Same decision #136/#199/#226 already made
 * for produto/estoque: move the cascade server-side and let the client only
 * delete the parent doc (#354).
 *
 * ⚠️ NOT `db.recursiveDelete` (#728) — that issues a kindless all-descendants
 * query Firestore Enterprise cannot index and bills as a silent full scan.
 * `deleteDocumentSubtree` asks `listCollections()` (~5 read units) and runs one
 * kinded, key-bounded query per subcollection that actually holds documents, so
 * a subcollection added later (or one only Flutter ever wrote) is reclaimed
 * without touching this file.
 *
 * The walk starts at the operação DOC ref rather than its `regras` collection
 * ref — equivalent, since the doc is already gone when the trigger fires, but
 * it means any subcollection an operação carries is reclaimed generically.
 */
export async function cascadeOperacaoDeletion(db: Firestore, operacaoId: string): Promise<void> {
  await deleteDocumentSubtree(db, operacaoCollection.docRef(db, {}, operacaoId));
}

/**
 * Targets the repo's NAMED `default` Firestore database (gotcha #8); a trigger
 * that omits `database` binds to `(default)` and never fires.
 */
export const onOperacaoDeleted = onDocumentDeleted(
  {
    document: `${operacaoMeta.collectionPath}/{operacaoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    const { operacaoId } = event.params as { operacaoId: string };
    await cascadeOperacaoDeletion(getDb(), operacaoId);
    logger.info(`onOperacaoDeleted: ${operacaoId} → regras deleted`);
  },
);
