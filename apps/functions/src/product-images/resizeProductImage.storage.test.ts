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
  productDerivativePath,
  productOriginalPath,
} from '@delfrance/schemas';

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  fn: () => Promise<T | null>,
  timeoutMs = 20_000,
  stepMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/**
 * Poll `count()` until the value stops changing for `stableMs`, then return the
 * settled value. More robust than a blind sleep for asserting "nothing further
 * happened": a late or runaway write (e.g. the function recursing on its own
 * outputs) keeps the count changing, so it never settles early at the expected
 * value — and if it settles higher, the caller's assertion catches it.
 */
async function waitForStableCount(
  count: () => Promise<number>,
  { stableMs = 2_000, stepMs = 500, timeoutMs = 20_000 } = {},
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = await count();
  let stableSince = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, stepMs));
    const cur = await count();
    if (cur !== last) {
      last = cur;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= stableMs) {
      return cur;
    }
    if (Date.now() > deadline) return cur;
  }
}

/** List this product's derivative objects (the `derivatives/` subdir). */
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
    await getBucket()
      .file(productOriginalPath(produtoId, hash, 'png'))
      .save(original, { contentType: 'image/png' });
  });

  it('creates the 200/400/jpeg derivative Arquivo docs', async () => {
    const db = getDb();
    for (const variant of PRODUCT_IMAGE_VARIANTS) {
      const id = derivativeArquivoId(produtoId, hash, variant.key);
      const snap = await waitFor(async () => {
        const doc = await db.collection('arquivos').doc(id).get();
        return doc.exists ? doc : null;
      });
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
      });
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
    // wrote — the loop guard must stop it. Wait for the derivative count to
    // SETTLE (a runaway recursion would keep it climbing) and assert it settled
    // at exactly one per variant, with no derivative-of-derivative names.
    const settled = await waitForStableCount(async () => (await listDerivatives(produtoId)).length);
    expect(settled).toBe(PRODUCT_IMAGE_VARIANTS.length);
    const names = await listDerivatives(produtoId);
    expect(names.every((n) => !/_(?:200|400|jpeg)_(?:200|400|jpeg)\./.test(n))).toBe(true);
  });

  it('is idempotent — a re-finalized original does not rewrite derivatives', async () => {
    const db = getDb();
    const id = derivativeArquivoId(produtoId, hash, PRODUCT_IMAGE_VARIANTS[0]!.key);
    const before = (await db.collection('arquivos').doc(id).get()).data();

    // Re-upload the SAME original bytes → onObjectFinalized fires again; the
    // existing-derivative check must skip the write.
    await getBucket()
      .file(productOriginalPath(produtoId, hash, 'png'))
      .save(original, { contentType: 'image/png' });
    await sleep(5_000);

    const after = (await db.collection('arquivos').doc(id).get()).data();
    expect(after?.criadoEm).toBe(before?.criadoEm);
    expect(await listDerivatives(produtoId)).toHaveLength(PRODUCT_IMAGE_VARIANTS.length);
  });

  it('ignores a non-product upload (skip path)', async () => {
    // A file outside `produtos/<id>/originals/` is not a watched original, so
    // the function bails and produces no derivatives — neither under `media/`
    // NOR (the assertion that actually matters) against the existing product.
    const before = (await listDerivatives(produtoId)).length;
    const otherHash = randomUUID().replace(/-/g, '');
    await getBucket()
      .file(mediaPath(otherHash, 'png'))
      .save(original, { contentType: 'image/png' });

    // The product's derivative set must stay put through the unrelated upload.
    const after = await waitForStableCount(async () => (await listDerivatives(produtoId)).length);
    expect(after).toBe(before);

    const [mediaFiles] = await getBucket().getFiles({ prefix: 'media/' });
    expect(mediaFiles.map((f) => f.name)).toEqual([mediaPath(otherHash, 'png')]);
  });
});
