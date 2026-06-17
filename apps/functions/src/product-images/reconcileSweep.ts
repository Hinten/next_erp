import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { arquivoCollection } from '@delfrance/data/admin/collections';

import { getAdminApp, getDb } from '../lib/admin';
import { processProductOriginal } from './processOriginal';

/**
 * Scheduled backfill for product originals whose derivatives never got created
 * — the resize function was down/failed, and because uploads are
 * content-addressed and deduped, a re-upload won't re-fire it (issue #189).
 *
 * Filtered, NOT a full catalog scan: originals are stamped
 * `resizeState: 'pending'` on upload and flipped to `'done'` once resized, so
 * this queries ONLY the stragglers (`where resizeState == 'pending'`) and
 * reconciles each through the shared, idempotent {@link processProductOriginal}.
 */
// Bound each run so a large backlog (resize down for a while) can't blow the
// function's time/memory budget — the hourly schedule drains it over several runs.
const BATCH_LIMIT = 100;

export const reconcileProductImages = onSchedule(
  { schedule: 'every 1 hours', memory: '512MiB' },
  async () => {
    const db = getDb();
    const bucket = getStorage(getAdminApp()).bucket(); // default bucket — the sweep has no event
    const pending = await arquivoCollection
      .ref(db, {})
      .where('resizeState', '==', 'pending')
      .limit(BATCH_LIMIT)
      .get();

    let processed = 0;
    let written = 0;
    let failed = 0;
    for (const doc of pending.docs) {
      const data = doc.data();
      const filepath = data.filepath as string | null | undefined;
      const filename = data.filename as string | undefined;
      if (!filepath || !filename) continue; // not a resolvable original path
      const name = `${filepath}/${filename}`;
      try {
        written += await processProductOriginal(bucket, db, name);
        processed += 1;
      } catch (err) {
        // Isolate per-doc failures (e.g. the Storage object was deleted/unreadable)
        // so one bad original doesn't abort the batch. Logged (not swallowed
        // silently); the doc stays `pending` and is retried next run.
        failed += 1;
        logger.error(`reconcileProductImages: ${name} (${doc.id}) failed`, err);
      }
    }
    logger.info(
      `reconcileProductImages: ${processed} processed, ${written} written, ${failed} failed (limit ${BATCH_LIMIT})`,
    );
  },
);
