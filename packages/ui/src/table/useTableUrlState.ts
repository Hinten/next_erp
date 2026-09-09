'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import type { ColumnFilterOp, FilterableField } from '../schema/types';
import type { ColumnFilterValue } from './ColumnFilter';
import { listViewMemoryKey, readListViewMemory, writeListViewMemory } from './listViewMemory';

export type SortState = { field: string; direction: 'asc' | 'desc' };

/** Query param holding the free-text search term. */
export const SEARCH_PARAM = 'q';
/** Query param holding the sort. */
export const SORT_PARAM = 'sort';
/** Query param holding the "Carregar mais" window, counted in pages of `pageSize`. */
export const PAGES_PARAM = 'pages';

/**
 * Params this hook owns unconditionally. A schema field named `sort`, `pages` —
 * or `q` on a table that owns the search box — is shadowed by them; all three
 * are checked before the descriptor lookup in {@link parseFiltersFromParams}.
 */
const RESERVED_PARAMS = new Set<string>([SORT_PARAM, SEARCH_PARAM, PAGES_PARAM]);

/**
 * Ceiling on the "Carregar mais" window, enforced on BOTH the button and any
 * page count arriving in the URL.
 *
 * ⚠️ Visible, not silent: the caller replaces the button with a message once
 * it is reached, and a larger count arriving in the URL is clamped and then
 * REWRITTEN by the sync effect, so the address bar always agrees with what was
 * actually read. A ceiling that only bit on reload would hand an operator back
 * fewer rows than they had, with nothing on screen saying why.
 *
 * What it bounds is money and listeners. This database is Firestore ENTERPRISE,
 * which bills DATA SCANNED (root `CLAUDE.md` rule 1), so `?pages=` is a cost
 * lever anyone can type; and on a live-mode list the window is also a concurrent
 * listener count, which is what capped `/pedidos` at 50 rows to begin with
 * (#1216). Ten pages is 500 rows at the default page size.
 */
export const MAX_PAGES = 10;

/**
 * Ceiling on the window recovered from the sticky list memory.
 *
 * Deliberately lower than {@link MAX_PAGES}, because this tier applies WITHOUT
 * being asked — a bare URL restores it. Restoring the window costs a re-read of
 * every row in it, so an operator who once clicked through ten pages would
 * otherwise pay for ten pages on every return to that screen, forever. Three
 * restores the useful case (you were a screen or two down); anything deeper is
 * still reachable from the URL, where it is visible and was asked for.
 */
export const MAX_RESTORED_PAGES = 3;

