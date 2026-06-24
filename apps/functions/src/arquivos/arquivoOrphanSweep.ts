import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';
import { getStorage } from 'firebase-admin/storage';
// Pipeline expression builders live in the `/pipelines` subpath (admin
// `@google-cloud/firestore` v8). Namespace import — the module is `export =`d.
import * as pipelines from '@google-cloud/firestore/pipelines';
import { logger } from 'firebase-functions';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { arquivoCollection, produtoCollection } from '@delfrance/data/admin/collections';
import { ARQUIVOS_COLLECTION, nowMicros, parseProductMediaDir } from '@delfrance/schemas';

import { getAdminApp, getDb } from '../lib/admin';

type Bucket = ReturnType<Storage['bucket']>;

// Bound each pass so neither can blow the function budget; the every-48h schedule
// drains a backlog over several runs.
const BATCH_LIMIT = 100;

// Matches an `Arquivo.filepath` (a DIRECTORY, no filename) for a product photo or
// video: `produtos/<produtoId>/originals` or `.../videos`. Excludes derivatives
// (cascade-managed) and generic `media/`. Anchored → effectively a full match.
const PRODUCT_MEDIA_DIR_REGEX = '^produtos/[^/]+/(originals|videos)$';

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
 * Grace window in **microseconds** for a MARKED arquivo (`markedForDeletionAt`,
 * set by `onProdutoMediaChanged`). The mark is a deliberate signal — the trigger
 * saw the ref removed in a produto save — so this is **short** by default (1h, a
 * brief buffer for a quick undo/re-add) versus the 48h orphan grace. Read per
 * call so the emulator suite can drop it to 0. `ARQUIVO_MARKED_GRACE_HOURS`
 * overrides; non-numeric/negative falls back to 1h.
 */
function markedGraceMicros(): number {
  const raw = Number(process.env.ARQUIVO_MARKED_GRACE_HOURS ?? '1');
  const hours = Number.isFinite(raw) && raw >= 0 ? raw : 1;
  return hours * 3_600_000 * 1000;
}

/**
 * Phantom-doc sweep: an `arquivos` doc stuck `uploadState: 'pending'` past the
 * grace window whose Storage object never arrived — a create-first upload the
 * client abandoned. Deletes the doc. If the object IS present (the trigger
 * missed/lagged the finalize), self-heals the marker to `'finalized'` instead.
 *
 * The pending + grace + oldest-first selection is all in the QUERY (equality +
 * range + orderBy), so it needs the composite index `arquivos(uploadState ASC,
 * criadoEm ASC)` — this Firestore Enterprise edition creates no index
 * automatically. Exported for the emulator suite.
 */
