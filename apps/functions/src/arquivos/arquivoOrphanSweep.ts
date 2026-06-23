import type { Firestore } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';
import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { arquivoCollection } from '@delfrance/data/admin/collections';
import {
  ARQUIVOS_COLLECTION,
  coerceToMicros,
  nowMicros,
  parseProductMediaDir,
} from '@delfrance/schemas';

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

/**
 * Collect every `arquivos/<id>` ref the given produtos currently use — across
 * their embedded `fotos` / `videos` / `anexos` arrays. Reads **only** the named
 * produtos (one batched `getAll`, projected to the three media arrays), NOT the
 * whole collection: a product arquivo encodes its owner `produtoId` in its
 * storage path, so the sweep already knows which produto to ask about.
 *
 * A produto that doesn't exist contributes nothing — its arquivos are orphans.
 * Plain admin SDK reads (no pipeline / Enterprise dependency), so this is fully
 * emulator-testable.
 */
export async function resolveReferencedArquivoRefs(
  db: Firestore,
  produtoIds: string[],
): Promise<Set<string>> {
  const refs = new Set<string>();
  if (produtoIds.length === 0) return refs;

  const docRefs = produtoIds.map((id) => db.collection('produtos').doc(id));
  // Field mask → transfer only the three media arrays, still one read per produto.
  const snaps = await db.getAll(...docRefs, { fieldMask: ['fotos', 'videos', 'anexos'] });
  for (const snap of snaps) {
    if (!snap.exists) continue; // produto deleted → leave its arquivos orphaned
    const data = (snap.data() ?? {}) as Record<string, unknown>;
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

/** Resolves the `arquivos/<id>` refs a set of produtos currently uses. */
type ResolveReferenced = (produtoIds: string[]) => Promise<ReadonlySet<string>>;

/**
 * Unreferenced-arquivo sweep: delete product photos / videos older than the
 * grace window that **no produto references** — e.g. a photo removed from a
 * produto in an edit (the `fotos[]` entry goes away but nothing deletes the
 * arquivo doc), or a produto deleted entirely. Deleting the doc lets
 * `onArquivoDeleted` free the object + cascade the 3 derivatives.
 *
 * Scope is tightened to exactly the product photo + video subfolders via
 * {@link parseProductMediaDir}; derivatives (cascade-managed) and generic
 * `media/` files are never candidates. Each candidate's owning produto is read
 * directly (see {@link resolveReferencedArquivoRefs}) — no full-collection scan.
 *
 * The `resolveReferenced` seam defaults to the owner-document lookup; the
 * emulator suite injects a stub so the scan/scope/delete logic can be exercised
 * in isolation from shared emulator state. The grace window protects an arquivo
 * uploaded mid-produto-creation (referenced only once the produto is saved).
 */
export async function sweepUnreferencedArquivos(
  db: Firestore,
  bucket: Bucket,
  // `bucket` is unused (object cleanup is onArquivoDeleted's job) but kept for
  // signature parity with sweepPhantomDocs and the reconcile call site.
  resolveReferenced: ResolveReferenced = (ids) => resolveReferencedArquivoRefs(db, ids),
): Promise<number> {
  const cutoff = nowMicros() - orphanGraceMicros();
  // Candidate scan: product media past the grace window. Single-field range →
  // automatic index, no composite. Coverage caveat: this always reads the OLDEST
  // docs, so a stable head of long-lived referenced photos can starve newer
  // orphans — a persisted round-robin cursor is the planned fix (issue #234).
  const candidates = await arquivoCollection
    .ref(db, {})
    .where('criadoEm', '<', cutoff)
    .limit(BATCH_LIMIT)
    .get();

  // Keep only product photos + videos (skip derivatives / generic media) and map
  // each to its owning produtoId, so we read just those produtos — not all of them.
  type Candidate = { doc: (typeof candidates.docs)[number]; refPath: string };
  const items: Candidate[] = [];
  const produtoIds = new Set<string>();
  for (const doc of candidates.docs) {
    const parsed = parseProductMediaDir(doc.data().filepath as string | null | undefined);
    if (!parsed) continue;
    items.push({ doc, refPath: `${ARQUIVOS_COLLECTION}/${doc.id}` });
    produtoIds.add(parsed.produtoId);
  }

  const referencedRefs = await resolveReferenced([...produtoIds]);

  let deleted = 0;
  let kept = 0;
  let failed = 0;
  for (const { doc, refPath } of items) {
    if (deleted >= BATCH_LIMIT) break;
    try {
      if (referencedRefs.has(refPath)) {
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
  logger.info(
    `sweepUnreferencedArquivos: ${items.length} candidates, ${deleted} deleted, ${kept} kept, ${failed} failed`,
  );
  return deleted;
}

/**
 * Scheduled (every 48h) arquivo orphan reconciliation. Two bounded passes, each
 * isolating per-item failures: the phantom-doc sweep, then the
 * unreferenced-arquivo sweep (which reads only the produtos owning the current
 * candidate batch).
 */
export const reconcileArquivoOrphans = onSchedule(
  { schedule: 'every 48 hours', memory: '512MiB' },
  async () => {
    const db = getDb();
    const bucket = getStorage(getAdminApp()).bucket();
    const phantoms = await sweepPhantomDocs(db, bucket);
    const unreferenced = await sweepUnreferencedArquivos(db, bucket);
    logger.info(
      `reconcileArquivoOrphans: ${phantoms} phantom docs + ${unreferenced} unreferenced arquivos cleaned`,
    );
  },
);
