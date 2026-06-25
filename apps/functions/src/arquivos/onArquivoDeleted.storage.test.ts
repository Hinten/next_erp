import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  PRODUCT_IMAGE_VARIANTS,
  derivativeArquivoId,
  productAnexoPath,
  productArquivoId,
  productDerivativePath,
  productOriginalPath,
} from '@delfrance/schemas';

import { processArquivoDeletion } from './onArquivoDeleted';

// Integration test — requires the firestore + storage emulators. Skipped when
// run bare so the offline suite stays green. Drives the deletion CORE directly
// (not the onDocumentDeleted trigger) so it doesn't depend on Firestore-trigger
// delivery for the named `default` database — same split as the resize suite
// (processProductOriginal core vs the thin trigger).
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';
const bucketName = `${projectId}.appspot.com`;

function getDb() {
  const app = getApps()[0] ?? initializeApp({ projectId, storageBucket: bucketName });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}
function getBucket() {
  const app = getApps()[0] ?? initializeApp({ projectId, storageBucket: bucketName });
  return getStorage(app).bucket(bucketName);
}

describe.skipIf(!EMULATED)('onArquivoDeleted (emulator)', () => {
  let produtoId: string;
  let hash: string;

  beforeAll(async () => {
    produtoId = `p${randomUUID().replace(/-/g, '')}`;
    hash = randomUUID().replace(/-/g, '');
    const db = getDb();
    const bucket = getBucket();

    // Original OBJECT — non-image content type so the resize trigger bails and
    // doesn't race to (re)create derivatives during this test. The doc still
    // says image (the cascade keys off the PATH, not the doc's contentType).
    const oPath = productOriginalPath(produtoId, hash, 'png');
    const oSlash = oPath.lastIndexOf('/');
    await bucket.file(oPath).save(Buffer.from('original-bytes'), {
      contentType: 'application/octet-stream',
      metadata: { metadata: { arquivoId: productArquivoId(produtoId, hash) } },
    });
    await db
      .collection('arquivos')
      .doc(productArquivoId(produtoId, hash))
      .set({
        filetype: 'image',
        filepath: oPath.slice(0, oSlash),
        filename: oPath.slice(oSlash + 1),
        contentType: 'image/png',
        url: null,
        externalIds: [],
        resizeState: 'done',
        uploadState: 'finalized',
      });

    // Three derivative objects + docs, as the resize fn would have produced.
    for (const v of PRODUCT_IMAGE_VARIANTS) {
      const dPath = productDerivativePath(produtoId, hash, v.key);
      const dSlash = dPath.lastIndexOf('/');
      await bucket.file(dPath).save(Buffer.from(`deriv-${v.key}`), {
        contentType: 'image/jpeg',
        metadata: { metadata: { resized: 'true', originalPath: oPath } },
      });
      await db
        .collection('arquivos')
        .doc(derivativeArquivoId(produtoId, hash, v.key))
        .set({
          filetype: 'image',
          filepath: dPath.slice(0, dSlash),
          filename: dPath.slice(dSlash + 1),
          contentType: 'image/jpeg',
          url: null,
          externalIds: [],
        });
    }
  });

  it('cascades: deleting the original doc removes the original + all derivative objects and docs', async () => {
    const db = getDb();
    const bucket = getBucket();
    const oPath = productOriginalPath(produtoId, hash, 'png');
    const origId = productArquivoId(produtoId, hash);

    // Everything is present to start.
    expect((await bucket.file(oPath).exists())[0]).toBe(true);

    // Mirror the real flow: the doc is deleted, THEN the handler runs on its
    // snapshot data.
    const snap = await db.collection('arquivos').doc(origId).get();
    const data = snap.data() as { filepath?: string | null; filename?: string };
    await db.collection('arquivos').doc(origId).delete();
    await processArquivoDeletion(bucket, db, origId, data);

    // Original object gone.
    expect((await bucket.file(oPath).exists())[0]).toBe(false);

    // All 3 derivative objects + docs gone.
    for (const v of PRODUCT_IMAGE_VARIANTS) {
      expect((await bucket.file(productDerivativePath(produtoId, hash, v.key)).exists())[0]).toBe(
        false,
      );
      const dId = derivativeArquivoId(produtoId, hash, v.key);
      expect((await db.collection('arquivos').doc(dId).get()).exists).toBe(false);
    }
  });

  it('frees a product anexo object with no derivative cascade', async () => {
    const db = getDb();
    const bucket = getBucket();
    const anxHash = randomUUID().replace(/-/g, '');
    const aPath = productAnexoPath(produtoId, anxHash, 'pdf');
    const aSlash = aPath.lastIndexOf('/');
    const anxId = productArquivoId(produtoId, anxHash);

    await bucket.file(aPath).save(Buffer.from('anexo-bytes'), {
      contentType: 'application/pdf',
      metadata: { metadata: { arquivoId: anxId } },
    });
    await db
      .collection('arquivos')
      .doc(anxId)
      .set({
        filetype: 'document',
        filepath: aPath.slice(0, aSlash),
        filename: aPath.slice(aSlash + 1),
        contentType: 'application/pdf',
        url: null,
        externalIds: [],
        uploadState: 'finalized',
      });

    await db.collection('arquivos').doc(anxId).delete();
    await processArquivoDeletion(bucket, db, anxId, {
      filepath: aPath.slice(0, aSlash),
      filename: aPath.slice(aSlash + 1),
    });

    // The anexo object is freed; an anexo path is not an original, so the
    // derivative cascade is skipped (there are no derivatives for an anexo).
    expect((await bucket.file(aPath).exists())[0]).toBe(false);
    expect((await bucket.file(productDerivativePath(produtoId, anxHash, '200')).exists())[0]).toBe(
      false,
    );
  });

  it('resurrection guard: keeps the object when the doc exists again', async () => {
    const db = getDb();
    const bucket = getBucket();
    const otherHash = randomUUID().replace(/-/g, '');
    const oPath = productOriginalPath(produtoId, otherHash, 'png');
    const oSlash = oPath.lastIndexOf('/');
    const id = productArquivoId(produtoId, otherHash);

    await bucket.file(oPath).save(Buffer.from('resurrected'), {
      contentType: 'application/octet-stream',
    });
    // A doc with the same id EXISTS again (a re-upload recreated it).
    await db
      .collection('arquivos')
      .doc(id)
      .set({
        filetype: 'image',
        filepath: oPath.slice(0, oSlash),
        filename: oPath.slice(oSlash + 1),
        contentType: 'image/png',
        url: null,
        externalIds: [],
        uploadState: 'pending',
      });

    // The stale delete event fires; the guard must see the live doc and NOT
    // delete the object the new doc now owns.
    await processArquivoDeletion(bucket, db, id, {
      filepath: oPath.slice(0, oSlash),
      filename: oPath.slice(oSlash + 1),
    });
    expect((await bucket.file(oPath).exists())[0]).toBe(true);
  });
});