export async function sweepPhantomDocs(db: Firestore, bucket: Bucket): Promise<number> {
  const cutoff = nowMicros() - orphanGraceMicros();
  const pending = await arquivoCollection
    .ref(db, {})
    .where('uploadState', '==', 'pending')
    .where('criadoEm', '<', cutoff)
    .orderBy('criadoEm', 'asc')
    .limit(BATCH_LIMIT)
    .get();

  let deleted = 0;
  let healed = 0;
  let kept = 0;
  let failed = 0;
  for (const doc of pending.docs) {
    try {
      const data = doc.data();
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
 * Plain admin SDK reads (no pipeline), so this is fully emulator-testable.
 */
export async function resolveReferencedArquivoRefs(
  db: Firestore,
  produtoIds: string[],
): Promise<Set<string>> {
  const refs = new Set<string>();
  // De-dup — this is exported/public and callers may pass repeats; one getAll per
  // DISTINCT produto (avoids redundant reads + keeps the getAll arg list bounded).
  const uniqueIds = [...new Set(produtoIds)];
  if (uniqueIds.length === 0) return refs;

  // produtoCollection.docRef returns a RAW ref (no converter — see
  // defineAdminCollection), so the field-masked partial read below is safe; the
  // handle just sources the 'produtos' path from schemas.
  const docRefs = uniqueIds.map((id) => produtoCollection.docRef(db, {}, id));
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

/** A product photo/video arquivo old enough to sweep, with its deletable ref. */
interface UnreferencedCandidate {
  ref: DocumentReference;
  id: string;
  filepath: string | null;
}

/** Fetches the candidate batch (oldest product photos/videos past the grace window). */
type FetchCandidates = (db: Firestore, cutoffMicros: number) => Promise<UnreferencedCandidate[]>;

/** Resolves the `arquivos/<id>` refs a set of produtos currently uses. */
type ResolveReferenced = (produtoIds: string[]) => Promise<ReadonlySet<string>>;

/**
 * Default candidate fetch: an admin **pipeline** that scopes server-side to
 * product photos + videos (regex on `filepath`) past the grace window, oldest
 * first. The regex filter (and `regexContains`) is a pipeline-only primitive, so
 * this is **not** emulator-runnable — it is validated live and {@link
 * sweepUnreferencedArquivos} takes it as a seam the emulator test overrides. The
 * `criadoEm` range + sort needs the `arquivos(criadoEm ASC)` index.
 */
async function fetchUnreferencedCandidates(
  db: Firestore,
  cutoffMicros: number,
): Promise<UnreferencedCandidate[]> {
  const snap = await db
    .pipeline()
    .collection(ARQUIVOS_COLLECTION)
    .where(
      pipelines.and(
        pipelines.lessThan(pipelines.field('criadoEm'), cutoffMicros),
        pipelines.regexContains('filepath', PRODUCT_MEDIA_DIR_REGEX),
      ),
    )
    .sort(pipelines.ascending(pipelines.field('criadoEm')))
    .limit(BATCH_LIMIT)
    .execute();

  const out: UnreferencedCandidate[] = [];
  for (const row of snap.results) {
    if (!row.ref) continue; // no `select` → ref is present; guard the optional type
    const filepath = (row.data() as { filepath?: unknown } | undefined)?.filepath;
    out.push({
      ref: row.ref,
      id: row.ref.id,
      filepath: typeof filepath === 'string' ? filepath : null,
    });
  }
  return out;
}

/**
 * Unreferenced-arquivo sweep: delete product photos / videos older than the
 * grace window that **no produto references** — e.g. a photo removed from a
 * produto in an edit (the `fotos[]` entry goes away but nothing deletes the
 * arquivo doc), or a produto deleted entirely. Deleting the doc lets
 * `onArquivoDeleted` free the object + cascade the 3 derivatives.
 *
 * Candidates come from {@link fetchUnreferencedCandidates} (a regex pipeline,
 * server-side scoped to `produtos/<id>/originals|videos`); each owning produto is
 * read directly (see {@link resolveReferencedArquivoRefs}) — no full-collection
 * scan. Both seams (`fetchCandidates`, `resolveReferenced`) default to the real
 * implementations and are overridden by the emulator suite, which can't run the
 * pipeline. The grace window protects an arquivo uploaded mid-produto-creation
 * (referenced only once the produto is saved).
 */
export async function sweepUnreferencedArquivos(
  db: Firestore,
  bucket: Bucket,
  // `bucket` is unused (object cleanup is onArquivoDeleted's job) but kept for
  // signature parity with sweepPhantomDocs and the reconcile call site.
  fetchCandidates: FetchCandidates = fetchUnreferencedCandidates,
  resolveReferenced: ResolveReferenced = (ids) => resolveReferencedArquivoRefs(db, ids),
): Promise<number> {
  const cutoff = nowMicros() - orphanGraceMicros();
  const candidates = await fetchCandidates(db, cutoff);

  // Derive each candidate's owner produtoId from its filepath (already scoped to
  // originals|videos by the fetch); collect distinct ids for one batched lookup.
  const items: { ref: DocumentReference; refPath: string }[] = [];
  const produtoIds = new Set<string>();
  for (const c of candidates) {
    const parsed = parseProductMediaDir(c.filepath);
    if (!parsed) continue; // defensive — the fetch already scopes to product media
    items.push({ ref: c.ref, refPath: `${ARQUIVOS_COLLECTION}/${c.id}` });
    produtoIds.add(parsed.produtoId);
  }

  const referencedRefs = await resolveReferenced([...produtoIds]);

  let deleted = 0;
  let kept = 0;
  let failed = 0;
  for (const { ref, refPath } of items) {
    if (deleted >= BATCH_LIMIT) break;
    try {
      if (referencedRefs.has(refPath)) {
        kept += 1;
        continue;
      }
      // Unreferenced + past grace → delete the doc; onArquivoDeleted frees the
      // object and cascades derivatives.
      await ref.delete();
      deleted += 1;
    } catch (err) {
      failed += 1;
      logger.error(`sweepUnreferencedArquivos: ${ref.id} failed`, err);
    }
  }
  logger.info(
    `sweepUnreferencedArquivos: ${candidates.length} candidates, ${deleted} deleted, ${kept} kept, ${failed} failed`,
  );
  return deleted;
}

/**
 * Marked-for-deletion sweep: delete `arquivos` docs `onProdutoMediaChanged`
 * stamped with `markedForDeletionAt` (a photo/video removed from a produto in an
 * edit) once they're past the short marked-grace window — but **re-verifying**
 * the owning produto still doesn't reference the arquivo first (defence against a
 * missed unmark when the photo was re-added). Deleting the doc lets
 * `onArquivoDeleted` free the object + cascade the 3 derivatives; a still-
 * referenced doc has its mark cleared instead.
 *
 * This is the **eager** cleanup path's back half — the trigger captures the
 * removal cheaply at edit time, so this sweep is a plain admin range query
 * (`where markedForDeletionAt < cutoff orderBy markedForDeletionAt asc`, **no**
 * pipeline → emulator-runnable) over the single-field index
 * `arquivos(markedForDeletionAt ASC)`. Unmarked docs (`null`) are excluded by the
 * range predicate. The owner re-check reuses {@link resolveReferencedArquivoRefs}
 * (one batched `getAll`). Bounded by `BATCH_LIMIT`; isolates per-doc failures.
 */
export async function sweepMarkedForDeletion(db: Firestore): Promise<number> {
  const cutoff = nowMicros() - markedGraceMicros();
  const marked = await arquivoCollection
    .ref(db, {})
    .where('markedForDeletionAt', '<', cutoff)
    .orderBy('markedForDeletionAt', 'asc')
    .limit(BATCH_LIMIT)
    .get();

  if (marked.empty) {
    logger.info('sweepMarkedForDeletion: 0 candidates');
    return 0;
  }

  // Re-verify against the owning produtos in one batched lookup: derive each
  // candidate's produtoId from its filepath, resolve the refs those produtos
  // still hold, then delete only the genuinely-unreferenced ones.
  const items: { ref: DocumentReference; refPath: string; produtoId: string | null }[] = [];
  const produtoIds = new Set<string>();
  for (const doc of marked.docs) {
    const filepath = (doc.data().filepath as string | null | undefined) ?? null;
    const produtoId = parseProductMediaDir(filepath)?.produtoId ?? null;
    if (produtoId) produtoIds.add(produtoId);
    items.push({ ref: doc.ref, refPath: `${ARQUIVOS_COLLECTION}/${doc.id}`, produtoId });
  }

  const referencedRefs = await resolveReferencedArquivoRefs(db, [...produtoIds]);

  let deleted = 0;
  let cleared = 0;
  let failed = 0;
  for (const { ref, refPath, produtoId } of items) {
    try {
      // Referenced again (a re-add whose unmark was missed) → clear + keep.
      if (produtoId && referencedRefs.has(refPath)) {
        await ref.update({ markedForDeletionAt: null });
        cleared += 1;
        continue;
      }
      await ref.delete();
      deleted += 1;
    } catch (err) {
      failed += 1;
      logger.error(`sweepMarkedForDeletion: ${ref.id} failed`, err);
    }
  }
  logger.info(
    `sweepMarkedForDeletion: ${marked.size} candidates, ${deleted} deleted, ${cleared} cleared, ${failed} failed`,
  );
  return deleted;
}

/**
 * Scheduled (every 48h) arquivo orphan reconciliation. Three bounded passes, each
 * isolating per-item failures: the **marked** sweep first (cheapest — an indexed
 * query over what `onProdutoMediaChanged` already flagged), then the phantom-doc
 * sweep, then the unreferenced-arquivo backstop (which reads only the produtos
 * owning the current candidate batch).
 */
export const reconcileArquivoOrphans = onSchedule(
  { schedule: 'every 48 hours', memory: '512MiB' },
  async () => {
    const db = getDb();
    const bucket = getStorage(getAdminApp()).bucket();
    const marked = await sweepMarkedForDeletion(db);
    const phantoms = await sweepPhantomDocs(db, bucket);
    const unreferenced = await sweepUnreferencedArquivos(db, bucket);
    logger.info(
      `reconcileArquivoOrphans: ${marked} marked + ${phantoms} phantom docs + ${unreferenced} unreferenced arquivos cleaned`,
    );
  },
);
