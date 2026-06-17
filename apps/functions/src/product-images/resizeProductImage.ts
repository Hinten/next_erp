import { getStorage } from 'firebase-admin/storage';
import { onObjectFinalized } from 'firebase-functions/v2/storage';

import { getAdminApp, getDb } from '../lib/admin';
import { shouldResize } from './guards';
import { processProductOriginal } from './processOriginal';

/**
 * Resize a product photo into its 200px / 400px / full-JPEG derivatives.
 *
 * Triggered on every finalized Storage object, but {@link shouldResize} bails
 * for anything that is not a fresh product-image original — the loop guard
 * (derivatives carry `resized=true` metadata and live under a different prefix,
 * so they never re-trigger this function).
 *
 * The actual work lives in {@link processProductOriginal} (shared with the
 * scheduled reconcile sweep): it writes ONLY to the `arquivos` collection (the
 * derivative docs + the original's `resizeState: 'done'` marker), never to
 * `produtos`, and is idempotent.
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
    const bucket = getStorage(getAdminApp()).bucket(event.data.bucket);
    await processProductOriginal(bucket, getDb(), name);
  },
);
