'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import type { PipelineFilterOp } from '@delfrance/data';
import type { FilterableField } from '../schema/types';
import type { ColumnFilterValue } from './ColumnFilter';

export type SortState = { field: string; direction: 'asc' | 'desc' };

const FILTER_OPS = new Set<PipelineFilterOp>([
  'contains',
  'startsWith',
  'eq',
  'lt',
  'lte',
  'gt',
  'gte',
  // The two array ops a virtual column's `renderFilter` can emit. They were
  // absent here while nothing emitted them, which made a filter using one
  // WRITE to the URL (the sync effect below is op-agnostic) and then be
  // dropped on hydration — a shared link silently reopened unfiltered.
  'array-contains',
  'array-contains-any',
]);

/**
 * Serialize a filter value for the `?<field>=<op>:<value>` query param — the
 * inverse of {@link parseFiltersFromParams}'s value decoding, exported so the
 * round trip can be asserted in one place.
 *
 * `array-contains-any` carries a candidate LIST. Each element is
 * percent-encoded before being joined so a separator inside an id cannot split
 * one candidate into two; every other op stringifies its scalar as before.
 */
export function encodeFilterValue(value: ColumnFilterValue['value']): string {
  return Array.isArray(value)
    ? value.map((v) => encodeURIComponent(String(v))).join(',')
    : String(value);
}

/**
 * Parse `?<field>=<op>:<value>` query params into the `filters` state. The
 * value is coerced by the field's `kind` (boolean / number / string), except
 * for `array-contains-any`, whose comma-separated candidate list is decoded by
 * the op. Params that don't map to a known descriptor, or carry an unknown op,
 * are skipped.
 */
export function parseFiltersFromParams(
  params: URLSearchParams,
  fields: FilterableField[],
): Record<string, ColumnFilterValue> {
  const byKey = new Map(fields.map((d) => [d.key, d]));
  const out: Record<string, ColumnFilterValue> = {};
  for (const [key, raw] of params.entries()) {
    if (key === 'sort') continue;
    const descriptor = byKey.get(key);
    if (!descriptor) continue;
    const sep = raw.indexOf(':');
    if (sep < 0) continue;
    const op = raw.slice(0, sep) as PipelineFilterOp;
    if (!FILTER_OPS.has(op)) continue;
    const rawValue = raw.slice(sep + 1);
    let value: ColumnFilterValue['value'];
    if (op === 'array-contains-any') {
      // A candidate list, not a scalar — so it is decoded by the OP, ahead of
      // the coerce-by-`kind` ladder below (the descriptor's kind describes the
      // document ARRAY, never its elements). An empty list means "no rows",
      // which is not a filter worth restoring: skip it and show everything.
      const list = rawValue
        .split(',')
        .filter((part) => part !== '')
        .map((part) => decodeURIComponent(part));
      if (list.length === 0) continue;
      out[key] = { op, value: list };
      continue;
    }
    if (descriptor.kind === 'boolean') {
      value = rawValue === 'true';
    } else if (
      descriptor.kind === 'number' ||
      descriptor.kind === 'integer' ||
      descriptor.kind === 'currency' ||
      // Numeric-epoch (`datetime`) filters carry their bound as micros/millis.
      // (`date` is an ISO string and non-filterable, so it stays a string.)
      descriptor.kind === 'datetime'
    ) {
      const n = Number(rawValue);
      if (Number.isNaN(n)) continue;
      value = n;
    } else {
      value = rawValue;
    }
    out[key] = { op, value };
  }
  return out;
}

/** Parse `?sort=<field>:<asc|desc>`. */
export function parseSortFromParams(params: URLSearchParams): SortState | undefined {
  const raw = params.get('sort');
  if (!raw) return undefined;
  const sep = raw.indexOf(':');
  if (sep < 0) return undefined;
  const field = raw.slice(0, sep);
  const direction = raw.slice(sep + 1);
  if (!field || (direction !== 'asc' && direction !== 'desc')) return undefined;
  return { field, direction };
}

export interface TableUrlState {
  filters: Record<string, ColumnFilterValue>;
  setFilters: React.Dispatch<React.SetStateAction<Record<string, ColumnFilterValue>>>;
  /** Deterministic serial of `filters` for memo/effect deps. */
  filtersSerial: string;
  sort: SortState | undefined;
  setSort: React.Dispatch<React.SetStateAction<SortState | undefined>>;
}

/**
 * Own the TableView's URL-synced filter + sort state. Hydrated once from the
 * query string (so a shared/bookmarked link reopens filtered & sorted), then
 * mirrored back to the URL via `window.history.replaceState`.
 *
 * Why `replaceState`, NOT `router.replace`: these pages are client-rendered
 * (no Server Component reads the query), so a router navigation needlessly
 * refetches the RSC — and on a statically-prerendered route loaded *with*
 * query params, a search-param-only `router.replace` is silently dropped by
 * the App Router (identical RSC → deduped navigation → the URL never changes).
 * `history.replaceState` always updates the URL, doesn't scroll, and Next
 * keeps `useSearchParams()` in sync. Hydration is one-shot, so no read-back
 * loop.
 *
 * @param fields       filterable fields (schema descriptors + synthetic
 *                     virtual-column filter fields) used to coerce filter values
 * @param initialSort  fallback initial sort (the `orderBy` prop) when the URL
 *                     carries none
 */
export function useTableUrlState(
  fields: FilterableField[],
  initialSort?: { field: string; direction?: 'asc' | 'desc' },
): TableUrlState {
  const searchParams = useSearchParams();
  const pathname = usePathname();

  const [filters, setFilters] = useState<Record<string, ColumnFilterValue>>(() =>
    parseFiltersFromParams(searchParams, fields),
  );
  const [sort, setSort] = useState<SortState | undefined>(
    () =>
      parseSortFromParams(searchParams) ??
      (initialSort
        ? { field: initialSort.field, direction: initialSort.direction ?? 'asc' }
        : undefined),
  );

  // filters changes shape per click; bucket it into a deterministic string so
  // downstream memos only rebuild when content actually changes. Keys are
  // sorted first: `setFilters` rebuilds the object with `{ ...cur }` + `delete`
  // + re-add, which reorders keys without changing content — a plain
  // `JSON.stringify` would then churn the serial (and re-run the URL-sync /
  // requery effects) on a no-op edit.
  const filtersSerial = useMemo(
    () =>
      JSON.stringify(
        Object.keys(filters)
          .sort()
          .map((k) => [k, filters[k]]),
      ),
    [filters],
  );

  useEffect(() => {
    const params = new URLSearchParams();
    for (const [field, v] of Object.entries(filters)) {
      params.set(field, `${v.op}:${encodeFilterValue(v.value)}`);
    }
    if (sort) params.set('sort', `${sort.field}:${sort.direction}`);
    const qs = params.toString();
    // `pathname` is read fresh on every run rather than tracked as a dep: when
    // only the route changes, Next has already set the correct URL.
    const next = qs ? `${pathname}?${qs}` : pathname;
    if (next !== `${pathname}${window.location.search}`) {
      window.history.replaceState(null, '', next);
    }
  }, [filtersSerial, sort?.field, sort?.direction]);

  return { filters, setFilters, filtersSerial, sort, setSort };
}
