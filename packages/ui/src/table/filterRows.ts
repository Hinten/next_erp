import type { SnapshotRow } from '@delfrance/data/hooks';
import { buildSimilarityRegExp } from '@delfrance/data/pipeline-queries';
import type { ColumnFilterValue } from './ColumnFilter';

/**
 * Apply per-column filters to already-fetched rows, matching the Pipeline
 * `filters` semantics (see `filterExpr` in
 * packages/data/src/pipeline-queries.ts). Used on the non-Pipeline row sources
 * — the classic `buildQuery` fallback and `queryOverride` — which can't push
 * column filters to the server, so without this they were silently ignored.
 *
 * Scope note: filtering happens within the already-fetched page window
 * (the query's `limit`), not across the whole collection — same as any
 * client-side narrowing of a paged result.
 */
export function applyColumnFilters<T>(
  rows: SnapshotRow<T>[],
  filters: Record<string, ColumnFilterValue>,
): SnapshotRow<T>[] {
  const entries = Object.entries(filters);
  if (entries.length === 0) return rows;
  // Compile each filter to a value predicate ONCE per pass: a `contains` filter
  // builds a similarity RegExp that depends only on the filter value, not the
  // row, so compiling it per row (over a whole page) is wasted work.
  const predicates = entries.map(([field, f]) => [field, compileFilter(f)] as const);
  return rows.filter((row) =>
    predicates.every(([field, test]) => test(getByPath(row.data, field))),
  );
}

/**
 * Read a (possibly nested) dotted field path off a row — `'freteInicial.estado'`
 * resolves the nested map value, matching the server-side `field('a.b')`
 * semantics. A flat key (no dot) is a plain lookup.
 */
function getByPath(data: unknown, path: string): unknown {
  if (!path.includes('.')) return (data as Record<string, unknown>)?.[path];
  let cur: unknown = data;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Build a value predicate for a single column filter. Mirrors the Pipeline
 * `filterExpr` semantics; any per-value derivation (the `contains` RegExp,
 * numeric coercion of the bound) happens here, once, instead of per row.
 */
function compileFilter(f: ColumnFilterValue): (value: unknown) => boolean {
  switch (f.op) {
    case 'contains': {
      // Case- and accent-insensitive substring, like regexContains server-side.
      const re = buildSimilarityRegExp(String(f.value));
      return (value) => (value == null ? false : re ? re.test(String(value)) : true);
    }
    case 'startsWith': {
      const prefix = String(f.value);
      return (value) => value != null && String(value).startsWith(prefix);
    }
    case 'eq':
      // eq null matches missing/null; otherwise strict equality.
      return (value) => (f.value === null ? value == null : value === f.value);
    case 'lt': {
      const bound = Number(f.value);
      return (value) => value != null && Number(value) < bound;
    }
    case 'lte': {
      const bound = Number(f.value);
      return (value) => value != null && Number(value) <= bound;
    }
    case 'gt': {
      const bound = Number(f.value);
      return (value) => value != null && Number(value) > bound;
    }
    case 'gte': {
      const bound = Number(f.value);
      return (value) => value != null && Number(value) >= bound;
    }
    case 'array-contains':
      // The one array op `ColumnFilterValue` can express: a single scalar
      // candidate. The built-in ColumnFilter UI never emits it, but
      // `buildPipeline` can wire it by hand as an `extraFilter`, and the
      // client-side fallback has to agree with what the server would return.
      return (value) => Array.isArray(value) && value.includes(f.value);
    case 'array-contains-any':
      // `ColumnFilterValue.value` is `string | number | boolean | null`, so the
      // candidate LIST this op needs can never arrive — it would silently
      // degrade to a one-candidate `array-contains` and return the wrong rows.
      // Same posture as `filterExpr` (pipeline-queries.ts): surfacing the error
      // beats quietly querying nonsense.
      throw new Error(
        `filterRows: op "array-contains-any" needs a list of candidates, but ` +
          `ColumnFilterValue.value is a scalar (${typeof f.value}). ` +
          `Use "array-contains" for a single value.`,
      );
    default:
      return () => true;
  }
}
