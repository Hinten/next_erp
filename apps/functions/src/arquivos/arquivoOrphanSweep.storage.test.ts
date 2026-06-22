import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mediaPath, nowMicros, productArquivoId, productOriginalPath } from '@delfrance/schemas';

import { sweepPhantomDocs, sweepUnreferencedArquivos } from './arquivoOrphanSweep';

// Integration test — requires the firestore + storage emulators. Drives the sweep
// cores directly (not the onSchedule trigger; not the pipeline). Grace window
// forced to 0 so any already-written doc qualifies; restored after.
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';
const bucketName = `${projectId}.appspot.com`;
const DAY_MICROS = 24 * 3600 * 1_000_000;

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

  it('unreferenced sweep deletes a product original no produto references, keeps referenced + within-grace', async () => {
    const db = getDb();
    const bucket = getBucket();
    const produtoId = `p${randomUUID().replace(/-/g, '')}`;
    const past = nowMicros() - 10 * DAY_MICROS;
    const future = nowMicros() + 10 * DAY_MICROS;

    const seed = async (hash: string, criadoEm: number): Promise<string> => {
      const oPath = productOriginalPath(produtoId, hash, 'png');
      const slash = oPath.lastIndexOf('/');
      const id = productArquivoId(produtoId, hash);
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
          uploadState: 'finalized',
          criadoEm,
        });
      return id;
    };

    const refId = await seed(randomUUID().replace(/-/g, ''), past); // referenced
    const unrefId = await seed(randomUUID().replace(/-/g, ''), past); // orphan
    const recentId = await seed(randomUUID().replace(/-/g, ''), future); // within grace

    // Isolate against the shared emulator: treat every existing arquivo as
    // referenced, then drop our one target so it's the only deletable orphan.
    const all = await db.collection('arquivos').get();
    const referencedRefs = new Set(all.docs.map((d) => `arquivos/${d.id}`));
    referencedRefs.delete(`arquivos/${unrefId}`);

    await sweepUnreferencedArquivos(db, bucket, referencedRefs);

    expect((await db.collection('arquivos').doc(unrefId).get()).exists).toBe(false);
    expect((await db.collection('arquivos').doc(refId).get()).exists).toBe(true);
    expect((await db.collection('arquivos').doc(recentId).get()).exists).toBe(true);
  });
});
