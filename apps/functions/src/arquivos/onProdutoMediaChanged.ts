import type { Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import {
  ARQUIVOS_COLLECTION,
  nowMicros,
  parseProductMediaDir,
  produtoMeta,
} from '@delfrance/schemas';

import { getDb } from '../lib/admin';

// The trigger only ever touches `arquivos` docs by RAW ref + a partial
// `markedForDeletionAt` update (the admin collection's full-schema parse would
// reject a one-field merge), so plain `db.collection()`/`getAll()`/
// `batch.update()` is correct here — no schema-validated handle. See
// onArquivoDeleted for the same raw-ref rationale.

/**
 * The embedded media arrays whose `arquivoOuterRef`s this trigger reaps eagerly.
 * `fotos` + `videos` + `anexos` — all product-scoped media the unreferenced
 * sweep also governs (`produtos/<id>/originals|videos|anexos`), so a ref dropped
 * from any of them is marked here at edit time and `sweepMarkedForDeletion`
 * deletes it after the short grace (re-verifying ownership first).
 */
const MEDIA_FIELDS = ['fotos', 'videos', 'anexos'] as const;

/**
 * Collect the set of `arquivos/<id>` refs a produto's `fotos` + `videos` +
 * `anexos` arrays point at — each element carries an `arquivoOuterRef` string.
 * Pure (no I/O), tolerant of a missing/`null` array or a malformed element.
 * Mirrors the field walk in `resolveReferencedArquivoRefs`.
 */
export function collectMediaRefs(data: Record<string, unknown> | undefined): Set<string> {
  const refs = new Set<string>();
  if (!data) return refs;
  for (const field of MEDIA_FIELDS) {
    const arr = data[field];
    if (!Array.isArray(arr)) continue;
    for (const el of arr) {
      const ref = (el as { arquivoOuterRef?: unknown } | null)?.arquivoOuterRef;
      if (typeof ref === 'string' && ref) refs.add(ref);
    }
  }
  return refs;
}

/** Members of `a` not in `b`. */
function difference(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const x of a) if (!b.has(x)) out.push(x);
  return out;
}

/** `arquivos/<id>` → `<id>`; `null` when the ref isn't a single-segment arquivos path. */
function arquivoIdOf(ref: string): string | null {
  const prefix = `${ARQUIVOS_COLLECTION}/`;
  if (!ref.startsWith(prefix)) return null;
  const id = ref.slice(prefix.length);
  return id.length > 0 && !id.includes('/') ? id : null;
}

/**
 * Diff a produto's media refs before/after an edit and (un)mark the affected
 * `arquivos` docs:
 *   - a ref present in `before` but not `after` (photo/video removed) → stamp
 *     `markedForDeletionAt = now`;
 *   - a ref present in `after` but not `before` (added / re-added) → clear it
 *     (`markedForDeletionAt = null`) so a re-added photo is never reaped.
 *
 * The mark is only a SIGNAL — `sweepMarkedForDeletion` does the actual delete
 * after a grace window, re-verifying the produto still doesn't reference the
 * arquivo. So a buggy/partial/bulk save that drops `fotos` can't destroy photos
 * here; it can only mark them (reversible).
 *
 * Reads the affected docs in one batched `getAll` and writes in one `WriteBatch`,
 * touching ONLY existing `arquivos` docs (a ref whose doc was already swept is a
 * no-op — no NOT_FOUND, no resurrected phantom). Writes never touch `produtos`,
 * so the trigger can't re-fire itself. Exported so the emulator suite can drive
 * it directly without depending on Firestore-trigger delivery.
 */
export async function reconcileProdutoMediaMarks(
  db: Firestore,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): Promise<{ marked: number; unmarked: number }> {
  const beforeRefs = collectMediaRefs(before);
  const afterRefs = collectMediaRefs(after);
  const removed = difference(beforeRefs, afterRefs);
  const added = difference(afterRefs, beforeRefs);
  if (removed.length === 0 && added.length === 0) return { marked: 0, unmarked: 0 };

  // Desired marker per ref. `removed` → now; `added` → null. The two sets are
  // disjoint by construction, so order doesn't matter, but clearing a re-added
  // ref must always win — hence `added` is applied last.
  const markAt = nowMicros();
  const desired = new Map<string, number | null>();
  for (const ref of removed) desired.set(ref, markAt);
  for (const ref of added) desired.set(ref, null);

  // Resolve ref strings → arquivos doc ids, dropping anything that isn't one.
  const targets: { id: string; value: number | null }[] = [];
  for (const [ref, value] of desired) {
    const id = arquivoIdOf(ref);
    if (id) targets.push({ id, value });
  }
  if (targets.length === 0) return { marked: 0, unmarked: 0 };

  const docRefs = targets.map((t) => db.collection(ARQUIVOS_COLLECTION).doc(t.id));
  const snaps = await db.getAll(...docRefs);

  const batch = db.batch();
  let marked = 0;
  let unmarked = 0;
  snaps.forEach((snap, i) => {
    if (!snap.exists) return; // already swept / never created → nothing to mark
    const data = snap.data() ?? {};
    // Only ever (un)mark a genuine product-media arquivo. `arquivoOuterRef` is just a
    // non-empty string in the Produto schema, so a `fotos`/`videos` entry could point
    // at a non-product doc (legacy / console / bad data) the marked sweep can't
    // owner-verify — never mark what it couldn't safely delete.
    if (!parseProductMediaDir(data.filepath as string | null | undefined)) return;
    const desired = targets[i]!.value;
    const current = (data.markedForDeletionAt ?? null) as number | null;
    if (desired === null) {
      if (current === null) return; // already unmarked → skip the no-op write
      batch.update(snap.ref, { markedForDeletionAt: null });
      unmarked += 1;
    } else {
      if (current !== null) return; // already marked → don't reset the grace clock
      batch.update(snap.ref, { markedForDeletionAt: desired });
      marked += 1;
    }
  });
  if (marked + unmarked > 0) await batch.commit();

  logger.info(
    `onProdutoMediaChanged: ${marked} marked, ${unmarked} unmarked ` +
      `(removed ${removed.length}, added ${added.length})`,
  );
  return { marked, unmarked };
}

/**
 * On a `produtos/{id}` update, eagerly reap arquivos a photo/video edit removed:
 * thin wrapper over {@link reconcileProdutoMediaMarks}. The complement to the
 * scheduled `sweepUnreferencedArquivos` — it captures the removal at edit time
 * (the event already carries before/after) instead of rediscovering it later via
 * the regex pipeline + owner lookup; that sweep stays as the backstop for produto
 * DELETES (until #136), manual console edits and missed trigger deliveries.
 *
 * Targets the repo's NAMED `default` Firestore database (see getDb / gotcha #8);
 * an `onDocument*` that omits `database` binds to `(default)` and never fires.
 */
export const onProdutoMediaChanged = onDocumentUpdated(
  {
    document: `${produtoMeta.collectionPath}/{produtoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after) return;
    await reconcileProdutoMediaMarks(getDb(), before, after);
  },
);
