import { z } from 'zod';

/**
 * Document-reference fields (`*OuterRef` / `*OuterReference`) are stored as
 * doc-path **strings**, never native Firestore `reference` values — the format
 * the legacy Flutter app reads and writes. A string is SDK-agnostic (Admin,
 * Client and Flutter `DocumentReference` are three different classes),
 * JSON-serializable, and keeps a single Firestore type per field so indexes,
 * exports and structural equality stay consistent. No `*OuterRef` is ever used
 * in a Firestore `where()` — every consumer dereferences app-side — so a native
 * reference buys nothing and only fragments the data.
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
