import { logger } from 'firebase-functions';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { deleteDocumentSubtree } from '@delfrance/data/admin';
import { categoriaCollection } from '@delfrance/data/admin/collections';
import { categoriaMeta } from '@delfrance/schemas';

import { getDb } from '../lib/admin';

/**
 * On `categorias/{id}` delete, sweep the `imposto` subcollection (the
 * per-operação tax overrides — the legacy Dart getter was named
 * `impostocategoria`, but its Firestore collection id is `imposto`, see
 * `impostoCategoriaMeta`). Unlike operação, the web app never had ANY
 * client-side cascade for categoria — a plain `deleteDoc` on the categoria
 * page/list leaves `imposto` permanently orphaned today. This trigger closes
 * that gap the same way #136/#199/#226 closed it for produto/estoque (#354).
 *
 * ⚠️ NOT `db.recursiveDelete` (#728) — issues a kindless all-descendants query
 * Firestore Enterprise cannot index and bills as a silent full scan.
 * `deleteDocumentSubtree` asks `listCollections()` (~5 read units) and runs one
 * kinded, key-bounded query per subcollection that actually holds documents, so
 * any subcollection a categoria carries — including one no schema here declares
 * — is reclaimed without touching this file.
 */
export async function cascadeCategoriaDeletion(db: Firestore, categoriaId: string): Promise<void> {
  await deleteDocumentSubtree(db, categoriaCollection.docRef(db, {}, categoriaId));
}

/**
 * Targets the repo's NAMED `default` Firestore database (gotcha #8); a trigger
 * that omits `database` binds to `(default)` and never fires.
 */
export const onCategoriaDeleted = onDocumentDeleted(
  {
    document: `${categoriaMeta.collectionPath}/{categoriaId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    const { categoriaId } = event.params as { categoriaId: string };
    await cascadeCategoriaDeletion(getDb(), categoriaId);
    logger.info(`onCategoriaDeleted: ${categoriaId} → imposto deleted`);
  },
);
