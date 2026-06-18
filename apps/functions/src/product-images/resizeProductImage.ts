import { getStorage } from 'firebase-admin/storage';
import { onObjectFinalized } from 'firebase-functions/v2/storage';

import { arquivoIdForObject, markUploadFinalized } from '../arquivos/markUploadFinalized';
import { getAdminApp, getDb } from '../lib/admin';
import { shouldResize } from './guards';
import { processProductOriginal } from './processOriginal';

/**
 * The `onObjectFinalized` handler does two things, in order:
 *
 *  1. **Upload confirmed** — flips the owning `arquivos` doc's `uploadState` to
 *     `'finalized'` (the authoritative "the bytes arrived" signal). This runs
 *     for EVERY non-derivative upload — images, videos AND generic media — so
 *     the phantom-doc orphan sweep can tell an abandoned upload from a real one.
 *  2. **Resize** — for a fresh product-image original ({@link shouldResize}),
 *     generates the 200px / 400px / full-JPEG derivatives via
 *     {@link processProductOriginal} (shared with the reconcile sweep; writes
 *     ONLY the `arquivos` collection — derivative docs + the original's
 *     `resizeState: 'done'` — never `produtos`, and is idempotent).
 *
 * Derivatives carry `resized=true` metadata and live under a different prefix,
 * so they never re-trigger this function (the loop guard).
 */
export const resizeProductImage = onObjectFinalized(
  { memory: '512MiB', retry: false },
  async (event) => {
    const name = event.data.name;
    if (!name) return;
    const metadata = event.data.metadata;
    // Our own derivative outputs already have a complete doc at creation —
    // never re-stamp or re-resize them.
    if (metadata?.resized === 'true') return;

    const db = getDb();
    const docId = arquivoIdForObject(name, metadata);
    if (docId) await markUploadFinalized(db, docId);

    if (shouldResize({ name, contentType: event.data.contentType, metadata })) {
      const bucket = getStorage(getAdminApp()).bucket(event.data.bucket);
      await processProductOriginal(bucket, db, name);
    }
  },
);
