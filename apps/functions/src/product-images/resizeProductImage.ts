import { randomUUID } from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { arquivoCollection } from '@delfrance/data/admin/collections';
import {
  derivativeArquivoId,
  firebaseDownloadUrl,
  parseProductOriginalPath,
  productDerivativePath,
} from '@delfrance/schemas';

import { getAdminApp, getDb } from '../lib/admin';
import { shouldResize } from './guards';
import { renderAllVariants } from './variants';

/**
 * Resize a product photo into its 200px / 400px / full-JPEG derivatives.
 *
 * Triggered on every finalized Storage object, but {@link shouldResize} bails
 * for anything that is not a fresh product-image original — the loop guard.
 * Derivatives are written to a different prefix (`…/derivatives/…`) tagged with
 * `resized=true` metadata, so they never re-trigger this function.
 *
 * Writes ONLY to the `arquivos` collection (the derivative docs), never to
 * `produtos` — so no Firestore trigger fires as a result. Idempotent: a
 * derivative whose `Arquivo` doc already exists is skipped.
 */
export const resizeProductImage = onObjectFinalized(
  { memory: '512MiB', retry: false },
  async (event) => {
    const name = event.data.name;
    if (!name) return;
    if (
      !shouldResize({
        name,
        contentType: event.data.contentType,
        metadata: event.data.metadata,
      })
    ) {
      return;
    }
    const parsed = parseProductOriginalPath(name);
    if (!parsed) return;
    const { produtoId, hash } = parsed;

    const bucket = getStorage(getAdminApp()).bucket(event.data.bucket);
    const [input] = await bucket.file(name).download();

    const variants = await renderAllVariants(input);
    const db = getDb();

    let written = 0;
    for (const v of variants) {
      const derivId = derivativeArquivoId(produtoId, hash, v.spec.key);

      // Idempotency: a re-finalize of the same original must not duplicate work.
      const existing = await arquivoCollection.docRef(db, {}, derivId).get();
      if (existing.exists) continue;

      const path = productDerivativePath(produtoId, hash, v.spec.key);
      const token = randomUUID();
      await bucket.file(path).save(v.buffer, {
        contentType: v.contentType,
        metadata: {
          metadata: {
            resized: 'true',
            originalPath: name,
            firebaseStorageDownloadTokens: token,
          },
        },
      });
      const url = firebaseDownloadUrl(bucket.name, path, token);

      const slash = path.lastIndexOf('/');
      await arquivoCollection.set(db, {}, derivId, {
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

    logger.info(
      `resizeProductImage: ${name} → ${written}/${variants.length} derivatives`,
    );
  },
);
