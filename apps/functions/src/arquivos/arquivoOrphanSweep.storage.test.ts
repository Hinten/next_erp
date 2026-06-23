import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  mediaPath,
  nowMicros,
  productArquivoId,
  productOriginalPath,
  productVideoPath,
} from '@delfrance/schemas';

import {
  resolveReferencedArquivoRefs,
  sweepPhantomDocs,
  sweepUnreferencedArquivos,
} from './arquivoOrphanSweep';

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
        criadoEm: nowMicros() - DAY_MICROS,
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
        criadoEm: nowMicros() - DAY_MICROS,
        uploadState: 'pending',
      });

    await sweepPhantomDocs(db, bucket);

    const doc = await db.collection('arquivos').doc(id).get();
    expect(doc.exists).toBe(true);
    expect(doc.data()?.uploadState).toBe('finalized');
  });

  it('unreferenced sweep deletes orphans (owner missing or no ref), keeps referenced', async () => {
    const db = getDb();
    const bucket = getBucket();
    const ownerId = `p${randomUUID().replace(/-/g, '')}`;
    const missingOwnerId = `p${randomUUID().replace(/-/g, '')}`;
    const past = nowMicros() - 10 * DAY_MICROS;

    const seedAt = async (storagePath: string, id: string, filetype: string) => {
      const slash = storagePath.lastIndexOf('/');
      const filepath = storagePath.slice(0, slash);
      await db
        .collection('arquivos')
        .doc(id)
        .set({
          filetype,
          filepath,
          filename: storagePath.slice(slash + 1),
          contentType: filetype === 'video' ? 'video/mp4' : 'image/png',
          url: null,
          externalIds: [],
          uploadState: 'finalized',
          criadoEm: past,
        });
      return { id, filepath };
    };

    const refHash = randomUUID().replace(/-/g, '');
    const unrefHash = randomUUID().replace(/-/g, '');
    const vidHash = randomUUID().replace(/-/g, '');
    const missingHash = randomUUID().replace(/-/g, '');

    const ref = await seedAt(
      productOriginalPath(ownerId, refHash, 'png'),
      productArquivoId(ownerId, refHash),
      'image',
    ); // referenced by the owner produto
    const unref = await seedAt(
      productOriginalPath(ownerId, unrefHash, 'png'),
      productArquivoId(ownerId, unrefHash),
      'image',
    ); // owner exists but does NOT reference it (photo edited out)
    const vid = await seedAt(
      productVideoPath(ownerId, vidHash, 'mp4'),
      productArquivoId(ownerId, vidHash),
      'video',
    ); // orphan video (owner has no videos)
    const missing = await seedAt(
      productOriginalPath(missingOwnerId, missingHash, 'png'),
      productArquivoId(missingOwnerId, missingHash),
      'image',
    ); // owner produto does not exist

    // The owner produto references ONLY `ref` (its single photo); videos/anexos empty.
    await db
      .collection('produtos')
      .doc(ownerId)
      .set({ fotos: [{ arquivoOuterRef: `arquivos/${ref.id}` }], videos: [], anexos: [] });

    // Inject the candidate batch — the real fetch is a regex pipeline, which does
    // not run in the emulator. The owner lookup (`resolveReferenced`) is the REAL
    // getAll-based default, so this exercises the actual reference resolution.
    const candidates = [ref, unref, vid, missing].map((c) => ({
      ref: db.collection('arquivos').doc(c.id),
      id: c.id,
      filepath: c.filepath,
    }));
    await sweepUnreferencedArquivos(db, bucket, async () => candidates);

    expect((await db.collection('arquivos').doc(ref.id).get()).exists).toBe(true); // referenced → kept
    expect((await db.collection('arquivos').doc(unref.id).get()).exists).toBe(false); // no ref → deleted
    expect((await db.collection('arquivos').doc(vid.id).get()).exists).toBe(false); // orphan video → deleted
    expect((await db.collection('arquivos').doc(missing.id).get()).exists).toBe(false); // owner gone → deleted
  });

  it('resolveReferencedArquivoRefs reads only the named produtos and skips missing ones', async () => {
    const db = getDb();
    const produtoId = `p${randomUUID().replace(/-/g, '')}`;
    const fotoRef = `arquivos/${productArquivoId(produtoId, 'a'.repeat(16))}`;
    const videoRef = `arquivos/${productArquivoId(produtoId, 'b'.repeat(16))}`;
    const anexoRef = `arquivos/anx${randomUUID().replace(/-/g, '')}`;

    await db
      .collection('produtos')
      .doc(produtoId)
      .set({
        fotos: [{ arquivoOuterRef: fotoRef }],
        videos: [{ arquivoOuterRef: videoRef }],
        anexos: [{ arquivoOuterRef: anexoRef }],
      });

    const missingId = `p${randomUUID().replace(/-/g, '')}`;
    const refs = await resolveReferencedArquivoRefs(db, [produtoId, missingId]);

    // Reads only the two named produtos; the missing one contributes nothing.
    expect(refs).toEqual(new Set([fotoRef, videoRef, anexoRef]));
  });
});
