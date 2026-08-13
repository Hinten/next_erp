import type { Firestore } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';
import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { arquivoCollection } from '@delfrance/data/admin/collections';
import {
  ARQUIVOS_COLLECTION,
  PRODUCT_IMAGE_VARIANTS,
  derivativeArquivoId,
  ownedDerivativePath,
  parseOwnedOriginalPath,
} from '@delfrance/schemas';

import { getAdminApp, getDb } from '../lib/admin';

type Bucket = ReturnType<Storage['bucket']>;

/** Deleted-doc fields we need to locate the owned Storage object. */
interface DeletedArquivo {
  filepath?: string | null;
  filename?: string;
}

/** Delete a Storage object, tolerating an already-absent one (idempotent). */
async function deleteObject(bucket: Bucket, name: string): Promise<void> {
  await bucket.file(name).delete({ ignoreNotFound: true });
}

/**
 * Doc-anchored Storage cleanup core (shared by the trigger; exported so the
 * emulator suite can exercise it directly without depending on Firestore-trigger
 * delivery for a named database). Deletes the object the deleted `arquivos` doc
 * owned; for a product-image ORIGINAL it cascades to the 3 derivative objects +
 * their docs.
 *
 * Product media is product-scoped (no cross-product object sharing), so an
 * owner-scoped delete is safe without refcounting. Idempotent and tolerant of
 * already-clean state (Flutter's `manutencaoFotosProduto` may have run, or a
 * create-first doc may have been deleted before its upload ever landed).
 */
export async function processArquivoDeletion(
  bucket: Bucket,
  db: Firestore,
  id: string,
  data: DeletedArquivo,
): Promise<void> {
  if (!data.filename) return;
  const objectName = data.filepath ? `${data.filepath}/${data.filename}` : data.filename;

  // Dedup-resurrection guard: content-addressed ids mean a re-upload of the same
  // bytes recreates the doc at the same id. If a doc exists again, the object now
  // belongs to it — do NOT delete it.
  const current = await arquivoCollection.docRef(db, {}, id).get();
  if (current.exists) {
    logger.info(`onArquivoDeleted: ${id} was recreated — skipping storage delete`);
    return;
  }

  await deleteObject(bucket, objectName);

  // Cascade for an original: drop its 3 derivative objects + docs. Deleting the
  // derivative docs re-fires the trigger for them, but a derivative path is not
  // an "original" (`parseOwnedOriginalPath` → null), so it never recurses; the
  // object deletes here also make those re-fires no-ops.
  //
  // ⚠️ Owner-aware, and it has to be. The resize function now covers tabela de
  // medidas too, so a size-chart photo has three derivatives — and a reaper that
  // still only recognised `produtos/…` would delete the original and silently
  // leave them behind. That leaks bytes without failing anything.
  const parsed = parseOwnedOriginalPath(objectName);
  if (parsed) {
    for (const v of PRODUCT_IMAGE_VARIANTS) {
      await deleteObject(
        bucket,
        ownedDerivativePath(parsed.ownerCollection, parsed.ownerId, parsed.hash, v.key),
      );
      await arquivoCollection
        .docRef(db, {}, derivativeArquivoId(parsed.ownerId, parsed.hash, v.key))
        .delete();
    }
  }

  logger.info(`onArquivoDeleted: ${id} → deleted ${objectName}${parsed ? ' + 3 derivatives' : ''}`);
}

/**
 * On `arquivos/{id}` delete, free the Storage bytes the doc anchored (see the
 * create-first upload in `@delfrance/storage`). Thin wrapper over
 * {@link processArquivoDeletion}.
 *
 * Targets the repo's NAMED `default` Firestore database (not `(default)`); a
 * firestore trigger that omits `database` binds to `(default)` and would never
 * fire. Mirrors `getDb()`'s `FIREBASE_DATABASE_ID` convention (lib/admin.ts).
 */
export const onArquivoDeleted = onDocumentDeleted(
  {
    document: `${ARQUIVOS_COLLECTION}/{arquivoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    await processArquivoDeletion(
      getStorage(getAdminApp()).bucket(),
      getDb(),
      event.params.arquivoId,
      snap.data() as DeletedArquivo,
    );
  },
);
