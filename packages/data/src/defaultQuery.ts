import type { QueryConstraint } from 'firebase/firestore';
import type { CollectionDefaultQuery, DefaultQueryValue } from '@delfrance/schemas';
import { limit as fsLimit, orderByField, whereEqual } from './queries';

export interface DefaultQueryOptions {
  /**
   * Values for `where` entries declared `param: true`. Throws if a declared
   * param has no binding — an unbound runtime filter is a programming error,
   * not something to silently drop (it would widen the query to the whole
   * collection).
   */
  params?: Record<string, DefaultQueryValue>;
  /**
   * Extra constraints inserted between the default `orderBy` and the `limit`.
   * Use for query-specific additions a page layers on top of the declared
   * default — e.g. the produtos prefix-search range on `nome`.
   */
  extraConstraints?: QueryConstraint[];
}

/**
 * Turn a collection's declared {@link CollectionDefaultQuery} into the ordered
 * list of Firestore `QueryConstraint`s. Combine with `buildQuery(ref, …)`:
 *
 * ```ts
 * buildQuery(produtoCollection.ref(db, {}), defaultQueryConstraints(produtoMeta.defaultQuery!))
 * ```
 *
 * Constraint order is `where… → orderBy… → ...extraConstraints → limit`, the
 * same order the `TableView` pipeline path uses, so both data sources issue
 * the query the declared Firestore index was built for.
 */
export function defaultQueryConstraints(
  dq: CollectionDefaultQuery,
  opts: DefaultQueryOptions = {},
): QueryConstraint[] {
  const { params, extraConstraints = [] } = opts;
  const constraints: QueryConstraint[] = [];

  for (const w of dq.where ?? []) {
    const value = 'param' in w ? bindParam(w.field, params) : w.value;
    constraints.push(whereEqual(w.field, value));
  }
  for (const o of dq.orderBy) {
    constraints.push(orderByField(o.field, o.direction));
  }
  constraints.push(...extraConstraints);
  constraints.push(fsLimit(dq.limit));
  return constraints;
}

function bindParam(
  field: string,
  params: Record<string, DefaultQueryValue> | undefined,
): DefaultQueryValue {
  if (!params || !(field in params)) {
    throw new Error(
      `defaultQueryConstraints: missing runtime value for param "${field}". ` +
        `Pass it via the \`params\` option (TableView's \`queryParams\` prop).`,
    );
  }
  return params[field] ?? null;
}