// ⚠️ Typed on the UI op set, not `PipelineFilterOp`: `between` never reaches
// the query builder, but it MUST round-trip through the URL. An op missing
// here writes to the URL (the sync effect is op-agnostic) and is then dropped
// on hydration, so a shared link silently reopens unfiltered — the bug the
// array-contains note below records.
const FILTER_OPS = new Set<ColumnFilterOp>([
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

  'between',
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
export function encodeFilterValue(value: ColumnFilterValue): string {
  if (value.op === 'between') {
    // `..` separates the bounds. Both are numbers or plain strings here (a
    // range is only offered for numeric and datetime kinds), so neither can
    // contain the separator.
    return `${value.value ?? ''}..${value.valueTo ?? ''}`;
  }
  return Array.isArray(value.value)
    ? value.value.map((v) => encodeURIComponent(String(v))).join(',')
    : String(value.value);
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
    const op = raw.slice(0, sep) as ColumnFilterOp;
    if (!FILTER_OPS.has(op)) continue;
    const rawValue = raw.slice(sep + 1);
    let value: ColumnFilterValue['value'];
    if (op === 'between') {
      // `<lo>..<hi>`, decoded by the OP like `array-contains-any` below and for
      // the same reason: the shape is the op's, not the descriptor kind's.
      // Both bounds are coerced by `kind` because a range is only offered for
      // numeric and datetime fields, where the stored value is a number.
      //
      // ⚠️ Must not throw — this runs from a `useState` initializer, so an
      // exception here takes down the whole TableView subtree during render,
      // over a hand-edited link. An unparseable bound drops the filter, exactly
      // like every other unreadable input in this loop.
      const dot = rawValue.indexOf('..');
      if (dot < 0) continue;
      const loRaw = rawValue.slice(0, dot);
      const hiRaw = rawValue.slice(dot + 2);
      // ⚠️ `null` and UNREADABLE are different answers and must not share a
      // representation. `null` means "this side was intentionally left open";
      // `undefined` means "this side was mangled". Collapsing them — which an
      // earlier revision did — turns `between:xyz..200` into an unbounded-below
      // "até 200": MORE rows than were asked for, behind a chip that
      // confidently reads `Criação: até 08/09/2026`. The scalar ladder below
      // drops the whole filter on an unreadable value (`Number.isNaN` →
      // `continue`), and this branch has to match it rather than merely say so.
      const coerce = (s: string): number | string | null | undefined => {
        if (s === '') return null;
        if (
          descriptor.kind === 'number' ||
          descriptor.kind === 'integer' ||
          descriptor.kind === 'currency' ||
          descriptor.kind === 'datetime'
        ) {
          const n = Number(s);
          return Number.isNaN(n) ? undefined : n;
        }
        return s;
      };
      const lo = coerce(loRaw);
      const hi = coerce(hiRaw);
      // Either bound unreadable ⇒ drop the whole filter, like the scalar ladder.
      if (lo === undefined || hi === undefined) continue;
      // A range with neither bound is not a filter. ONE bound is legitimate —
      // `expandColumnFilter` emits the single predicate it has.
      if (lo === null && hi === null) continue;
      out[key] = { op, value: lo, valueTo: hi };
      continue;
    }
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
 * Parse `?pages=<n>` — the window, counted in pages of the table's `pageSize`.
 *
 * ⚠️ Must neither throw nor surprise. It runs from a `useState` initializer
 * over a hand-editable link, and what it returns becomes a query LIMIT on a
 * database that bills data scanned: anything that is not a whole number ≥ 1
 * degrades to one page, and anything above `max` is clamped to it. `Number`
 * rather than `parseInt`, so `2.5` and `2abc` are rejected outright instead of
 * quietly becoming 2.
 */
export function parsePagesFromParams(params: URLSearchParams, max: number): number {
  const raw = params.get(PAGES_PARAM);
  if (raw === null) return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return 1;
  return Math.min(n, max);
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
  pages = 1,
): string {
  const params = new URLSearchParams();
  for (const [field, v] of Object.entries(filters)) {
    params.set(field, `${v.op}:${encodeFilterValue(v)}`);
  }
  if (sort) params.set(SORT_PARAM, `${sort.field}:${sort.direction}`);
  if (search !== '') params.set(SEARCH_PARAM, search);
  // Omitted at one page, so every link that was shareable before this param
  // existed stays byte-identical and the default needs no URL at all.
  if (pages > 1) params.set(PAGES_PARAM, String(pages));
  return params.toString();
}

/**
 * True when two of this table's own query strings describe the same view.
 *
 * Compared as a key-sorted param list rather than byte-for-byte: filters are
 * serialized in the order {@link parseFiltersFromParams} met them in the URL,
 * and the sync effect merges its own keys into whatever query string is already
 * on the page, so two strings saying exactly the same thing routinely disagree
 * on order. A wrong answer only costs a scroll restore, so this fails closed.
 */
export function sameTableState(a: string, b: string): boolean {
  const canonical = (qs: string) => {
    const params = new URLSearchParams(qs);
    params.sort();
    return params.toString();
  };
  return canonical(a) === canonical(b);
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
  // Parse-gated like the two above, never a presence check. `?pages=0`,
  // `?pages=abc` and `?pages=1` all hydrate to the default window, so counting
  // them as state would suppress the memory tier over a param that changes
  // nothing — dropping the operator's filters, sort, search AND scroll onto a
  // bare list with no explanation.
  if (parsePagesFromParams(params, MAX_PAGES) > 1) return true;
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
  /** Window to open at, already clamped to the ceiling of whichever tier won. */
  pages: number;
  /** Offset to put back, or null when there is nothing to restore. */
  restored: { scroll: number } | null;
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
    const filters = parseFiltersFromParams(searchParams, fields);
    const sort = parseSortFromParams(searchParams) ?? fallbackSort;
    const search = ownsSearch ? (searchParams.get(SEARCH_PARAM) ?? '') : '';
    const pages = parsePagesFromParams(searchParams, MAX_PAGES);
    // The URL owns WHAT is being looked at, always. The offset is still the
    // memory's to give back, but only when the URL describes the very view it
    // was recorded in.
    //
    // ⚠️ That case is browser Back, and it is the whole reason this branch
    // reads the memory at all: the sync effect below has already written this
    // table's own state into the history entry for the list, so returning to it
    // ALWAYS carries table state and would otherwise be indistinguishable from
    // a shared link — which is what threw the operator to the top of the list
    // every time they came back from a record. A link that says something else
    // fails the comparison and gets no restore.
    const memory = memoryKey ? readListViewMemory(memoryKey) : null;
    const sameView =
      memory !== null && sameTableState(memory.qs, encodeTableState(filters, sort, search, pages));
    return {
      filters,
      sort,
      search,
      pages,
      restored: memory && sameView && memory.scroll > 0 ? { scroll: memory.scroll } : null,
    };
  }

  const memory = readListViewMemory(memoryKey);
  if (!memory) {
    return { filters: {}, sort: fallbackSort, search: '', pages: 1, restored: null };
  }
  const remembered = new URLSearchParams(memory.qs);
  return {
    filters: parseFiltersFromParams(remembered, fields),
    sort: parseSortFromParams(remembered) ?? fallbackSort,
    search: ownsSearch ? (remembered.get(SEARCH_PARAM) ?? '') : '',
    // The implicit tier, so the lower ceiling applies.
    pages: parsePagesFromParams(remembered, MAX_RESTORED_PAGES),
    restored: { scroll: memory.scroll },
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
  /** The "Carregar mais" window, in pages of `pageSize`. Mirrored to `?pages=`. */
  pages: number;
  setPages: React.Dispatch<React.SetStateAction<number>>;
  /**
   * Drop everything the OPERATOR put on this list — filters, the search term
   * and their sort — returning it to how the screen opens.
   *
   * A superset of {@link clearAll}, deliberately kept separate rather than
   * folded into it. `clearAll` backs the chip row's button, which is named for
   * the chips beside it, and the chips are built from filters + search only
   * (`describeFilter.ts`) — never from the sort. A `clearAll` that also
   * destroyed a sort no chip shows would do more than its own label admits.
   *
   * ⚠️ The sort goes back to `initialSort`, NOT to `undefined`. A caller that
   * passes one is declaring the order its screen opens in, and that prop is
   * documented as overriding `meta.defaultQuery.orderBy` — so resetting past it
   * would discard a screen's own declaration on a click the operator meant as
   * "undo MY changes". With no `initialSort` the two are identical.
   *
   * ⚠️ The "Carregar mais" window is NOT in scope, by that same rule: the
   * control is labelled "Limpar ordenação, filtros e busca" and says nothing
   * about how much of the list is loaded. It collapses anyway whenever this
   * reset actually changes something, because the caller's shape-reset effect
   * takes the window down with any change to filters or sort.
   */
  resetListState: () => void;
  /**
   * Is any of this list's state the operator's, rather than the screen's?
   *
   * Lives here because it must agree with {@link resetListState} on what
   * "the operator's" means, and the trap is the sort: `initialSort` seeds it
   * (see `resolveInitialTableState`), so `sort !== undefined` is TRUE from the
   * first render on any screen passing that prop, with no interaction at all.
   * Counting it would offer a reset for state nobody set.
   *
   * `pages` is excluded for the matching reason: the reset does not clear it,
   * so counting it would enable a control that then appears to do nothing.
   */
  hasOwnState: boolean;
  /** Scroll offset recovered from the last visit, or null. */
  restored: { scroll: number } | null;
  /** Record the scroll offset for the next visit. */
  rememberScroll: (scroll: number) => void;
}

/**
 * Own the TableView's URL-synced filter + sort + search state, and the
 * per-screen `sessionStorage` memory that makes a list reopen where it was
 * left.
 *
 * Two tiers, split by what each piece of state MEANS. Filters, sort, the search
 * term and the "Carregar mais" window go in the URL, because they say *what you
 * are looking at*: a colleague should be able to receive that in a link, and
 * browser Back must give it back rather than collapsing the list to one page.
 * Only the scroll offset goes in `sessionStorage`, because it says *where you
 * were* — nobody wants `?scroll=840` in a pasted link.
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
  // Seeded in the initializer rather than an effect, so a window arriving in the
  // URL (or restored from the memory) is issued as ONE query instead of a
  // default page followed immediately by a wider re-read.
  const [pages, setPages] = useState<number>(initial.pages);
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

  // The offset the caller last reported, so any persist writes a WHOLE record.
  // It changes independently of the query string, and a partial write would
  // silently drop it.
  //
  // ⚠️ Seeded from what was just restored, not from 0. The sync effect below
  // persists on mount, before the caller has reported anything and before the
  // scroll is actually put back — a zeroed seed would therefore erase the
  // remembered offset in the window between arriving on the screen and the
  // restore landing, so leaving again in that window would lose the position
  // that was on its way back.
  const scrollRef = useRef<number>(initial.restored?.scroll ?? 0);

  // This table's own query string as of the last sync, so `rememberScroll` can
  // persist a whole record without taking `filters`/`sort`/`search` as deps —
  // it is handed to the caller, and a callback whose identity churned every
  // keystroke would churn every effect the caller hangs off it.
  //
  // ⚠️ Seeded from the OPENING state, not `''`. A `rememberScroll` landing
  // before the sync effect below has run would otherwise persist an empty query
  // string — erasing the very filters that were just restored.
  const ownQsRef = useRef(
    encodeTableState(initial.filters, initial.sort, initial.search, initial.pages),
  );

  // The params this table may delete from the URL. A ref so the sync effect
  // does not re-run when `fields` is rebuilt with identical keys — it is a
  // fresh array on every render of a caller that has virtual columns.
  const fieldKeysRef = useRef<string[]>([]);
  fieldKeysRef.current = useMemo(() => fields.map((f) => f.key), [fields]);

  const clearAll = useCallback(() => {
    setFilters({});
    setSearch('');
  }, []);

  /**
   * The order this screen OPENS in — the `initialSort` prop normalized the same
   * way `resolveInitialTableState` normalizes it, so the two cannot disagree
   * about what the pristine sort is.
   *
   * Held in a ref, and keyed on the VALUES rather than the object: callers pass
   * this inline (`orderBy={{ field: 'timestamp', direction: 'desc' }}`), so the
   * object identity changes on every render and a dependency on it would make
   * `resetListState` a new function each time.
   */
  const fallbackSort = useMemo<SortState | undefined>(
    () =>
      initialSort
        ? { field: initialSort.field, direction: initialSort.direction ?? 'asc' }
        : undefined,
    [initialSort?.field, initialSort?.direction],
  );
  const fallbackSortRef = useRef(fallbackSort);
  fallbackSortRef.current = fallbackSort;

  /**
   * The three atoms in ONE handler, so they land in one render: the mirror
   * effect below runs once and writes one `history.replaceState` and one
   * memory entry, rather than three of each with two intermediate states an
   * operator could see in the URL.
   */
  const resetListState = useCallback(() => {
    setFilters({});
    setSearch('');
    setSort(fallbackSortRef.current);
  }, []);

  const hasOwnState =
    Object.keys(filters).length > 0 ||
    search !== '' ||
    (sort !== undefined &&
      (fallbackSort === undefined ||
        sort.field !== fallbackSort.field ||
        sort.direction !== fallbackSort.direction));

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
    const ownQs = encodeTableState(filters, sort, search, pages);
    const own = new URLSearchParams(ownQs);

    const merged = new URLSearchParams(window.location.search);
    for (const key of fieldKeysRef.current) merged.delete(key);
    merged.delete(SORT_PARAM);
    merged.delete(PAGES_PARAM);
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
    if (memoryKey) writeListViewMemory(memoryKey, { qs: ownQs, scroll: scrollRef.current });
  }, [filtersSerial, sort?.field, sort?.direction, search, pages, memoryKey, ownsSearch]);

  const rememberScroll = useCallback(
    (scroll: number) => {
      scrollRef.current = scroll;
      if (!memoryKey) return;
      writeListViewMemory(memoryKey, { qs: ownQsRef.current, scroll });
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
    pages,
    setPages,
    resetListState,
    hasOwnState,
    restored,
    rememberScroll,
  };
}
