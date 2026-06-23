import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  derivativeArquivoId,
  mediaPath,
  nowMicros,
  productArquivoId,
  productDerivativePath,
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

  it('unreferenced sweep deletes orphan photos + videos, keeps referenced / within-grace / derivatives', async () => {
    const db = getDb();
    const bucket = getBucket();
    const produtoId = `p${randomUUID().replace(/-/g, '')}`;
    const past = nowMicros() - 10 * DAY_MICROS;
    const future = nowMicros() + 10 * DAY_MICROS;

    const seedAt = async (storagePath: string, id: string, criadoEm: number, filetype: string) => {
      const slash = storagePath.lastIndexOf('/');
      await db
        .collection('arquivos')
        .doc(id)
        .set({
          filetype,
          filepath: storagePath.slice(0, slash),
          filename: storagePath.slice(slash + 1),
          contentType: filetype === 'video' ? 'video/mp4' : 'image/png',
          url: null,
          externalIds: [],
          uploadState: 'finalized',
          criadoEm,
        });
      return id;
    };

    const refHash = randomUUID().replace(/-/g, '');
    const unrefHash = randomUUID().replace(/-/g, '');
    const recentHash = randomUUID().replace(/-/g, '');
    const vidHash = randomUUID().replace(/-/g, '');

    const refId = await seedAt(
      productOriginalPath(produtoId, refHash, 'png'),
      productArquivoId(produtoId, refHash),
      past,
      'image',
    ); // referenced original
    const unrefId = await seedAt(
      productOriginalPath(produtoId, unrefHash, 'png'),
      productArquivoId(produtoId, unrefHash),
      past,
      'image',
    ); // orphan original
    const recentId = await seedAt(
      productOriginalPath(produtoId, recentHash, 'png'),
      productArquivoId(produtoId, recentHash),
      future,
      'image',
    ); // within grace
    const vidId = await seedAt(
      productVideoPath(produtoId, vidHash, 'mp4'),
      productArquivoId(produtoId, vidHash),
      past,
      'video',
    ); // orphan video
    const derivId = await seedAt(
      productDerivativePath(produtoId, unrefHash, '200'),
      derivativeArquivoId(produtoId, unrefHash, '200'),
      past,
      'image',
    ); // derivative (scope-excluded)

    // Isolate against the shared emulator: stub resolver marks every existing
    // arquivo referenced EXCEPT the targets we expect deleted. derivId is left
    // unreferenced too — so its survival proves the scope filter (not a ref) keeps it.
    const all = await db.collection('arquivos').get();
    const referencedRefs = new Set(all.docs.map((d) => `arquivos/${d.id}`));
    for (const id of [unrefId, vidId, derivId]) referencedRefs.delete(`arquivos/${id}`);

    let resolverArgs: string[] = [];
    await sweepUnreferencedArquivos(db, bucket, async (ids) => {
      resolverArgs = ids;
      return referencedRefs;
    });

    // The scope filter mapped the candidate photos/videos to their owner produtoId.
    expect(resolverArgs).toContain(produtoId);
    expect((await db.collection('arquivos').doc(unrefId).get()).exists).toBe(false); // orphan photo
    expect((await db.collection('arquivos').doc(vidId).get()).exists).toBe(false); // orphan video
    expect((await db.collection('arquivos').doc(derivId).get()).exists).toBe(true); // derivative not a candidate
    expect((await db.collection('arquivos').doc(refId).get()).exists).toBe(true); // referenced
    expect((await db.collection('arquivos').doc(recentId).get()).exists).toBe(true); // within grace
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
