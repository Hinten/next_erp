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
  return rows.filter((row) =>
    entries.every(([field, f]) => matchesFilter((row.data as Record<string, unknown>)[field], f)),
  );
}

function matchesFilter(value: unknown, f: ColumnFilterValue): boolean {
  switch (f.op) {
    case 'contains': {
      if (value == null) return false;
      // Case- and accent-insensitive substring, like regexContains server-side.
      const re = buildSimilarityRegExp(String(f.value));
      return re ? re.test(String(value)) : true;
    }
    case 'startsWith':
      return value != null && String(value).startsWith(String(f.value));
    case 'eq':
      // eq null matches missing/null; otherwise strict equality.
      return f.value === null ? value == null : value === f.value;
    case 'lt':
      return value != null && Number(value) < Number(f.value);
    case 'lte':
      return value != null && Number(value) <= Number(f.value);
    case 'gt':
      return value != null && Number(value) > Number(f.value);
    case 'gte':
      return value != null && Number(value) >= Number(f.value);
    default:
      return true;
  }
}
