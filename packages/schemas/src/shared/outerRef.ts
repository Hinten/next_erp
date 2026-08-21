import { z } from 'zod';

/**
 * Document-reference fields (`*OuterRef` / `*OuterReference`) are stored as
 * doc-path **strings**, never native Firestore `reference` values — the format
 * the migrated corpus carries, so both wire encodings below must be tolerated
 * on read. A string is SDK-agnostic (Admin, Client and Flutter
 * `DocumentReference` are three different classes), JSON-serializable, and
 * keeps a single Firestore type per field so indexes, exports and structural
 * equality stay consistent. Most consumers dereference
 * app-side rather than filtering in a `where()`. Equality on the string is
 * valid when needed (e.g. `categoriaPaiOuterRef` for the categorias cascade
 * in #554) — declare a matching index; Enterprise full-scans otherwise. A
 * native Firestore `reference` still buys nothing and only fragments the data.
 *
 * Two wire formats exist, both string:
 *  - `documents/<col>/<id>` — Flutter `OuterRefField.toJson` / `pathWithDocuments`
 *    (the common case, subcollection paths included) → {@link outerRefSchema}.
 *  - bare `<col>/<id>` — `pathNoDocuments` (imposto + arquivo refs) →
 *    {@link idRefSchema}.
 *
 * These schemas validate only; they never `.transform()` — collection schemas
 * feed `defineCollection` / `rules-gen`, which can't carry transforms.
 * Normalization between formats is the helpers' job ({@link toOuterRef}).
 */

/**
 * Canonical ref: `documents/<col>/<id>`. Requires an even number of segments
 * (collection/doc pairs, subcollections allowed) so a value that passes
 * validation is always a dereferenceable document path — `documents/col/id`,
 * `documents/col/id/sub/subid`, but never `documents/col/id/sub` (ends on a
 * collection, which `doc()` rejects).
 */
export const outerRefSchema = z.string().regex(/^documents(\/[^/]+\/[^/]+)+$/);
export type OuterRef = z.infer<typeof outerRefSchema>;

/**
 * Bare `<col>/<id>` (Flutter `pathNoDocuments`). The negative lookahead excludes
 * a `documents/` prefix in the regex itself — no top-level `.refine`, so objects
 * embedding this field stay `.pick()`-able under Zod 4.
 */
export const idRefSchema = z.string().regex(/^(?!documents\/)[^/]+\/[^/]+$/);
export type IdRef = z.infer<typeof idRefSchema>;

/** A bare Firestore document id — no collection, no slashes. */
export const docIdSchema = z.string().regex(/^[^/]+$/);
export type DocId = z.infer<typeof docIdSchema>;

/**
 * LAST RESORT — any non-empty path with at least one slash, tolerating both
 * formats. Not applied to any field today; reads are already tolerant via
 * `parseSoftRead` (logs, never throws). Reach for this only on a genuinely
 * mixed-format field that can't be migrated.
 */
export const outerRefLooseSchema = z
  .string()
  .min(1)
  .refine((s) => s.includes('/'), {
    message: 'outerRef must be a path containing at least one slash',
  });
export type OuterRefLoose = z.infer<typeof outerRefLooseSchema>;

function segments(raw: string): string[] {
  const segs = raw.split('/').filter(Boolean);
  if (segs[0] === 'documents') segs.shift();
  return segs;
}

/**
 * Normalize any accepted ref form to canonical `documents/<col>/<id>`. Throws if
 * `raw` can't form a valid (even-segment) document path — so the `OuterRef`
 * return is always a value `outerRefSchema` accepts.
 */
export function toOuterRef(raw: string): OuterRef {
  return outerRefSchema.parse(`documents/${segments(raw).join('/')}`);
}

/**
 * Non-throwing {@link toOuterRef}, widened to `unknown`: returns the canonical
 * `documents/<col>/<id>`, or `null` when `raw` is not a string or cannot form a
 * valid (even-segment) document path.
 *
 * Reach for this whenever the input is UNTRUSTED — a raw Firestore snapshot
 * field, a legacy doc written by the Flutter app, a webhook payload — and a
 * malformed value must degrade to "ref not resolvable" instead of aborting the
 * caller. A Cloud Function trigger is the canonical case: `toOuterRef`'s throw
 * there rides the Eventarc retry forever on a permanently bad doc.
 */
export function toOuterRefOrNull(raw: unknown): OuterRef | null {
  if (typeof raw !== 'string') return null;
  const parsed = outerRefSchema.safeParse(`documents/${segments(raw).join('/')}`);
  return parsed.success ? parsed.data : null;
}

/** The document id (last path segment) of any ref form. */
export function idFromRef(raw: string): string {
  const segs = segments(raw);
  return segs[segs.length - 1] ?? '';
}

/** The collection (segment before the id) and id of any ref form. */
export function parseRef(raw: string): { collection: string; id: string } {
  const segs = segments(raw);
  return {
    collection: segs[segs.length - 2] ?? '',
    id: segs[segs.length - 1] ?? '',
  };
}
