import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { arquivoCollection } from '@delfrance/data/admin/collections';

import { getAdminApp, getDb } from '../lib/admin';
import { isGrpcLikeError } from '../lib/grpcErrors';
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
// function's time/memory budget — the every-48h schedule drains it over several runs.
const BATCH_LIMIT = 100;

export const reconcileProductImages = onSchedule(
  { schedule: 'every 48 hours', memory: '512MiB' },
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
    let skipped = 0;
    for (const doc of pending.docs) {
      const data = doc.data();
      const filepath = data.filepath as string | null | undefined;
      const filename = data.filename as string | undefined;
      if (!filepath || !filename) {
        // A 'pending' marker is only ever written by an upload helper —
        // `uploadProductImage` or `uploadTabMediImage` — and both always set
        // filepath + filename, so an unresolvable path means an out-of-band /
        // malformed doc, not something a real upload path can produce. Warn
        // instead of skipping silently; it stays 'pending' but can't stall the
        // sweep at scale because no real path makes one.
        skipped += 1;
        logger.warn(
          `reconcileProductImages: ${doc.id} is 'pending' but has no resolvable path ` +
            `(filepath=${filepath ?? 'null'}, filename=${filename ?? 'null'}) — skipping`,
        );
        continue;
      }
      const name = `${filepath}/${filename}`;
      try {
        written += await processProductOriginal(bucket, db, name);
        processed += 1;
      } catch (err) {
        // Only gRPC-shaped Admin-SDK errors (e.g. the Storage object was
        // deleted/unreadable) are isolated per-doc; anything else propagates
        // and aborts the run (deliberate — a non-gRPC failure, like `sharp`
        // choking on a corrupt image, is not safe to silently keep retrying
        // per-doc forever). The doc stays `pending` and is retried next run.
        if (!isGrpcLikeError(err)) throw err;
        failed += 1;
        logger.error(`reconcileProductImages: ${name} (${doc.id}) failed`, err);
      }
    }
    logger.info(
      `reconcileProductImages: ${processed} processed, ${written} written, ${failed} failed, ${skipped} skipped (limit ${BATCH_LIMIT})`,
    );
  },
);
