'use client';

/**
 * Outer references on legacy Flutter docs come through Firestore in three
 * shapes:
 *   - a real `DocumentReference` (typed by `firebase/firestore`), with
 *     `.path`, `.id`, etc.
 *   - an opaque object literal with a `path` string. Tolerated defensively:
 *     it has NO known writer — Flutter's `OuterRefField` serializes as a
 *     string (`types.dart`), and every TS writer stores a string or null.
 *   - a plain doc-path **string**, usually with the Flutter-ODM
 *     `documents/` prefix (`OuterRefField.toJson()` writes
 *     `documents/<collection>/<id>` — e.g. `int_frete` refs).
 *
 * `dereferenceOuterRef` accepts any of these and returns a typed
 * `DocumentReference` safe to pass into `useDocSnapshot` or `getDoc`.
 * Returns `null` when the ref is absent or unrecognized.
 *
 * ⚠️ TOTAL — it never throws (#1656). A path no document can have (an odd
 * segment count, or nothing left once the `documents/` prefix and empty
 * segments are dropped) is "unrecognized" and answers `null`, on BOTH path
 * branches: the raw `doc()` would throw a `FirebaseError` `invalid-argument`
 * synchronously, and callers dereference during render and inside the
 * `/pedidos` row-batch effect, where that throw blanks the page. The rule is the
 * shared `toOuterRefOrNull` (`@delfrance/schemas`), not a local copy of it.
 */
// `doc(db, arbitraryPath)` is the one legitimate raw-ref site: it dereferences
// a legacy "outer ref" whose collection (and schema) is unknown, so it can't
// route through a defineCollection handle.
// eslint-disable-next-line no-restricted-imports -- intentional generic deref (see above)
import { doc, type DocumentReference, type Firestore } from 'firebase/firestore';
import { toOuterRefOrNull } from '@delfrance/schemas';

const DOCUMENTS_PREFIX = 'documents/';

/** `doc()` over a legacy ref path, or null when it cannot name a document. Never throws (#1656). */
function docOuNull(db: Firestore, path: string): DocumentReference | null {
  const canonical = toOuterRefOrNull(path);
  return canonical == null ? null : doc(db, canonical.slice(DOCUMENTS_PREFIX.length));
}

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
    return docOuNull(db, outerRef.path);
  }
  if (typeof outerRef === 'string') {
    return docOuNull(db, outerRef);
  }
  return null;
}
