'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import type { PipelineFilterOp } from '@delfrance/data';
import type { FilterableField } from '../schema/types';
import type { ColumnFilterValue } from './ColumnFilter';
import { listViewMemoryKey, readListViewMemory, writeListViewMemory } from './listViewMemory';

export type SortState = { field: string; direction: 'asc' | 'desc' };

/** Query param holding the free-text search term. */
export const SEARCH_PARAM = 'q';
/** Query param holding the sort. */
export const SORT_PARAM = 'sort';

/**
 * Params this hook owns unconditionally. A schema field named `sort` — or `q`
 * on a table that owns the search box — is shadowed by them; both are checked
 * before the descriptor lookup in {@link parseFiltersFromParams}.
 */
const RESERVED_PARAMS = new Set<string>([SORT_PARAM, SEARCH_PARAM]);

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
    if (RESERVED_PARAMS.has(key)) continue;
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
      //
      // ⚠️ The decode must not throw. `URLSearchParams.get()` does NOT sanitise
      // a stray `%` (`…:abc%,def` arrives verbatim), and `decodeURIComponent`
      // answers a malformed escape with `URIError`. This function runs from the
      // `useState` initializer in `useTableUrlState`, so a throw here happens
      // DURING RENDER and takes down the whole TableView subtree — over a
      // mangled shared link. Every other unparseable input in this loop drops
      // its filter and continues; so does this one.
      let list: string[];
      try {
        list = rawValue
          .split(',')
          .filter((part) => part !== '')
          .map((part) => decodeURIComponent(part));
      } catch (err) {
        if (!(err instanceof URIError)) throw err;
        continue;
      }
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
  const raw = params.get(SORT_PARAM);
  if (!raw) return undefined;
  const sep = raw.indexOf(':');
  if (sep < 0) return undefined;
  const field = raw.slice(0, sep);
  const direction = raw.slice(sep + 1);
  if (!field || (direction !== 'asc' && direction !== 'desc')) return undefined;
  return { field, direction };
}

/**
 * Serialize this table's own state into a query string (no leading `?`).
 * Exported so the URL write and the `sessionStorage` write are provably the
 * same string — the restore parses back exactly what the URL showed.
 */
export function encodeTableState(
  filters: Record<string, ColumnFilterValue>,
  sort: SortState | undefined,
  search: string,
): string {
  const params = new URLSearchParams();
  for (const [field, v] of Object.entries(filters)) {
    params.set(field, `${v.op}:${encodeFilterValue(v.value)}`);
  }
  if (sort) params.set(SORT_PARAM, `${sort.field}:${sort.direction}`);
  if (search !== '') params.set(SEARCH_PARAM, search);
  return params.toString();
}

/**
 * True when the URL already describes this table's state, in which case the
 * remembered state must NOT be applied — a shared or hand-edited link always
 * outranks what the operator last did on this screen.
 */
export function urlCarriesTableState(
  params: URLSearchParams,
  fields: FilterableField[],
  ownsSearch: boolean,
): boolean {
  if (Object.keys(parseFiltersFromParams(params, fields)).length > 0) return true;
  if (parseSortFromParams(params) !== undefined) return true;
  return ownsSearch && params.get(SEARCH_PARAM) !== null;
}

export interface TableUrlStateOptions {
  /**
   * Resolved collection path. Together with the pathname it keys this table's
   * `sessionStorage` slot — see `listViewMemory`. Omit to disable the memory
   * entirely (the URL still works).
   */
  collectionPath?: string;
  /**
   * Whether this table owns `?q=`. Only true when the caller renders the
   * built-in search box; otherwise the param belongs to the page (a couple of
   * screens run their own async term resolution) and must be left untouched.
   */
  ownsSearch?: boolean;
}

/** The whole initial state of one table, resolved once during its first render. */
export interface InitialTableState {
  filters: Record<string, ColumnFilterValue>;
  sort: SortState | undefined;
  search: string;
  /** From the memory, or null when the URL won / there was nothing stored. */
  restored: { pages: number; scroll: number } | null;
}

/**
 * Resolve a table's opening state: the URL first, then — only if the URL says
 * nothing about this table — whatever the screen was last left in.
 *
 * Split out of the hook so the precedence is directly assertable without
 * rendering anything.
 */
