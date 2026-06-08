import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { arquivoCollection } from '@delfrance/data/admin/collections';

import { getAdminApp, getDb } from './admin';
import { objectPathOf, shouldDeleteObject } from './orphans';

const REGION = 'us-east1';

/**
 * When an `Arquivo` doc is deleted, delete its Storage object — refcount-aware.
 * Only removes the object when no OTHER `Arquivo` references the same
 * `filepath`+`filename` (the rare intra-product reuse). The refcount query is a
 * plain composite `where()` — pipeline-free, so it works on the emulator.
 *
 * Idempotent: a missing object is ignored (the Flutter client `Arquivo.delete`
 * may already have removed it). Deleting an object fires no trigger → no loop.
 */
export const onArquivoDeleted = onDocumentDeleted(
  { region: REGION, document: 'arquivos/{id}' },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const data = arquivoCollection.parseRead(snap.data(), snap.ref.path);
    const path = objectPathOf(data);
    if (!path) return;

    const db = getDb();
    const others = await arquivoCollection
      .ref(db, {})
      .where('filepath', '==', data.filepath ?? null)
      .where('filename', '==', data.filename)
      .limit(1)
      .get();

    if (!shouldDeleteObject(others.size)) {
      logger.info(`onArquivoDeleted: kept ${path} — still referenced`);
      return;
    }

    await getStorage(getAdminApp())
      .bucket()
      .file(path)
      .delete({ ignoreNotFound: true });
    logger.info(`onArquivoDeleted: removed storage object ${path}`);
  },
);
