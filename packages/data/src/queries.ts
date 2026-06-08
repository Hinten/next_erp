import {
  type DocumentSnapshot,
  type FirestoreDataConverter,
  type Firestore,
  type Query,
  type QueryConstraint,
  type WhereFilterOp,
  collectionGroup as fsCollectionGroup,
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
 * Heads up: collection group queries usually require composite indexes;
 * Firestore prompts you with a one-click link the first time you run an
 * unindexed query. Permission rules for collection group reads must be
 * declared with `match /{path=**}/<id>` in firestore.rules.
 */
export function groupQuery<T>(
  db: Firestore,
  groupId: string,
  converter: FirestoreDataConverter<T>,
): Query<T> {
  return fsCollectionGroup(db, groupId).withConverter(converter);
}
