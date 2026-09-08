import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  PRODUCT_IMAGE_VARIANTS,
  derivativeArquivoId,
  mediaPath,
  productArquivoId,
  productDerivativePath,
  productOriginalPath,
} from '@delfrance/schemas';

import { processProductOriginal } from './processOriginal';

import {
  INTRA_HANDLER_WINDOW_MS,
  WAIT_LABELS,
  type WaitLabel,
  sleep,
  waitForTrigger,
  waitForTriggerThenSettle,
} from '../testing/emulatorWaits';

// Integration test — requires the Firebase emulators (firestore + storage +
// functions). Run via `firebase emulators:exec`; skipped when run bare so the
// offline suite stays green.
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';
const bucketName = `${projectId}.appspot.com`;

const SOURCE_WIDTH = 900;
const SOURCE_HEIGHT = 600;

function getDb() {
  const app = getApps()[0] ?? initializeApp({ projectId, storageBucket: bucketName });
  // Must match the database the function writes to (src/lib/admin.ts) — the named
  // `default` database, not `(default)`.
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}
function getBucket() {
  const app = getApps()[0] ?? initializeApp({ projectId, storageBucket: bucketName });
  return getStorage(app).bucket(bucketName);
}

/**
 * Wait for the trigger to produce something. The deadline is the suite-wide one
 * (`../testing/emulatorWaits`); this file used to carry its own 20s.
 */
async function waitFor<T>(fn: () => Promise<T | null>, label: WaitLabel): Promise<T> {
  const value = await waitForTrigger(
    fn,
    (v) => v !== null,
    'the trigger to fire',
    () => 'nothing had arrived',
    { label },
  );
  return value as T;
}

async function listDerivatives(produtoId: string): Promise<string[]> {
  const [files] = await getBucket().getFiles({
    prefix: `produtos/${produtoId}/derivatives/`,
  });
  return files.map((f) => f.name);
}

