import {
  type DocumentSnapshot,
  type FirestoreDataConverter,
  type Firestore,
  type Query,
  type QueryConstraint,
  type WhereFilterOp,
  collectionGroup as fsCollectionGroup,
  documentId,
  endBefore,
  limit as fsLimit,
  orderBy as fsOrderBy,
  query,
  startAfter,
  where,
} from 'firebase/firestore';

/**
 * Tiny composable query helpers. Wraps the Firestore SDK so app code reads
 * declaratively (`whereEqual('cpf_cnpj', '...')`) instead of mixing SDK
 * imports everywhere. No magic — these just return `QueryConstraint`.
 */

export function whereEqual<T extends string>(field: T, value: unknown): QueryConstraint {
  return where(field, '==', value);
}

export function whereOp(field: string, op: WhereFilterOp, value: unknown): QueryConstraint {
  return where(field, op, value);
}

/**
 * Membership test on an array field (`array-contains`). Typical use:
 * denormalized id arrays such as `produto.componentesKitKeys`, where
 * "which kits include component X" becomes
 * `whereArrayContains('componentesKitKeys', x)`.
 */
export function whereArrayContains(field: string, value: unknown): QueryConstraint {
  return where(field, 'array-contains', value);
}

/**
 * Membership test on the document id: `where(documentId(), 'in', ids)`. The
 * Firebase JS SDK v12 caps an `in` filter at **30** values, so a caller whose
 * id list may exceed that must chunk (see `getDocsByIds` in apps/web). Keeping
 * the raw `documentId()` import fenced inside `@delfrance/data` lets app code
 * compose bulk-by-id fetches without importing `firebase/firestore` field paths.
 */
export function whereDocIdIn(ids: ReadonlyArray<string>): QueryConstraint {
  // Fail fast at the helper boundary: Firestore requires a non-empty `in` array
  // and caps it at 30. Without this, misuse surfaces later as an opaque SDK
  // error. Callers with a larger/uncertain list must chunk (see getDocsByIds).
  if (ids.length === 0 || ids.length > 30) {
    throw new RangeError(
      `whereDocIdIn: expected 1–30 ids (Firestore 'in' filter cap), got ${ids.length}; ` +
        `chunk larger lists (see getDocsByIds).`,
    );
  }
  return where(documentId(), 'in', ids);
}

export function orderByField(field: string, direction: 'asc' | 'desc' = 'asc'): QueryConstraint {
  return fsOrderBy(field, direction);
}

export function limit(n: number): QueryConstraint {
  return fsLimit(n);
}

/**
 * Cursor pagination. Pass the last document of the previous page as `after`
 * to fetch the next page. To page backwards, pass `before` — the caller
 * remains responsible for tracking page state.
 */
export function paginate(input: {
  after?: DocumentSnapshot;
  before?: DocumentSnapshot;
  pageSize: number;
}): QueryConstraint[] {
  const out: QueryConstraint[] = [fsLimit(input.pageSize)];
  if (input.after) out.push(startAfter(input.after));
  if (input.before) out.push(endBefore(input.before));
  return out;
}

/**
 * Convenience: build a query from a base ref + composable constraints.
 * Each constraint must be created via the helpers above so the call site
 * stays free of `firebase/firestore` imports.
 */
export function buildQuery<T>(base: Query<T>, constraints: QueryConstraint[]): Query<T> {
  if (constraints.length === 0) return base;
  return query(base, ...constraints);
}

/**
 * Wraps `collectionGroup` to query across every subcollection with the
 * given name. The resulting `Query<T>` is typed by the supplied converter
 * (typically the one a `defineCollection` already created).
 *
 * Heads up: this project's Firestore is **Enterprise edition** — an unindexed
 * collection group query does NOT throw; it falls back to a full collection
 * scan (no `FAILED_PRECONDITION`, no one-click index prompt). Declare a
 * composite index in `firestore.indexes.json` only to bound cost/latency on a
 * hot query (see CLAUDE.md "Key fixed decisions"). Permission rules for
 * collection group reads must be declared with `match /{path=**}/<id>` in
 * firestore.rules.
 */
export function groupQuery<T>(
  db: Firestore,
  groupId: string,
  converter: FirestoreDataConverter<T>,
): Query<T> {
  return fsCollectionGroup(db, groupId).withConverter(converter);
}