export function resolveInitialTableState(params: {
  searchParams: URLSearchParams;
  fields: FilterableField[];
  initialSort?: { field: string; direction?: 'asc' | 'desc' };
  ownsSearch: boolean;
  memoryKey: string | null;
}): InitialTableState {
  const { searchParams, fields, initialSort, ownsSearch, memoryKey } = params;
  const fallbackSort = initialSort
    ? { field: initialSort.field, direction: initialSort.direction ?? 'asc' }
    : undefined;

  if (!memoryKey || urlCarriesTableState(searchParams, fields, ownsSearch)) {
    return {
      filters: parseFiltersFromParams(searchParams, fields),
      sort: parseSortFromParams(searchParams) ?? fallbackSort,
      search: ownsSearch ? (searchParams.get(SEARCH_PARAM) ?? '') : '',
      restored: null,
    };
  }

  const memory = readListViewMemory(memoryKey);
  if (!memory) {
    return { filters: {}, sort: fallbackSort, search: '', restored: null };
  }
  const remembered = new URLSearchParams(memory.qs);
  return {
    filters: parseFiltersFromParams(remembered, fields),
    sort: parseSortFromParams(remembered) ?? fallbackSort,
    search: ownsSearch ? (remembered.get(SEARCH_PARAM) ?? '') : '',
    restored: { pages: memory.pages, scroll: memory.scroll },
  };
}

export interface TableUrlState {
  filters: Record<string, ColumnFilterValue>;
  setFilters: React.Dispatch<React.SetStateAction<Record<string, ColumnFilterValue>>>;
  /** Deterministic serial of `filters` for memo/effect deps. */
  filtersSerial: string;
  sort: SortState | undefined;
  setSort: React.Dispatch<React.SetStateAction<SortState | undefined>>;
  /** The committed free-text term (`''` when none). */
  search: string;
  setSearch: (term: string) => void;
  /** Drop every column filter and the search term in one go. */
  clearAll: () => void;
  /** Page count + scroll recovered from the last visit, or null. */
  restored: { pages: number; scroll: number } | null;
  /** Record the page count / scroll for the next visit. */
  rememberView: (patch: { pages?: number; scroll?: number }) => void;
}

