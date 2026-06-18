import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mediaPath, productArquivoId, productOriginalPath } from '@delfrance/schemas';

import { sweepOrphanObjects, sweepPhantomDocs } from './arquivoOrphanSweep';

// Integration test — requires the firestore + storage emulators. Drives the sweep
// passes directly (not the onSchedule trigger). Grace window forced to 0 so any
// already-written doc/object qualifies; restored after.
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

describe.skipIf(!EMULATED)('arquivo orphan sweeps (emulator)', () => {
  let prevGrace: string | undefined;

  beforeAll(() => {
    prevGrace = process.env.ARQUIVO_ORPHAN_GRACE_HOURS;
    process.env.ARQUIVO_ORPHAN_GRACE_HOURS = '0';
  });
  afterAll(() => {
    if (prevGrace === undefined) delete process.env.ARQUIVO_ORPHAN_GRACE_HOURS;
    else process.env.ARQUIVO_ORPHAN_GRACE_HOURS = prevGrace;
  });

  it('phantom-doc sweep deletes a pending doc whose object never arrived', async () => {
    const db = getDb();
    const bucket = getBucket();
    const produtoId = `p${randomUUID().replace(/-/g, '')}`;
    const hash = randomUUID().replace(/-/g, '');
    const oPath = productOriginalPath(produtoId, hash, 'png');
    const slash = oPath.lastIndexOf('/');
    const id = productArquivoId(produtoId, hash);

    // A create-first doc with NO object behind it.
    await db
      .collection('arquivos')
      .doc(id)
      .set({
        filetype: 'image',
        filepath: oPath.slice(0, slash),
        filename: oPath.slice(slash + 1),
        contentType: 'image/png',
        url: null,
        externalIds: [],
        uploadState: 'pending',
      });

    await sweepPhantomDocs(db, bucket);

    expect((await db.collection('arquivos').doc(id).get()).exists).toBe(false);
  });

  it('phantom-doc sweep self-heals a pending doc whose object is present', async () => {
    const db = getDb();
    const bucket = getBucket();
    const produtoId = `p${randomUUID().replace(/-/g, '')}`;
    const hash = randomUUID().replace(/-/g, '');
    // media/ path → not watched by the resize trigger, so it won't race us.
    const oPath = mediaPath(hash, 'bin');
    const slash = oPath.lastIndexOf('/');
    const id = hash;

    await bucket.file(oPath).save(Buffer.from('present'), {
      contentType: 'application/octet-stream',
      metadata: { metadata: { arquivoId: id } },
    });
    await db
      .collection('arquivos')
      .doc(id)
      .set({
        filetype: 'application',
        filepath: oPath.slice(0, slash),
        filename: oPath.slice(slash + 1),
        contentType: 'application/octet-stream',
        url: null,
        externalIds: [],
        uploadState: 'pending',
      });

    await sweepPhantomDocs(db, bucket);

    const doc = await db.collection('arquivos').doc(id).get();
    expect(doc.exists).toBe(true);
    expect(doc.data()?.uploadState).toBe('finalized');
  });

  it('storage-orphan sweep deletes an object with no doc but keeps a doc-backed one', async () => {
    const db = getDb();
    const bucket = getBucket();

    // Orphan: object under media/ with NO arquivos doc.
    const orphanHash = randomUUID().replace(/-/g, '');
    const orphanPath = mediaPath(orphanHash, 'bin');
    await bucket.file(orphanPath).save(Buffer.from('orphan'), {
      contentType: 'application/octet-stream',
    });

    // Doc-backed: object under media/ WITH its arquivos doc.
    const keepHash = randomUUID().replace(/-/g, '');
    const keepPath = mediaPath(keepHash, 'bin');
    const keepSlash = keepPath.lastIndexOf('/');
    await bucket.file(keepPath).save(Buffer.from('keep'), {
      contentType: 'application/octet-stream',
    });
    await db
      .collection('arquivos')
      .doc(keepHash)
      .set({
        filetype: 'application',
        filepath: keepPath.slice(0, keepSlash),
        filename: keepPath.slice(keepSlash + 1),
        contentType: 'application/octet-stream',
        url: null,
        externalIds: [],
        uploadState: 'finalized',
      });

    await sweepOrphanObjects(db, bucket);

    expect((await bucket.file(orphanPath).exists())[0]).toBe(false);
    expect((await bucket.file(keepPath).exists())[0]).toBe(true);
  });
});
