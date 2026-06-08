'use client';

/**
 * Outer references on legacy Flutter docs come through Firestore in two
 * shapes:
 *   - a real `DocumentReference` (typed by `firebase/firestore`), with
 *     `.path`, `.id`, etc.
 *   - an opaque object literal with a `path` string (Flutter sometimes
 *     serializes refs that way for marketplaces).
 *
 * `dereferenceOuterRef` accepts either shape and returns a typed
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
  return null;
}