describe.skipIf(!EMULATED)('resizeProductImage (emulator)', () => {
  let produtoId: string;
  let hash: string;
  let original: Buffer;

  beforeAll(async () => {
    produtoId = `p${randomUUID().replace(/-/g, '')}`;
    hash = randomUUID().replace(/-/g, '');
    original = await sharp({
      create: {
        width: SOURCE_WIDTH,
        height: SOURCE_HEIGHT,
        channels: 3,
        background: { r: 200, g: 100, b: 50 },
      },
    })
      .png()
      .toBuffer();

    // Seed the ORIGINAL Arquivo doc with resizeState:'pending' BEFORE the upload,
    // mirroring the real upload path (uploadProductImage) — so the trigger's
    // markDone flips an EXISTING doc to 'done' (it never creates one). Written
    // first so the doc exists by the time the finalize event fires.
    const oPath = productOriginalPath(produtoId, hash, 'png');
    const slash = oPath.lastIndexOf('/');
    await getDb()
      .collection('arquivos')
      .doc(productArquivoId(produtoId, hash))
      .set({
        filetype: 'image',
        filepath: oPath.slice(0, slash),
        filename: oPath.slice(slash + 1),
        contentType: 'image/png',
        url: null,
        externalIds: [],
        resizeState: 'pending',
      });
    await getBucket().file(oPath).save(original, { contentType: 'image/png' });
  });

  it('creates the 200/400/jpeg derivative Arquivo docs', async () => {
    const db = getDb();
    for (const variant of PRODUCT_IMAGE_VARIANTS) {
      const id = derivativeArquivoId(produtoId, hash, variant.key);
      const snap = await waitFor(async () => {
        const doc = await db.collection('arquivos').doc(id).get();
        return doc.exists ? doc : null;
      }, WAIT_LABELS.arquivoDoc);
      const data = snap.data();
      expect(data?.filetype).toBe('image');
      expect(data?.contentType).toBe('image/jpeg');
      expect(typeof data?.url).toBe('string');
    }
  });

  it('writes the resized derivative OBJECTS with the loop-guard metadata', async () => {
    const expectedOriginal = productOriginalPath(produtoId, hash, 'png');
    for (const variant of PRODUCT_IMAGE_VARIANTS) {
      const file = getBucket().file(productDerivativePath(produtoId, hash, variant.key));
      const [exists] = await waitFor(async () => {
        const [ok] = await file.exists();
        return ok ? [ok] : null;
      }, WAIT_LABELS.derivativeObject);
      expect(exists).toBe(true);

      // Custom metadata is the anti-loop marker: derivatives are tagged
      // `resized=true` so a finalize on them bails in `shouldResize`.
      const [md] = await file.getMetadata();
      expect(md.contentType).toBe('image/jpeg');
      expect(md.metadata?.resized).toBe('true');
      expect(md.metadata?.originalPath).toBe(expectedOriginal);

      // The bytes are the RESIZED image (not a copy of the original) — width
      // matches the spec (null = full source width).
      const [buf] = await file.download();
      const meta = await sharp(buf).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBe(variant.width ?? SOURCE_WIDTH);
    }
  });

  it('does not recurse on its own derivative outputs', async () => {
    // The function fires on EVERY finalize, including the derivatives it just
    // wrote — the loop guard must stop it.
    //
    // Wait for the full set (positive proof the resize ran), then hold still and
    // RE-READ: a recursion would push the count past one-per-variant during the
    // quiet window, and the exact-count assertion below then fails. The old
    // `waitForStableCount` returned its last value on deadline instead of
    // throwing, so a stalled emulator reported a stale count as if it had settled.
    const names = await waitForTriggerThenSettle(
      () => listDerivatives(produtoId),
      (files) => files.length >= PRODUCT_IMAGE_VARIANTS.length,
      `${PRODUCT_IMAGE_VARIANTS.length} derivative object(s)`,
      (files) => `saw ${files.length}`,
      { label: WAIT_LABELS.derivativeObject },
    );
    expect(names).toHaveLength(PRODUCT_IMAGE_VARIANTS.length);
    expect(names.every((n) => !/_(?:200|400|jpeg)_(?:200|400|jpeg)\./.test(n))).toBe(true);
  });

  it('is idempotent — a re-finalized original does not rewrite derivatives', async () => {
    const db = getDb();
    const id = derivativeArquivoId(produtoId, hash, PRODUCT_IMAGE_VARIANTS[0]!.key);
    const before = (await db.collection('arquivos').doc(id).get()).data();

    // ⚠️ This was `sleep(5_000)` then the comparison below. #1201 measured
    // delivery at max 10712ms, so "the derivative was not rewritten" was
    // indistinguishable from "the trigger had not run yet" — it passed in exactly
    // the regressed case it exists to catch, and a longer sleep only lowers the
    // odds rather than making the claim provable.
    //
    // ⚠️ `uploadState` alone is the WRONG anchor here, and a quiet window does not
    // rescue it. `resizeProductImage.ts:37-41` awaits `markUploadFinalized` and
    // THEN awaits `processProductOriginal`, so the upload flag flips before the
    // resize work even begins — and in the regressed case that work is a bucket
    // download, 3 sharp renders and 6 writes, i.e. seconds under the same load
    // #1201 measured at p99 7s. A 2s `INTRA_HANDLER_WINDOW_MS` is not a bound on
    // that; it is also outside that constant's contract, which is the gap between
    // two `set()`s issued CONCURRENTLY.
    //
    // `processProductOriginal` calls `markDone` at the end of BOTH branches
    // (`processOriginal.ts:59` skip, `:91` write), so `resizeState` flipping back
    // to 'done' is exact positive proof the resize branch COMPLETED. Reset it with
    // the upload flag and wait for that instead — no window, nothing sized by guess.
    const origId = productArquivoId(produtoId, hash);
    await db
      .collection('arquivos')
      .doc(origId)
      .update({ uploadState: 'pending', resizeState: 'pending' });

    // Re-upload the SAME original bytes → onObjectFinalized fires again; the
    // existing-derivative check must skip the write.
    await getBucket()
      .file(productOriginalPath(produtoId, hash, 'png'))
      .save(original, { contentType: 'image/png' });

    await waitFor(async () => {
      const d = await db.collection('arquivos').doc(origId).get();
      return d.data()?.resizeState === 'done' ? d : null;
    }, WAIT_LABELS.arquivoDoc);

    const after = (await db.collection('arquivos').doc(id).get()).data();
    expect(after?.criadoEm).toBe(before?.criadoEm);
    expect(await listDerivatives(produtoId)).toHaveLength(PRODUCT_IMAGE_VARIANTS.length);
  });

  it('ignores a non-product upload (skip path)', async () => {
    // A file outside `produtos/<id>/originals/` is not a watched original, so
    // the function bails and produces no derivatives — neither under `media/`
    // NOR (the assertion that actually matters) against the existing product.
    const db = getDb();
    const before = (await listDerivatives(produtoId)).length;
    const otherHash = randomUUID().replace(/-/g, '');

    // ⚠️ This asserted "the trigger did not do X" while having NO proof the
    // trigger ran at all: the old `waitForStableCount` settled at the unchanged
    // count in ~2.5s, well inside the 8-10s delivery tail #1201 measured. So it
    // could only ever have caught a regression that was ALSO fast.
    //
    // Create-first (the repo's upload contract) gives the object an owning doc,
    // and tagging it with `arquivoId` is what lets `markUploadFinalized` resolve
    // it — so `uploadState` flipping is positive proof the handler ran for THIS
    // object, even though the resize branch correctly skipped it.
    const mediaArquivoId = `media-${otherHash}`;
    await db
      .collection('arquivos')
      .doc(mediaArquivoId)
      .set({
        filetype: 'image',
        filepath: 'media',
        filename: `${otherHash}.png`,
        contentType: 'image/png',
        url: null,
        externalIds: [],
        uploadState: 'pending',
      });

    await getBucket()
      .file(mediaPath(otherHash, 'png'))
      .save(original, {
        contentType: 'image/png',
        metadata: { metadata: { arquivoId: mediaArquivoId } },
      });

    await waitFor(async () => {
      const d = await db.collection('arquivos').doc(mediaArquivoId).get();
      return d.data()?.uploadState === 'finalized' ? d : null;
    }, WAIT_LABELS.uploadFinalized);

    // Same intra-invocation window as the idempotency test above.
    await sleep(INTRA_HANDLER_WINDOW_MS);

    // The product's derivative set must stay put through the unrelated upload.
    expect(await listDerivatives(produtoId)).toHaveLength(before);

    const [mediaFiles] = await getBucket().getFiles({ prefix: 'media/' });
    expect(mediaFiles.map((f) => f.name)).toEqual([mediaPath(otherHash, 'png')]);
  });

  it('marks the original resizeState=done and the reconcile core backfills a missing derivative', async () => {
    const db = getDb();
    const origId = productArquivoId(produtoId, hash);

    // The trigger stamps the ORIGINAL arquivo doc `done` once derivatives exist.
    const orig = await waitFor(async () => {
      const d = await db.collection('arquivos').doc(origId).get();
      return d.exists && d.data()?.resizeState === 'done' ? d : null;
    }, WAIT_LABELS.arquivoDoc);
    expect(orig.data()?.resizeState).toBe('done');
    // The same trigger run flips uploadState → 'finalized' (markUploadFinalized
    // runs before the resize), so by the time resizeState is 'done' it is set.
    expect(orig.data()?.uploadState).toBe('finalized');

    // Simulate a straggler (issue #189): drop one derivative doc, then run the
    // reconcile core — what the scheduled sweep calls — and assert it backfills
    // ONLY the missing one and re-stamps the original done.
    const id200 = derivativeArquivoId(produtoId, hash, '200');
    await db.collection('arquivos').doc(id200).delete();
    const written = await processProductOriginal(
      getBucket(),
      db,
      productOriginalPath(produtoId, hash, 'png'),
    );
    expect(written).toBe(1);
    expect((await db.collection('arquivos').doc(id200).get()).exists).toBe(true);
    expect((await db.collection('arquivos').doc(origId).get()).data()?.resizeState).toBe('done');
  });
});
