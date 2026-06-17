import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  PRODUCT_IMAGE_VARIANTS,
  derivativeArquivoId,
  productOriginalPath,
} from '@delfrance/schemas';

// Integration test — requires the Firebase emulators (firestore + storage +
// functions). Run via `firebase emulators:exec`; skipped when run bare so the
// offline suite stays green.
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';
const bucketName = `${projectId}.appspot.com`;

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

describe.skipIf(!EMULATED)('resizeProductImage (emulator)', () => {
  let produtoId: string;
  let hash: string;

  beforeAll(async () => {
    produtoId = `p${randomUUID().replace(/-/g, '')}`;
    hash = randomUUID().replace(/-/g, '');
    const image = await sharp({
      create: {
        width: 900,
        height: 600,
        channels: 3,
        background: { r: 200, g: 100, b: 50 },
      },
    })
      .png()
      .toBuffer();
    await getBucket()
      .file(productOriginalPath(produtoId, hash, 'png'))
      .save(image, { contentType: 'image/png' });
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
});
