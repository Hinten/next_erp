import type { Firestore } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';
import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { arquivoCollection } from '@delfrance/data/admin/collections';
import { STORAGE_ROOT, arquivoIdForStoragePath } from '@delfrance/schemas';

import { getAdminApp, getDb } from '../lib/admin';

type Bucket = ReturnType<Storage['bucket']>;

// Bound each pass so neither can blow the function budget; the every-48h schedule
// drains a backlog over several runs.
const BATCH_LIMIT = 100;

/**
 * Grace window (hours) below which an object/doc is still considered "in flight"
 * — create-first writes the doc, THEN uploads, so a young pending doc may simply
 * not have finished uploading yet. Read per call (not at module load) so the
 * emulator suite can drop it to 0. 48h by default.
 */
function orphanGraceMs(): number {
  const raw = Number(process.env.ARQUIVO_ORPHAN_GRACE_HOURS ?? '48');
  // Guard a non-numeric / negative env value: a NaN cutoff makes every grace
  // check false → everything treated as past the window → in-flight uploads
  // could be deleted. Fall back to the safe 48h default.
  const hours = Number.isFinite(raw) && raw >= 0 ? raw : 48;
  return hours * 3_600_000;
}

/**
 * Phantom-doc sweep: an `arquivos` doc stuck `uploadState: 'pending'` past the
 * grace window whose Storage object never arrived — a create-first upload the
 * client abandoned. Deletes the doc. If the object IS present (the trigger
 * missed/lagged the finalize), self-heals the marker to `'finalized'` instead.
 * Exported for the emulator suite.
 */
export async function sweepPhantomDocs(db: Firestore, bucket: Bucket): Promise<number> {
  const cutoff = Date.now() - orphanGraceMs();
  const pending = await arquivoCollection
    .ref(db, {})
    .where('uploadState', '==', 'pending')
    .limit(BATCH_LIMIT)
    .get();

  let deleted = 0;
  let healed = 0;
  let kept = 0;
  let failed = 0;
  for (const doc of pending.docs) {
    try {
      const data = doc.data();
      const criadoEm = typeof data.criadoEm === 'string' ? Date.parse(data.criadoEm) : NaN;
      // Still within the grace window → may just be mid-upload; leave it.
      if (!Number.isNaN(criadoEm) && criadoEm > cutoff) {
        kept += 1;
        continue;
      }
      const filepath = data.filepath as string | null | undefined;
      const filename = data.filename as string | undefined;
      if (!filename) {
        // A 'pending' doc with no filename can't be resolved to an object — it
        // can't happen via create-first (filename is schema-required), so warn
        // rather than skip silently (mirrors reconcileProductImages).
        kept += 1;
        logger.warn(`sweepPhantomDocs: ${doc.id} is 'pending' with no filename — skipping`);
        continue;
      }
      const objectName = filepath ? `${filepath}/${filename}` : filename;
      const [exists] = await bucket.file(objectName).exists();
      if (exists) {
        await doc.ref.update({ uploadState: 'finalized' });
        healed += 1;
        continue;
      }
      await doc.ref.delete();
      deleted += 1;
    } catch (err) {
      failed += 1;
      logger.error(`sweepPhantomDocs: ${doc.id} failed`, err);
    }
  }
  logger.info(
    `sweepPhantomDocs: ${deleted} deleted, ${healed} healed, ${kept} kept, ${failed} failed`,
  );
  return deleted;
}

/**
 * Storage-orphan sweep: a Storage object past the grace window whose owning
 * `arquivos` doc no longer exists (deleted out of band, a partial cascade, or a
 * pre-create-first legacy upload). Deletes the object. Exported for the emulator
 * suite.
 */
export async function sweepOrphanObjects(db: Firestore, bucket: Bucket): Promise<number> {
  const cutoff = Date.now() - orphanGraceMs();
  let deleted = 0;
  let kept = 0;
  let failed = 0;
  for (const prefix of [`${STORAGE_ROOT.produtos}/`, `${STORAGE_ROOT.media}/`]) {
    // Scan the FULL listing (getFiles auto-paginates): listing order is
    // lexicographic, not by age, so a single bounded page would let orphans that
    // sort later never be examined (permanent starvation, since kept objects
    // don't shrink the set). DELETES are still capped at BATCH_LIMIT/run, so a
    // large orphan backlog drains over runs; deletes are terminal, so nothing is
    // re-examined indefinitely. (Holds one prefix's listing in memory — fine for
    // a per-tenant catalog on a 48h backstop.)
    const [files] = await bucket.getFiles({ prefix });
    for (const file of files) {
      if (deleted >= BATCH_LIMIT) break;
      try {
        const created = file.metadata.timeCreated
          ? Date.parse(String(file.metadata.timeCreated))
          : NaN;
        if (!Number.isNaN(created) && created > cutoff) {
          kept += 1;
          continue;
        }
        const fromMeta = file.metadata.metadata?.arquivoId;
        const arquivoId =
          (typeof fromMeta === 'string' ? fromMeta : null) ?? arquivoIdForStoragePath(file.name);
        if (!arquivoId) {
          kept += 1; // unrecognized path — not ours to delete
          continue;
        }
        const docSnap = await arquivoCollection.docRef(db, {}, arquivoId).get();
        if (docSnap.exists) {
          kept += 1;
          continue;
        }
        await file.delete({ ignoreNotFound: true });
        deleted += 1;
      } catch (err) {
        failed += 1;
        logger.error(`sweepOrphanObjects: ${file.name} failed`, err);
      }
    }
  }
  logger.info(`sweepOrphanObjects: ${deleted} deleted, ${kept} kept, ${failed} failed`);
  return deleted;
}

/**
 * Scheduled (every 48h) arquivo orphan reconciliation — both directions, plain
 * existence checks (no pipeline API; see ADR 0010 Phase 2). Runs the phantom-doc
 * sweep then the storage-orphan sweep; each pass is bounded and isolates per-item
 * failures.
 */
export const reconcileArquivoOrphans = onSchedule(
  { schedule: 'every 48 hours', memory: '512MiB' },
  async () => {
    const db = getDb();
    const bucket = getStorage(getAdminApp()).bucket();
    const phantoms = await sweepPhantomDocs(db, bucket);
    const orphans = await sweepOrphanObjects(db, bucket);
    logger.info(
      `reconcileArquivoOrphans: ${phantoms} phantom docs + ${orphans} orphan objects cleaned`,
    );
  },
);