/**
 * Own the TableView's URL-synced filter + sort + search state, and the
 * per-screen `sessionStorage` memory that makes a list reopen where it was
 * left.
 *
 * Two tiers, split by what each piece of state MEANS. Filters, sort and the
 * search term go in the URL, because they say *what you are looking at* and a
 * colleague should be able to receive that in a link. The page count and the
 * scroll offset go in `sessionStorage`, because they say *where you were* —
 * nobody wants `?scroll=840` in a pasted link.
 *
 * Both tiers are resolved SYNCHRONOUSLY, in the `useState` initializers, so the
 * very first render is already filtered and the restore costs no extra query.
 *
 * ⚠️ That is safe here only because a `TableView` is never part of a server
 * render or the hydration pass: `apps/web`'s `(app)` layout returns a bare
 * `<Loader/>` while `useRequireAuth()` reports `loading`, and `AuthProvider`
 * starts `loading: true` and only resolves inside an effect. Every list
 * therefore mounts strictly AFTER hydration, on the client. Reading
 * `sessionStorage` during a render that the server also produced would desync
 * the markup — which is why the two `localStorage` keys in `TableView` go
 * through Mantine's `getInitialValueInEffect` instead. If a list ever has to
 * render on the server, this must move back into an effect and the caller must
 * hold its query for that tick.
 *
 * The URL always wins: memory is consulted only when the incoming URL carries
 * none of this table's keys, so a shared link is never overridden.
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
  options?: TableUrlStateOptions,
): TableUrlState {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const ownsSearch = options?.ownsSearch ?? false;
  const collectionPath = options?.collectionPath;

  const memoryKey = collectionPath ? listViewMemoryKey(pathname, collectionPath) : null;

  // Resolved once, on the first render. `searchParams`, `fields` and the
  // memory are all read as of that render on purpose — a filterable field that
  // only appears later (a virtual column awaiting an async options list) is the
  // same one-shot limitation the URL hydration always had.
  const [initial] = useState<InitialTableState>(() =>
    resolveInitialTableState({ searchParams, fields, initialSort, ownsSearch, memoryKey }),
  );

  const [filters, setFilters] = useState<Record<string, ColumnFilterValue>>(initial.filters);
  const [sort, setSort] = useState<SortState | undefined>(initial.sort);
  const [search, setSearch] = useState<string>(initial.search);
  const restored = initial.restored;

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

  // The page count / scroll the caller last reported, so any persist writes a
  // WHOLE record. They change independently of the query string, and a partial
  // write would silently drop whichever half did not move.
  //
  // ⚠️ Seeded from what was just restored, not from `{ pages: 1, scroll: 0 }`.
  // The sync effect below persists on mount, before the caller has reported
  // anything and before the scroll is actually put back — a zeroed seed would
  // therefore erase the remembered offset in the window between arriving on the
  // screen and the restore landing, so leaving again in that window would lose
  // the position that was on its way back.
  const viewRef = useRef<{ pages: number; scroll: number }>({
    pages: initial.restored?.pages ?? 1,
    scroll: initial.restored?.scroll ?? 0,
  });

  // This table's own query string as of the last sync, so `rememberView` can
  // persist a whole record without taking `filters`/`sort`/`search` as deps —
  // it is handed to the caller, and a callback whose identity churned every
  // keystroke would churn every effect the caller hangs off it.
  //
  // ⚠️ Seeded from the OPENING state, not `''`. The caller reports its page
  // count from an effect, and a `rememberView` landing before the sync effect
  // below would otherwise persist an empty query string — erasing the very
  // filters that were just restored.
  const ownQsRef = useRef(encodeTableState(initial.filters, initial.sort, initial.search));

  // The params this table may delete from the URL. A ref so the sync effect
  // does not re-run when `fields` is rebuilt with identical keys — it is a
  // fresh array on every render of a caller that has virtual columns.
  const fieldKeysRef = useRef<string[]>([]);
  fieldKeysRef.current = useMemo(() => fields.map((f) => f.key), [fields]);

  const clearAll = useCallback(() => {
    setFilters({});
    setSearch('');
  }, []);

  // Mirror this table's state into the URL and into the memory.
  //
  // ⚠️ Rebuilt from the LIVE query string rather than from scratch. Building a
  // fresh `URLSearchParams` deleted every unrelated param on the same URL —
  // `?copyFrom`, `?copiarDe`, `?devolucaoDe`, `?userCliente`, `?listaId` — which
  // an embedded TableView (the endereços table on `/clientes/<id>`) did on
  // mount, to a param the page it lives in was still going to read.
  //
  // The first run rewrites what was just restored, which is a no-op by
  // construction — the state it serialises IS the state it read.
  useEffect(() => {
    const ownQs = encodeTableState(filters, sort, search);
    const own = new URLSearchParams(ownQs);

    const merged = new URLSearchParams(window.location.search);
    for (const key of fieldKeysRef.current) merged.delete(key);
    merged.delete(SORT_PARAM);
    if (ownsSearch) merged.delete(SEARCH_PARAM);
    for (const [key, value] of own.entries()) merged.set(key, value);

    const qs = merged.toString();
    // `pathname` is read fresh on every run rather than tracked as a dep: when
    // only the route changes, Next has already set the correct URL.
    const next = qs ? `${pathname}?${qs}` : pathname;
    if (next !== `${pathname}${window.location.search}`) {
      window.history.replaceState(null, '', next);
    }
    // Only the OWN keys are remembered — `?copyFrom` and friends belong to the
    // navigation that carried them, not to this screen's saved position.
    ownQsRef.current = ownQs;
    if (memoryKey) writeListViewMemory(memoryKey, { qs: ownQs, ...viewRef.current });
  }, [filtersSerial, sort?.field, sort?.direction, search, memoryKey, ownsSearch]);

  const rememberView = useCallback(
    (patch: { pages?: number; scroll?: number }) => {
      viewRef.current = { ...viewRef.current, ...patch };
      if (!memoryKey) return;
      writeListViewMemory(memoryKey, { qs: ownQsRef.current, ...viewRef.current });
    },
    [memoryKey],
  );

  return {
    filters,
    setFilters,
    filtersSerial,
    sort,
    setSort,
    search,
    setSearch,
    clearAll,
    restored,
    rememberView,
  };
}
