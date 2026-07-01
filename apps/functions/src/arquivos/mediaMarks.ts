import type { Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { ARQUIVOS_COLLECTION, nowMicros, parseOwnedMediaDir } from '@delfrance/schemas';

// Shared eager media-mark logic for the owner-scoped media triggers
// (`onProdutoMediaChanged`, `onTabMediMediaChanged`). It only ever touches
// `arquivos` docs by RAW ref + a partial `markedForDeletionAt` update (the admin
// collection's full-schema parse would reject a one-field merge), so plain
// `db.collection()`/`getAll()`/`batch.update()` is correct here — no
// schema-validated handle. See onArquivoDeleted for the same raw-ref rationale.

/**
 * The embedded media arrays whose `arquivoOuterRef`s this logic reaps eagerly.
 * `fotos` + `videos` + `anexos` — every owner-scoped media array the
 * unreferenced sweep also governs. An owner with only some of them (e.g. a
 * tabela de medidas has just `fotos`) simply contributes empty diffs for the
 * absent fields.
 */
const MEDIA_FIELDS = ['fotos', 'videos', 'anexos'] as const;

/**
 * Collect the set of `arquivos/<id>` refs an owner's `fotos` + `videos` +
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
 * Diff an owner's media refs (a produto OR a tabela de medidas) before/after a
 * write and (un)mark the affected `arquivos` docs:
 *   - a ref present in `before` but not `after` (photo removed, or the whole
 *     owner deleted → `after` empty) → stamp `markedForDeletionAt = now`;
 *   - a ref present in `after` but not `before` (added / re-added) → clear it
 *     (`markedForDeletionAt = null`) so a re-added photo is never reaped.
 *
 * The mark is only a SIGNAL — `sweepMarkedForDeletion` does the actual delete
 * after a grace window, re-verifying the owner still doesn't reference the
 * arquivo. So a buggy/partial/bulk save that drops `fotos` can't destroy photos
 * here; it can only mark them (reversible).
 *
 * Reads the affected docs in one batched `getAll` and writes in one `WriteBatch`,
 * touching ONLY existing `arquivos` docs (a ref whose doc was already swept is a
 * no-op — no NOT_FOUND, no resurrected phantom). Writes never touch the owner
 * collection, so the trigger can't re-fire itself. Exported so the emulator
 * suite can drive it directly without depending on Firestore-trigger delivery.
 */
export async function reconcileMediaMarks(
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
    // Only ever (un)mark a genuine owner-media arquivo (produtos/<id>/… or
    // tabMedi/<id>/…). `arquivoOuterRef` is just a non-empty string in the
    // schemas, so a `fotos` entry could point at a non-owned doc (legacy /
    // console / bad data) the marked sweep can't owner-verify — never mark what
    // it couldn't safely delete.
    if (!parseOwnedMediaDir(data.filepath as string | null | undefined)) return;
    const desiredValue = targets[i]!.value;
    const current = (data.markedForDeletionAt ?? null) as number | null;
    if (desiredValue === null) {
      if (current === null) return; // already unmarked → skip the no-op write
      batch.update(snap.ref, { markedForDeletionAt: null });
      unmarked += 1;
    } else {
      if (current !== null) return; // already marked → don't reset the grace clock
      batch.update(snap.ref, { markedForDeletionAt: desiredValue });
      marked += 1;
    }
  });
  if (marked + unmarked > 0) await batch.commit();

  logger.info(
    `reconcileMediaMarks: ${marked} marked, ${unmarked} unmarked ` +
      `(removed ${removed.length}, added ${added.length})`,
  );
  return { marked, unmarked };
}
