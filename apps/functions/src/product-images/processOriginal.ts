import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions';
import { arquivoCollection } from '@delfrance/data/admin/collections';
import {
  PRODUCT_IMAGE_VARIANTS,
  derivativeArquivoId,
  firebaseDownloadUrl,
  parseProductOriginalPath,
  productArquivoId,
  productDerivativePath,
} from '@delfrance/schemas';

import { renderAllVariants } from './variants';

type Bucket = ReturnType<Storage['bucket']>;

/**
 * Resize one product-image ORIGINAL into its missing 200/400/jpeg derivatives.
 * Shared by the `onObjectFinalized` trigger and the scheduled reconcile sweep.
 *
 * Idempotent and cheap to re-run: it first checks which derivative `arquivos`
 * docs already exist and skips the download entirely when none are missing.
 * After writing whatever was missing it stamps the original's
 * `resizeState: 'done'` (merge — same `arquivos` collection, so it triggers
 * nothing) which stops the sweep's `where resizeState == 'pending'` query from
 * matching it.
 *
 * Writes ONLY to the `arquivos` collection (the derivative docs + the original's
 * marker), never to `produtos`. Returns the number of derivatives written.
 */
export async function processProductOriginal(
  bucket: Bucket,
  db: Firestore,
  name: string,
): Promise<number> {
  const parsed = parseProductOriginalPath(name);
  if (!parsed) return 0;
  const { produtoId, hash } = parsed;

  // Which derivatives already exist? Lets us skip the download when complete.
  const snaps = await Promise.all(
    PRODUCT_IMAGE_VARIANTS.map((v) =>
      arquivoCollection.docRef(db, {}, derivativeArquivoId(produtoId, hash, v.key)).get(),
    ),
  );
  const present = new Set(
    PRODUCT_IMAGE_VARIANTS.filter((_, i) => snaps[i]!.exists).map((v) => v.key),
  );
  if (present.size === PRODUCT_IMAGE_VARIANTS.length) {
    await markDone(db, produtoId, hash);
    return 0;
  }

  const [input] = await bucket.file(name).download();
  const variants = await renderAllVariants(input);

  let written = 0;
  for (const v of variants) {
    if (present.has(v.spec.key)) continue; // idempotent: skip already-written derivatives
    const path = productDerivativePath(produtoId, hash, v.spec.key);
    const token = randomUUID();
    await bucket.file(path).save(v.buffer, {
      contentType: v.contentType,
      metadata: {
        metadata: { resized: 'true', originalPath: name, firebaseStorageDownloadTokens: token },
      },
    });
    const url = firebaseDownloadUrl(bucket.name, path, token);
    const slash = path.lastIndexOf('/');
    await arquivoCollection.set(db, {}, derivativeArquivoId(produtoId, hash, v.spec.key), {
      filetype: 'image',
      filepath: path.slice(0, slash),
      filename: path.slice(slash + 1),
      contentType: v.contentType,
      url,
      externalIds: [],
      criadoEm: new Date().toISOString(),
    });
    written += 1;
  }

  await markDone(db, produtoId, hash);
  logger.info(`processProductOriginal: ${name} → ${written}/${variants.length} derivatives`);
  return written;
}

/**
 * Stamp the ORIGINAL arquivo doc as fully resized. UPDATE-only — never creates
 * the doc: the upload path (`uploadProductImage`) writes the full original with
 * `resizeState: 'pending'`, so a missing doc here means either the trigger raced
 * ahead of the client's `setDoc` or the object was uploaded out-of-band (e.g.
 * the Console). In both cases we skip rather than leave a partial Arquivo doc;
 * the sweep flips it to `'done'` once the real `'pending'` doc exists.
 */
async function markDone(db: Firestore, produtoId: string, hash: string): Promise<void> {
  const ref = arquivoCollection.docRef(db, {}, productArquivoId(produtoId, hash));
  const snap = await ref.get();
  if (snap.exists) {
    await ref.update({ resizeState: 'done' });
  }
}
