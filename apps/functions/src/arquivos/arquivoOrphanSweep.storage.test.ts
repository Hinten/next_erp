import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ARQUIVO_ORPHAN_SWEEP_STATE_DOC_ID,
  chatMediaPath,
  mediaPath,
  nowMicros,
  productAnexoPath,
  productArquivoId,
  productOriginalPath,
  productVideoPath,
  tabMediArquivoId,
  tabMediOriginalPath,
  whatsappMediaPath,
} from '@delfrance/schemas';

import {
  reconcileMensagemArquivoCandidate,
  resolveReferencedArquivoRefs,
  resolveMensagemArquivoReferences,
  sweepMarkedForDeletion,
  sweepPhantomDocs,
  sweepUnreferencedArquivos,
} from './arquivoOrphanSweep';
import { processArquivoDeletion } from './onArquivoDeleted';
import { markDeletedMensagemArquivos } from './onMensagemDeleted';

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
  let prevMarkedGrace: string | undefined;

  beforeAll(() => {
    prevGrace = process.env.ARQUIVO_ORPHAN_GRACE_HOURS;
    prevMarkedGrace = process.env.ARQUIVO_MARKED_GRACE_HOURS;
    process.env.ARQUIVO_ORPHAN_GRACE_HOURS = '0';
    process.env.ARQUIVO_MARKED_GRACE_HOURS = '0';
  });
  afterAll(() => {
    if (prevGrace === undefined) delete process.env.ARQUIVO_ORPHAN_GRACE_HOURS;
    else process.env.ARQUIVO_ORPHAN_GRACE_HOURS = prevGrace;
    if (prevMarkedGrace === undefined) delete process.env.ARQUIVO_MARKED_GRACE_HOURS;
    else process.env.ARQUIVO_MARKED_GRACE_HOURS = prevMarkedGrace;
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

    // Clean up the `media/` object: the emulator bucket is shared across files
    // and resizeProductImage's "ignores a non-product upload" asserts the WHOLE
    // `media/` listing equals its own file, so a stray object here fails it
    // depending on test order.
    await bucket.file(oPath).delete({ ignoreNotFound: true });
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
          contentType:
            filetype === 'video'
              ? 'video/mp4'
              : filetype === 'document'
                ? 'application/pdf'
                : 'image/png',
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
    const anxHash = randomUUID().replace(/-/g, '');
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
    const anx = await seedAt(
      productAnexoPath(ownerId, anxHash, 'pdf'),
      productArquivoId(ownerId, anxHash),
      'document',
    ); // orphan anexo (owner has no anexos) — the §9 backstop must reap it
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

    // Inject a fixed page (skipping the real document-key pagination) — the
    // owner lookup (`resolveReferenced`) is the REAL getAll-based default, so
    // this still exercises the actual reference resolution.
    const candidates = [ref, unref, vid, anx, missing].map((c) => ({
      ref: db.collection('arquivos').doc(c.id),
      id: c.id,
      filepath: c.filepath,
      criadoEm: past,
    }));
    await sweepUnreferencedArquivos(db, bucket, async () => candidates);

    expect((await db.collection('arquivos').doc(ref.id).get()).exists).toBe(true); // referenced → kept
    expect((await db.collection('arquivos').doc(unref.id).get()).exists).toBe(false); // no ref → deleted
    expect((await db.collection('arquivos').doc(vid.id).get()).exists).toBe(false); // orphan video → deleted
    expect((await db.collection('arquivos').doc(anx.id).get()).exists).toBe(false); // orphan anexo → deleted
    expect((await db.collection('arquivos').doc(missing.id).get()).exists).toBe(false); // owner gone → deleted
  });

  it('unreferenced sweep persists a round-robin cursor: advances on a full page, wraps on a short one (#234)', async () => {
    const db = getDb();
    const bucket = getBucket();
    const cursorRef = db
      .collection('arquivoOrphanSweepState')
      .doc(ARQUIVO_ORPHAN_SWEEP_STATE_DOC_ID);
    await cursorRef.delete(); // start clean — the doc is a singleton shared across ticks

    // `filepath: null` → parseOwnedMediaDir rejects every row, so no delete or
    // owner-lookup is attempted; this isolates the assertions to cursor
    // mechanics (already covered separately by the test above).
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      ref: db.collection('arquivos').doc(`fake-full-${i}`),
      id: `fake-full-${i}`,
      filepath: null,
      criadoEm: null,
    }));
    await sweepUnreferencedArquivos(db, bucket, async () => fullPage);
    expect((await cursorRef.get()).data()?.lastKey).toBe('fake-full-99'); // full page → cursor advances, no wrap

    const shortPage = [
      {
        ref: db.collection('arquivos').doc('fake-short-0'),
        id: 'fake-short-0',
        filepath: null,
        criadoEm: null,
      },
    ];
    await sweepUnreferencedArquivos(db, bucket, async () => shortPage);
    expect((await cursorRef.get()).data()?.lastKey).toBeNull(); // short page → reached the end → wraps

    await cursorRef.delete();
  });

  it('unreferenced sweep (real page fetch, no seam) reclaims orphans via document-key pagination (#234)', async () => {
    const db = getDb();
    const bucket = getBucket();
    const cursorRef = db
      .collection('arquivoOrphanSweepState')
      .doc(ARQUIVO_ORPHAN_SWEEP_STATE_DOC_ID);
    await cursorRef.delete();

    const ownerId = `p${randomUUID().replace(/-/g, '')}`; // owner produto never created → every seeded arquivo is an orphan
    const past = nowMicros() - 10 * DAY_MICROS;
    const hashes = Array.from({ length: 3 }, () => randomUUID().replace(/-/g, ''));
    for (const hash of hashes) {
      const oPath = productOriginalPath(ownerId, hash, 'png');
      const slash = oPath.lastIndexOf('/');
      await db
        .collection('arquivos')
        .doc(productArquivoId(ownerId, hash))
        .set({
          filetype: 'image',
          filepath: oPath.slice(0, slash),
          filename: oPath.slice(slash + 1),
          contentType: 'image/png',
          url: null,
          externalIds: [],
          uploadState: 'finalized',
          criadoEm: past,
        });
    }

    // No seams: exercises the real `fetchArquivoPage` (a classic
    // FieldPath.documentId() query — no pipeline, unlike the old regex scan)
    // and the real `resolveReferencedRefs`.
    await sweepUnreferencedArquivos(db, bucket);

    for (const hash of hashes) {
      expect(
        (await db.collection('arquivos').doc(productArquivoId(ownerId, hash)).get()).exists,
      ).toBe(false);
    }

    await cursorRef.delete();
  });

  it('real page fetch resumes after a persisted cursor: skips docs at/before it, reaps docs after it (#234)', async () => {
    const db = getDb();
    const bucket = getBucket();
    const cursorRef = db
      .collection('arquivoOrphanSweepState')
      .doc(ARQUIVO_ORPHAN_SWEEP_STATE_DOC_ID);
    await cursorRef.delete();

    const ownerId = `p${randomUUID().replace(/-/g, '')}`; // owner produto never created → every seeded arquivo is an orphan
    const past = nowMicros() - 10 * DAY_MICROS;
    const seed = async (docId: string) => {
      const oPath = productOriginalPath(ownerId, randomUUID().replace(/-/g, ''), 'png');
      const slash = oPath.lastIndexOf('/');
      await db
        .collection('arquivos')
        .doc(docId)
        .set({
          filetype: 'image',
          filepath: oPath.slice(0, slash),
          filename: oPath.slice(slash + 1),
          contentType: 'image/png',
          url: null,
          externalIds: [],
          uploadState: 'finalized',
          criadoEm: past,
        });
    };
    // Explicit, orderable doc ids (independent of the usual `<ownerId>_<hash>`
    // convention — the sweep only cares about `filepath`, not the id shape) so
    // the key ordering the cursor relies on is deterministic in this test.
    const beforeId = `aaa-cursor-test-${randomUUID().replace(/-/g, '')}`;
    const afterId = `zzz-cursor-test-${randomUUID().replace(/-/g, '')}`;
    await seed(beforeId);
    await seed(afterId);

    // Pretend a previous tick already scanned through `beforeId` — the real
    // fetch's `startAfter(lastKey)` must exclude it (and anything before it),
    // not just the seam-based mechanics tested above.
    await cursorRef.set({ lastKey: beforeId, updatedAt: past });

    await sweepUnreferencedArquivos(db, bucket); // real fetch + real resolve, no seams

    expect((await db.collection('arquivos').doc(beforeId).get()).exists).toBe(true); // before the cursor → never scanned
    expect((await db.collection('arquivos').doc(afterId).get()).exists).toBe(false); // after the cursor → scanned, orphaned → deleted

    await db.collection('arquivos').doc(beforeId).delete(); // cleanup — the sweep correctly never touches it
    await cursorRef.delete();
  });

  it('real page fetch coerces a legacy non-numeric criadoEm so old docs are still swept (#234)', async () => {
    const db = getDb();
    const bucket = getBucket();
    const cursorRef = db
      .collection('arquivoOrphanSweepState')
      .doc(ARQUIVO_ORPHAN_SWEEP_STATE_DOC_ID);
    await cursorRef.delete();

    const ownerId = `p${randomUUID().replace(/-/g, '')}`; // owner produto never created → orphan
    const hash = randomUUID().replace(/-/g, '');
    const oPath = productOriginalPath(ownerId, hash, 'png');
    const slash = oPath.lastIndexOf('/');
    const id = productArquivoId(ownerId, hash);
    // Legacy shape: an ISO string instead of the schema's µs-int wire format —
    // `microsSinceEpoch()` tolerates this on a normal read via `coerceToMicros`;
    // the sweep's raw-field fetch must too, or such a doc is skipped forever.
    const pastIso = new Date(Number(nowMicros() - 10 * DAY_MICROS) / 1000).toISOString();
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
        criadoEm: pastIso,
      });

    await sweepUnreferencedArquivos(db, bucket); // real fetch, no seams

    expect((await db.collection('arquivos').doc(id).get()).exists).toBe(false);

    await cursorRef.delete();
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
    // Duplicate id exercises the de-dup; the missing one contributes nothing.
    const refs = await resolveReferencedArquivoRefs(db, [produtoId, produtoId, missingId]);

    expect(refs).toEqual(new Set([fotoRef, videoRef, anexoRef]));
  });

  it('reaps unreferenced whatsapp/chat media, keeps all six ref fields and shared refs', async () => {
    const db = getDb();
    const bucket = getBucket();
    const past = nowMicros() - 10 * DAY_MICROS;
    const conversaPrefix = `media-${randomUUID().replace(/-/g, '')}`;

    const seedArquivo = async (docId: string, storagePath: string) => {
      const slash = storagePath.lastIndexOf('/');
      const data = {
        filetype: 'image',
        filepath: storagePath.slice(0, slash),
        filename: storagePath.slice(slash + 1),
        contentType: 'image/jpeg',
        url: 'https://example.invalid/file',
        externalIds: [],
        uploadState: 'finalized',
        criadoEm: past,
        markedForDeletionAt: null,
      };
      await db.collection('arquivos').doc(docId).set(data);
      return {
        ref: db.collection('arquivos').doc(docId),
        id: docId,
        filepath: data.filepath,
        criadoEm: past,
        data,
        objectPath: storagePath,
      };
    };

    const fieldWrites: Array<(ref: string) => Record<string, unknown>> = [
      (ref) => ({ anexoStorage: ref }),
      (ref) => ({ audio: { audio: ref } }),
      (ref) => ({ image: { image: ref } }),
      (ref) => ({ video: { video: ref } }),
      (ref) => ({ sticker: { sticker: ref } }),
      (ref) => ({ genericDocument: { genericDocument: ref } }),
    ];
    const referenced: Awaited<ReturnType<typeof seedArquivo>>[] = [];
    for (const [index, write] of fieldWrites.entries()) {
      const docId = `wa_ref_${index}_${randomUUID().replace(/-/g, '')}`;
      referenced.push(await seedArquivo(docId, whatsappMediaPath('conta-1', docId)));
      const wireRef = index % 2 === 0 ? `arquivos/${docId}` : `documents/arquivos/${docId}`;
      await db
        .collection('chat')
        .doc(`${conversaPrefix}-${index}`)
        .collection('mensagem')
        .doc('m1')
        .set(write(wireRef));
    }
    // The first arquivo is shared by another conversa; one lookup must still
    // answer referenced without assuming a single owner.
    await db
      .collection('chat')
      .doc(`${conversaPrefix}-shared`)
      .collection('mensagem')
      .doc('m2')
      .set({ image: { image: `documents/arquivos/${referenced[0]!.id}` } });

    const orphanInbound = await seedArquivo(
      `wa_orphan_${randomUUID().replace(/-/g, '')}`,
      whatsappMediaPath('conta-1', randomUUID().replace(/-/g, '')),
    );
    const orphanOutbound = await seedArquivo(
      `chat_orphan_${randomUUID().replace(/-/g, '')}`,
      chatMediaPath(randomUUID().replace(/-/g, ''), 'jpg'),
    );
    await bucket.file(orphanInbound.objectPath).save(Buffer.from('inbound'));
    await bucket.file(orphanOutbound.objectPath).save(Buffer.from('outbound'));

    const page = [...referenced, orphanInbound, orphanOutbound];
    await sweepUnreferencedArquivos(db, bucket, async () => page);

    expect(
      await resolveMensagemArquivoReferences(
        db,
        referenced.map((row) => row.id),
      ),
    ).toEqual(new Set(referenced.map((row) => row.id)));
    for (const row of referenced) {
      expect((await row.ref.get()).exists).toBe(true);
    }
    expect((await orphanInbound.ref.get()).exists).toBe(false);
    expect((await orphanOutbound.ref.get()).exists).toBe(false);

    // The sweep owns doc deletion; the trigger core owns object deletion. Drive
    // both real cores against the emulators to pin the complete lifecycle.
    await processArquivoDeletion(bucket, db, orphanInbound.id, orphanInbound.data);
    await processArquivoDeletion(bucket, db, orphanOutbound.id, orphanOutbound.data);
    expect((await bucket.file(orphanInbound.objectPath).exists())[0]).toBe(false);
    expect((await bucket.file(orphanOutbound.objectPath).exists())[0]).toBe(false);

    for (let index = 0; index < fieldWrites.length; index += 1) {
      await db
        .collection('chat')
        .doc(`${conversaPrefix}-${index}`)
        .collection('mensagem')
        .doc('m1')
        .delete();
    }
    await db
      .collection('chat')
      .doc(`${conversaPrefix}-shared`)
      .collection('mensagem')
      .doc('m2')
      .delete();
    await Promise.all(referenced.map((row) => row.ref.delete()));
  });

  it('transactional recheck keeps a ref created after the cheap precheck', async () => {
    const db = getDb();
    const bucket = getBucket();
    const past = nowMicros() - 10 * DAY_MICROS;
    const arquivoId = `wa_race_${randomUUID().replace(/-/g, '')}`;
    const objectPath = whatsappMediaPath('conta-race', arquivoId);
    const slash = objectPath.lastIndexOf('/');
    const ref = db.collection('arquivos').doc(arquivoId);
    await ref.set({
      filetype: 'image',
      filepath: objectPath.slice(0, slash),
      filename: objectPath.slice(slash + 1),
      contentType: 'image/jpeg',
      url: 'https://example.invalid/file',
      externalIds: [],
      uploadState: 'finalized',
      criadoEm: past,
      markedForDeletionAt: null,
    });
    const conversaId = `race-${randomUUID().replace(/-/g, '')}`;

    await sweepUnreferencedArquivos(
      db,
      bucket,
      async () => [{ ref, id: arquivoId, filepath: `whatsapp/conta-race`, criadoEm: past }],
      async () => new Set(),
      async () => {
        // Simulates the query→delete window: the cheap precheck saw nothing,
        // then a writer landed a ref before the final transaction opened.
        await db
          .collection('chat')
          .doc(conversaId)
          .collection('mensagem')
          .doc('m1')
          .set({ image: { image: `arquivos/${arquivoId}` } });
        return new Set();
      },
    );

    expect((await ref.get()).exists).toBe(true);
    await db.collection('chat').doc(conversaId).collection('mensagem').doc('m1').delete();
    await ref.delete();
  });

  it('a mensagem transaction refuses to write after the sweep deleted its anchor', async () => {
    const db = getDb();
    const past = nowMicros() - 10 * DAY_MICROS;
    const arquivoId = `wa_sweep_won_${randomUUID().replace(/-/g, '')}`;
    const objectPath = whatsappMediaPath('conta-race', arquivoId);
    const slash = objectPath.lastIndexOf('/');
    const arquivoRef = db.collection('arquivos').doc(arquivoId);
    await arquivoRef.set({
      filetype: 'image',
      filepath: objectPath.slice(0, slash),
      filename: objectPath.slice(slash + 1),
      contentType: 'image/jpeg',
      url: 'https://example.invalid/file',
      externalIds: [],
      uploadState: 'finalized',
      criadoEm: past,
      markedForDeletionAt: null,
    });
    expect(await reconcileMensagemArquivoCandidate(db, arquivoRef)).toBe('deleted');

    const mensagemRef = db
      .collection('chat')
      .doc(`race-lost-${randomUUID().replace(/-/g, '')}`)
      .collection('mensagem')
      .doc('m1');
    await expect(
      db.runTransaction(async (tx) => {
        if (!(await tx.get(arquivoRef)).exists) throw new Error('arquivo anchor missing');
        tx.set(mensagemRef, { image: { image: `arquivos/${arquivoId}` } });
      }),
    ).rejects.toThrow('arquivo anchor missing');
    expect((await mensagemRef.get()).exists).toBe(false);
  });

  it('keeps shared marked media until the last mensagem ref is removed', async () => {
    const db = getDb();
    const past = nowMicros() - DAY_MICROS;
    const arquivoId = `chat_${randomUUID().replace(/-/g, '')}`;
    const objectPath = chatMediaPath(randomUUID().replace(/-/g, ''), 'pdf');
    const slash = objectPath.lastIndexOf('/');
    const arquivoRef = db.collection('arquivos').doc(arquivoId);
    await arquivoRef.set({
      filetype: 'document',
      filepath: objectPath.slice(0, slash),
      filename: objectPath.slice(slash + 1),
      contentType: 'application/pdf',
      url: 'https://example.invalid/file',
      externalIds: [],
      uploadState: 'finalized',
      criadoEm: past,
      markedForDeletionAt: past,
    });

    const mensagemData = { genericDocument: { genericDocument: `arquivos/${arquivoId}` } };
    const conversaA = `shared-a-${randomUUID().replace(/-/g, '')}`;
    const conversaB = `shared-b-${randomUUID().replace(/-/g, '')}`;
    const mensagemA = db.collection('chat').doc(conversaA).collection('mensagem').doc('m1');
    const mensagemB = db.collection('chat').doc(conversaB).collection('mensagem').doc('m2');
    await Promise.all([mensagemA.set(mensagemData), mensagemB.set(mensagemData)]);

    await sweepMarkedForDeletion(db);
    expect((await arquivoRef.get()).data()?.markedForDeletionAt).toBeNull();

    await mensagemA.delete();
    expect(await markDeletedMensagemArquivos(db, mensagemData)).toBe(1);
    await sweepMarkedForDeletion(db);
    expect((await arquivoRef.get()).exists).toBe(true);
    expect((await arquivoRef.get()).data()?.markedForDeletionAt).toBeNull();

    await mensagemB.delete();
    expect(await markDeletedMensagemArquivos(db, mensagemData)).toBe(1);
    await sweepMarkedForDeletion(db);
    expect((await arquivoRef.get()).exists).toBe(false);
  });

  it('keeps young mensagem media and files outside the governed roots', async () => {
    const db = getDb();
    const bucket = getBucket();
    const previousGrace = process.env.ARQUIVO_ORPHAN_GRACE_HOURS;
    process.env.ARQUIVO_ORPHAN_GRACE_HOURS = '48';
    try {
      const youngId = `wa_young_${randomUUID().replace(/-/g, '')}`;
      const genericId = `generic_${randomUUID().replace(/-/g, '')}`;
      const youngRef = db.collection('arquivos').doc(youngId);
      const genericRef = db.collection('arquivos').doc(genericId);
      const youngPath = whatsappMediaPath('conta-young', youngId);
      const genericPath = mediaPath(randomUUID().replace(/-/g, ''), 'bin');
      const youngDir = youngPath.slice(0, youngPath.lastIndexOf('/'));
      const genericDir = genericPath.slice(0, genericPath.lastIndexOf('/'));
      await Promise.all([
        youngRef.set({
          filetype: 'image',
          filepath: youngDir,
          filename: youngPath.slice(youngPath.lastIndexOf('/') + 1),
          contentType: 'image/jpeg',
          url: null,
          externalIds: [],
          uploadState: 'finalized',
          criadoEm: nowMicros(),
        }),
        genericRef.set({
          filetype: 'application',
          filepath: genericDir,
          filename: genericPath.slice(genericPath.lastIndexOf('/') + 1),
          contentType: 'application/octet-stream',
          url: null,
          externalIds: [],
          uploadState: 'finalized',
          criadoEm: nowMicros() - 10 * DAY_MICROS,
        }),
      ]);

      await sweepUnreferencedArquivos(db, bucket, async () => [
        { ref: youngRef, id: youngId, filepath: youngDir, criadoEm: nowMicros() },
        {
          ref: genericRef,
          id: genericId,
          filepath: genericDir,
          criadoEm: nowMicros() - 10 * DAY_MICROS,
        },
      ]);

      expect((await youngRef.get()).exists).toBe(true);
      expect((await genericRef.get()).exists).toBe(true);
      await Promise.all([youngRef.delete(), genericRef.delete()]);
    } finally {
      if (previousGrace === undefined) delete process.env.ARQUIVO_ORPHAN_GRACE_HOURS;
      else process.env.ARQUIVO_ORPHAN_GRACE_HOURS = previousGrace;
    }
  });

  it('marked sweep deletes a marked unreferenced arquivo and clears a re-referenced one', async () => {
    const db = getDb();
    const ownerId = `p${randomUUID().replace(/-/g, '')}`;
    const goneHash = randomUUID().replace(/-/g, '');
    const keptHash = randomUUID().replace(/-/g, '');
    const goneId = productArquivoId(ownerId, goneHash);
    const keptId = productArquivoId(ownerId, keptHash);
    const past = nowMicros() - DAY_MICROS;

    const seedMarked = async (storagePath: string, id: string) => {
      const slash = storagePath.lastIndexOf('/');
      await db
        .collection('arquivos')
        .doc(id)
        .set({
          filetype: 'image',
          filepath: storagePath.slice(0, slash),
          filename: storagePath.slice(slash + 1),
          contentType: 'image/png',
          url: null,
          externalIds: [],
          uploadState: 'finalized',
          criadoEm: past,
          markedForDeletionAt: past, // marked in the past → past the (0h) grace
        });
    };

    await seedMarked(productOriginalPath(ownerId, goneHash, 'png'), goneId);
    await seedMarked(productOriginalPath(ownerId, keptHash, 'png'), keptId);

    // The owner references ONLY keptId — a re-added photo whose unmark was missed.
    await db
      .collection('produtos')
      .doc(ownerId)
      .set({ fotos: [{ arquivoOuterRef: `arquivos/${keptId}` }], videos: [], anexos: [] });

    await sweepMarkedForDeletion(db);

    expect((await db.collection('arquivos').doc(goneId).get()).exists).toBe(false); // unreferenced → deleted
    const kept = await db.collection('arquivos').doc(keptId).get();
    expect(kept.exists).toBe(true); // still referenced → kept
    expect(kept.data()?.markedForDeletionAt).toBeNull(); // mark cleared
  });

  it('marked sweep clears (never deletes) a marked doc whose owner is not derivable', async () => {
    const db = getDb();
    // A marked arquivo NOT under produtos/<id>/originals|videos (legacy/console/bad
    // data). parseProductMediaDir → null, so the owner can't be re-verified: the
    // sweep must clear the mark, not delete it blind.
    const oddId = `media-${randomUUID().replace(/-/g, '')}`;
    const oPath = mediaPath(randomUUID().replace(/-/g, ''), 'png');
    const slash = oPath.lastIndexOf('/');
    await db
      .collection('arquivos')
      .doc(oddId)
      .set({
        filetype: 'image',
        filepath: oPath.slice(0, slash),
        filename: oPath.slice(slash + 1),
        contentType: 'image/png',
        url: null,
        externalIds: [],
        uploadState: 'finalized',
        criadoEm: nowMicros() - DAY_MICROS,
        markedForDeletionAt: nowMicros() - DAY_MICROS,
      });

    await sweepMarkedForDeletion(db);

    const doc = await db.collection('arquivos').doc(oddId).get();
    expect(doc.exists).toBe(true); // owner not derivable → NOT deleted
    expect(doc.data()?.markedForDeletionAt).toBeNull(); // mark cleared
  });

  it('marked sweep handles tabMedi owners — deletes an unreferenced, clears a referenced', async () => {
    const db = getDb();
    const tabMediId = `tm${randomUUID().replace(/-/g, '')}`;
    const goneHash = randomUUID().replace(/-/g, '');
    const keptHash = randomUUID().replace(/-/g, '');
    const goneId = tabMediArquivoId(tabMediId, goneHash);
    const keptId = tabMediArquivoId(tabMediId, keptHash);
    const past = nowMicros() - DAY_MICROS;

    const seedMarked = async (storagePath: string, docId: string) => {
      const slash = storagePath.lastIndexOf('/');
      await db
        .collection('arquivos')
        .doc(docId)
        .set({
          filetype: 'image',
          filepath: storagePath.slice(0, slash),
          filename: storagePath.slice(slash + 1),
          contentType: 'image/png',
          url: null,
          externalIds: [],
          uploadState: 'finalized',
          criadoEm: past,
          markedForDeletionAt: past,
        });
    };

    await seedMarked(tabMediOriginalPath(tabMediId, goneHash, 'png'), goneId);
    await seedMarked(tabMediOriginalPath(tabMediId, keptHash, 'png'), keptId);

    // The tabela references ONLY keptId — exercises resolveReferencedRefs('tabMedi').
    await db
      .collection('tabMedi')
      .doc(tabMediId)
      .set({ nome: 'Tabela X', fotos: [{ arquivoOuterRef: `arquivos/${keptId}` }] });

    await sweepMarkedForDeletion(db);

    expect((await db.collection('arquivos').doc(goneId).get()).exists).toBe(false); // unreferenced → deleted
    const kept = await db.collection('arquivos').doc(keptId).get();
    expect(kept.exists).toBe(true); // referenced → kept
    expect(kept.data()?.markedForDeletionAt).toBeNull(); // mark cleared
  });
});
