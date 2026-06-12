'use client';

/**
 * Outer references on legacy Flutter docs come through Firestore in three
 * shapes:
 *   - a real `DocumentReference` (typed by `firebase/firestore`), with
 *     `.path`, `.id`, etc.
 *   - an opaque object literal with a `path` string (Flutter sometimes
 *     serializes refs that way for marketplaces).
 *   - a plain doc-path **string**, usually with the Flutter-ODM
 *     `documents/` prefix (`OuterRefField.toJson()` writes
 *     `documents/<collection>/<id>` — e.g. `int_frete` refs).
 *
 * `dereferenceOuterRef` accepts any of these and returns a typed
 * `DocumentReference` safe to pass into `useDocSnapshot` or `getDoc`.
 * Returns `null` when the ref is absent or unrecognized.
 */
// `doc(db, arbitraryPath)` is the one legitimate raw-ref site: it dereferences
// a legacy "outer ref" whose collection (and schema) is unknown, so it can't
// route through a defineCollection handle.
// eslint-disable-next-line no-restricted-imports -- intentional generic deref (see above)
import { doc, type DocumentReference, type Firestore } from 'firebase/firestore';

interface OpaqueRef {
  readonly path: string;
}

function looksLikeOpaqueRef(value: unknown): value is OpaqueRef {
  return (
    value !== null &&
    typeof value === 'object' &&
    'path' in value &&
    typeof (value as { path: unknown }).path === 'string' &&
    (value as { path: string }).path.length > 0
  );
}

function looksLikeDocumentReference(value: unknown): value is DocumentReference {
  return (
    value !== null &&
    typeof value === 'object' &&
    'path' in value &&
    'id' in value &&
    'firestore' in value
  );
}

export function dereferenceOuterRef(db: Firestore, outerRef: unknown): DocumentReference | null {
  if (outerRef == null) return null;
  if (looksLikeDocumentReference(outerRef)) {
    return outerRef;
  }
  if (looksLikeOpaqueRef(outerRef)) {
    return doc(db, outerRef.path);
  }
  if (typeof outerRef === 'string') {
    // Strip the Flutter-ODM `documents/` prefix; a doc path needs an even
    // segment count ≥ 2 or `doc()` throws.
    const segs = outerRef.split('/').filter(Boolean);
    if (segs[0] === 'documents') segs.shift();
    if (segs.length >= 2 && segs.length % 2 === 0) {
      return doc(db, segs.join('/'));
    }
    return null;
  }
  return null;
}
