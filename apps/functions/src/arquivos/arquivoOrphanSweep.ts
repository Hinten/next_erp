import type { Firestore } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';
import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { arquivoCollection } from '@delfrance/data/admin/collections';
import { ARQUIVOS_COLLECTION, coerceToMicros, nowMicros } from '@delfrance/schemas';

import { getAdminApp, getDb } from '../lib/admin';

type Bucket = ReturnType<Storage['bucket']>;

// Bound each pass so neither can blow the function budget; the every-48h schedule
// drains a backlog over several runs.
const BATCH_LIMIT = 100;

/**
 * Grace window in **microseconds** below which a doc is still considered "in
 * flight" — create-first writes the doc, THEN uploads, AND an arquivo is
 * unreferenced until its produto is saved — so a young doc may not yet have its
 * object / its produto link. Read per call (not at module load) so the emulator
 * suite can drop it to 0. 48h by default; non-numeric/negative falls back to 48h.
 */
function orphanGraceMicros(): number {
  const raw = Number(process.env.ARQUIVO_ORPHAN_GRACE_HOURS ?? '48');
  const hours = Number.isFinite(raw) && raw >= 0 ? raw : 48;
  return hours * 3_600_000 * 1000;
}

/**
 * Phantom-doc sweep: an `arquivos` doc stuck `uploadState: 'pending'` past the
 * grace window whose Storage object never arrived — a create-first upload the
 * client abandoned. Deletes the doc. If the object IS present (the trigger
 * missed/lagged the finalize), self-heals the marker to `'finalized'` instead.
 * Exported for the emulator suite.
 */
export async function sweepPhantomDocs(db: Firestore, bucket: Bucket): Promise<number> {
  const cutoff = nowMicros() - orphanGraceMicros();
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
      const criadoEm = coerceToMicros(data.criadoEm); // tolerant of legacy ISO
      // Still within the grace window → may just be mid-upload; leave it.
      if (criadoEm !== null && criadoEm > cutoff) {
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

/** True for a product-scoped, NON-derivative object path (originals + videos). */
function isSweepableProductPath(filepath: string | null | undefined): boolean {
  return (
    typeof filepath === 'string' &&
    filepath.startsWith('produtos/') &&
    !filepath.includes('/derivatives')
  );
}

/**
 * Unreferenced-arquivo sweep (core): delete product-scoped arquivos older than
 * the grace window that **no produto references** — e.g. a photo removed from a
 * produto in an edit (the `fotos[]` entry goes away but nothing deletes the
 * arquivo doc). Deleting the doc lets `onArquivoDeleted` free the object + cascade
 * the 3 derivatives.
 *
 * Takes the referenced-ref set as a parameter so it is emulator-testable without
 * the pipeline; production passes the result of {@link findReferencedArquivoRefs}.
 * `referencedRefs` holds `arquivos/<id>` document-path strings (the
 * `arquivoOuterRef` wire shape).
 *
 * Derivatives are excluded as candidates (cascade-managed by onArquivoDeleted);
 * the grace window protects an arquivo uploaded mid-produto-creation.
 */
export async function sweepUnreferencedArquivos(
  db: Firestore,
  bucket: Bucket,
  referencedRefs: ReadonlySet<string>,
): Promise<number> {
  const cutoff = nowMicros() - orphanGraceMicros();
  // Single-field range → ordered oldest-first, no composite index needed. Docs
  // with a non-numeric/missing criadoEm (legacy) are excluded — acceptable for a
  // backstop; they predate the micros migration.
  const candidates = await arquivoCollection
    .ref(db, {})
    .where('criadoEm', '<', cutoff)
    .limit(BATCH_LIMIT)
    .get();

  let deleted = 0;
  let kept = 0;
  let failed = 0;
  for (const doc of candidates.docs) {
    if (deleted >= BATCH_LIMIT) break;
    try {
      const data = doc.data();
      if (!isSweepableProductPath(data.filepath as string | null | undefined)) {
        kept += 1; // not a product original/video — leave it
        continue;
      }
      const ref = `${ARQUIVOS_COLLECTION}/${doc.id}`;
      if (referencedRefs.has(ref)) {
        kept += 1;
        continue;
      }
      // Unreferenced + past grace → delete the doc; onArquivoDeleted frees the
      // object and cascades derivatives.
      await doc.ref.delete();
      deleted += 1;
    } catch (err) {
      failed += 1;
      logger.error(`sweepUnreferencedArquivos: ${doc.id} failed`, err);
    }
  }
  logger.info(`sweepUnreferencedArquivos: ${deleted} deleted, ${kept} kept, ${failed} failed`);
  return deleted;
}

/**
 * Collect every `arquivos/<id>` ref a produto currently uses — across its
 * embedded `fotos` / `videos` / `anexos` arrays — via an admin **pipeline**
 * query (`@google-cloud/firestore` 8.x, requires firebase-admin 14 +
 * Firestore Enterprise). `select` projects only the three media arrays
 * server-side; the per-element `arquivoOuterRef` is flattened here.
 *
 * Pipeline queries do NOT run in the Firestore emulator, so this is validated
 * live (veste-france-debug), and {@link sweepUnreferencedArquivos} takes the
 * resulting set as a parameter so its logic stays emulator-testable.
 */
export async function findReferencedArquivoRefs(db: Firestore): Promise<Set<string>> {
  const snap = await db
    .pipeline()
    .collection('produtos')
    .select('fotos', 'videos', 'anexos')
    .execute();
  const refs = new Set<string>();
  for (const row of snap.results) {
    const data = row.data();
    for (const key of ['fotos', 'videos', 'anexos'] as const) {
      const arr = data[key];
      if (!Array.isArray(arr)) continue;
      for (const el of arr) {
        const ref = (el as { arquivoOuterRef?: unknown } | null)?.arquivoOuterRef;
        if (typeof ref === 'string' && ref) refs.add(ref);
      }
    }
  }
  return refs;
}

/**
 * Scheduled (every 48h) arquivo orphan reconciliation. Two bounded passes, each
 * isolating per-item failures: the phantom-doc sweep, then the
 * unreferenced-arquivo sweep (its referenced set built by the pipeline
 * {@link findReferencedArquivoRefs}).
 */
export const reconcileArquivoOrphans = onSchedule(
  { schedule: 'every 48 hours', memory: '512MiB' },
  async () => {
    const db = getDb();
    const bucket = getStorage(getAdminApp()).bucket();
    const phantoms = await sweepPhantomDocs(db, bucket);
    const referenced = await findReferencedArquivoRefs(db);
    const unreferenced = await sweepUnreferencedArquivos(db, bucket, referenced);
    logger.info(
      `reconcileArquivoOrphans: ${phantoms} phantom docs + ${unreferenced} unreferenced arquivos cleaned`,
    );
  },
);
