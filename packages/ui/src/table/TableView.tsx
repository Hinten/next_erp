'use client';

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocalStorage } from '@mantine/hooks';
import {
  ActionIcon,
  Alert,
  Button,
  Center,
  Checkbox,
  Group,
  Skeleton,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import type { Route } from 'next';
import type { Firestore, Query } from 'firebase/firestore';
import type { z, ZodObject, ZodRawShape } from 'zod';
import {
  type CollectionHandle,
  type PathContext,
  type PipelineFieldFilter,
  buildQuery,
  limit as fsLimit,
  orderByField,
  whereArrayContains,
  whereEqual,
  whereOp,
} from '@delfrance/data';
import type { CollectionMetadata } from '@delfrance/schemas';
import {
  type SnapshotRow,
  type SnapshotState,
  type SubcollectionLookupSpec,
  useSnapshot,
  useSubcollectionIdLookup,
} from '@delfrance/data/hooks';
import { usePipelineSnapshot } from '@delfrance/data/hooks/usePipelineSnapshot';
import {
  type Pipeline,
  type PipelineOrderSpec,
  PipelineUnsupportedError,
  buildPipeline,
  isPipelineSupported,
} from '@delfrance/data/pipeline-queries';
import { extractFieldsFromSchema } from '../schema/derive';
import type {
  ActionConfig,
  ColumnFilterValue,
  FieldConfig,
  FieldDescriptor,
  FilterableField,
  VirtualColumn,
} from '../schema/types';
import { ActionBar } from './ActionBar';
import { ActionSidePanel } from './ActionSidePanel';
import { ActiveFilters } from './ActiveFilters';
import { useCollectionMonitor } from './useCollectionMonitor';
import { IconArrowDown, IconArrowsSort, IconArrowUp, IconRefreshAlert } from '@tabler/icons-react';
import { ColumnFilter, FilterPopover } from './ColumnFilter';
import { ColumnPicker } from './ColumnPicker';
import { SearchBar } from './SearchBar';
import { type SearchIdResolver, useSearchIdResolution } from './useSearchIdResolution';
import { SEARCH_CHIP_KEY, buildFilterChips, subcollectionLookupFormatter } from './describeFilter';
import { applyColumnFilters } from './filterRows';
import {
  type SortState,
  parseFiltersFromParams,
  parseSortFromParams,
  useTableUrlState,
} from './useTableUrlState';
import { renderCell } from './cell-renderers';

/**
 * Ceiling on the "Carregar mais" window recovered from the sticky list memory.
 *
 * Restoring the window costs a re-read of every row in it, and this database is
 * Firestore ENTERPRISE, which bills DATA SCANNED (root `CLAUDE.md` rule 1) — so
 * an operator who once clicked through ten pages would pay for ten pages on
 * every return to that screen, forever. #1216 measured the same quantity from
 * the other side: on `/pedidos` the page size is effectively a concurrent
 * listener count, which is what capped that list at 50 rows in the first place.
 * Three pages restores the useful case (you were a screen or two down) without
 * reopening either wound.
 */
export const MAX_RESTORED_PAGES = 3;

/**
 * Trailing debounce before a scroll offset is persisted. Long enough that a
 * flick settles into one write, short enough that a deliberate scroll-then-click
 * is captured by the unmount flush rather than lost.
 */
export const SCROLL_PERSIST_DEBOUNCE_MS = 150;

// Re-exported for back-compat; the implementations now live in
// ./useTableUrlState alongside the hook that owns this state.
export { parseFiltersFromParams, parseSortFromParams };

export interface TableViewProps<S extends ZodObject<ZodRawShape>> {
  /** Title shown above the table. */
  title?: ReactNode;
  /** Page-header description / subtitle. */
  description?: ReactNode;
  schema: S;
  collection: CollectionHandle<S>;
  /** Firestore instance — typically `getFirebaseFirestore()`. */
  db: Firestore;
  pathContext?: PathContext;

  /**
   * Default visible columns AND their order. Keys are resolved against
   * the schema first, then against `virtualColumns`.
   *
   * Prefer declaring the set on the schema as `meta.defaultQuery.columns` —
   * the column set drives the Pipelines `select()` projection, so it belongs
   * with the rest of the query. This prop OVERRIDES that declaration, for the
   * cases where one meta backs several screens with different columns (e.g.
   * `integracaoMeta` serves /canais/balcao, /canais/mercado-livre and
   * /canais/whatsapp) or the screen passes no `meta` at all.
   *
   * Omit both to show every non-`unknown` schema field (in schema order)
   * followed by every virtual column.
   */
  defaultColumns?: string[];

  /**
   * Render the ⚙ column picker (default true).
   *
   * `false` ALSO stops reading and writing the persisted column set. That
   * coupling is the whole point rather than a side effect: the ⚙ is the only
   * way to change columns, so honouring a stale
   * `delfrance:tableview:columns:<path>` entry would strand a returning
   * operator on a set they can no longer edit — and since `selectFields`
   * derives the query projection from that set, it would also make the read
   * cost of the screen depend on a choice nobody can see or undo. With the
   * picker off, columns come straight from `defaultColumns` /
   * `meta.defaultQuery.columns`, which is then the whole truth about the
   * screen.
   *
   * Reorder mode goes with it — the ⚙ is its only entry point.
   */
  showColumnPicker?: boolean;

  /** Per-field overrides keyed by field key. */
  fields?: Record<string, FieldConfig>;

  /**
   * Columns that don't correspond to a Zod schema field — for cells
   * whose value is derived, dereferenced, or asynchronously loaded.
   * Each virtual column declares its own `renderCell(row)` receiving
   * the full `SnapshotRow<T>`. Virtual columns render no sort handle
   * and no filter UI; they DO appear in the ColumnPicker.
   */
  virtualColumns?: ReadonlyArray<VirtualColumn<z.infer<S>>>;

  actions?: Array<ActionConfig<z.infer<S>>>;
  /**
   * How the ActionBar lays out bulk actions — forwarded to `ActionBar`.
   * Defaults to `'auto'` (inline until `overflowThreshold`, then overflow menu).
   */
  actionsLayout?: import('./ActionBar').ActionsLayout;
  /**
   * With `actionsLayout: 'auto'`, collapse into the overflow menu once the
   * action count exceeds this. Default 3. Raise it on screens with more
   * bulk actions so e2e/users still see labeled buttons (e.g. /pedidos).
   */
  overflowThreshold?: number;
  selectable?: boolean;

  /**
   * Create-page route. When set, the ActionBar renders a `<Link>`-based
   * "Copiar" button (enabled only with exactly one selected row) that opens
   * `${copyHref}?copyFrom=<id>` — the create page (ObjectView) pre-fills the
   * form from that document. Setting this prop is the on/off toggle; it also
   * implies row selection.
   */
  copyHref?: Route;

  /**
   * Field the update-monitor orders by (`limit(1)`, descending). `false`
   * disables the monitor; omitted auto-resolves to `ultimaModificacao`, then
   * `timestamp`, then disabled when the schema has neither.
   */
  monitorField?: string | false;

  /** Click-through target for each row. */
  rowHref?: (id: string, row: z.infer<S>) => string;
  /**
   * Row-click handler. When set, clicking a row calls this instead of
   * navigating via `rowHref` — use it to open a modal-based editor for an
   * embedded subcollection table. `rowHref` is ignored while this is set.
   */
  onRowClick?: (id: string, row: z.infer<S>) => void;
  /** Optional "Novo" link rendered in the ActionBar. */
  newHref?: string;
  /**
   * Render-prop alternative to `newHref` — typical Next.js usage passes a
   * `<Button component={Link} href="/x/novo">` instance.
   */
  renderNewButton?: () => ReactNode;
  /** Optional rich row-link renderer (defaults to plain <a>). */
  renderRowLink?: (href: string, content: ReactNode) => ReactNode;

  /**
   * Collection metadata — pass the schema's `<x>Meta`. Its `defaultQuery`
   * supplies the initial sort, the base equality filters, and the page size
   * (the single source of truth the Firestore index validators check). Each
   * is individually overridable by the props below; `queryOverride` bypasses
   * all of it.
   */
  meta?: CollectionMetadata;
  /**
   * Values for `meta.defaultQuery.where` entries declared `param: true`
   * (e.g. `{ tipo: 7 }` for a channel slice of a shared collection). Missing
   * a declared param throws — an unbound filter would silently widen the list
   * to the whole collection.
   */
  queryParams?: Record<string, string | number | boolean | null>;

  /** Overrides `meta.defaultQuery.limit`; falls back to 50. */
  pageSize?: number;
  /**
   * Initial sort — overrides `meta.defaultQuery.orderBy`. The user can change
   * it by clicking column headers.
   */
  orderBy?: { field: string; direction?: 'asc' | 'desc' };
  /**
   * Page-owned sort that FORCES the issued order while set, overriding both
   * `meta.defaultQuery.orderBy` and the user's header sort. Unlike `orderBy`
   * (which only seeds the initial state) this is reactive: clear it and the
   * previous order applies again.
   *
   * Exists for Firestore's inequality/orderBy coupling: when a page adds a
   * RANGE `extraFilter` on some field, that field must be the first `orderBy`
   * or the query is invalid (classic path) / stops matching its composite index
   * (Pipelines path, where Enterprise silently full-scans instead of erroring).
   * A header sort would break the same rule, which is why this outranks it.
   * See `apps/web/app/(app)/produtos/page.tsx` — its nome-prefix search.
   */
  forcedOrderBy?: { field: string; direction?: 'asc' | 'desc' };

  /**
   * Page-owned server-side filters, AND-combined with the `meta.defaultQuery`
   * base filters and the user's column filters (applied in that order: base,
   * extra, column). Unlike column filters they carry no filter UI and never
   * round-trip through the URL — the page computes them (e.g. a resolved
   * chave list for an `array-contains-any`). An `array-contains-any` entry
   * whose value is an EMPTY array short-circuits to an empty result set
   * WITHOUT querying (an empty candidate list means "no rows"). An array
   * value on any OTHER op is a programmer error and throws (same guard as
   * `buildPipeline`) rather than silently rendering an empty table. Ignored
   * under `queryOverride` — that query is caller-owned.
   */
  extraFilters?: ReadonlyArray<PipelineFieldFilter>;

  /**
   * Opt-in free-text search box, rendered above the table and owned by this
   * component: the term lives in the URL as `?q=` and is restored with the rest
   * of the list state, which a page-owned `useState` never could.
   *
   * `toFilters` turns the term into server-side filters (AND-combined with
   * `extraFilters`), and `toForcedOrderBy` supplies the sort that term requires
   * — the produtos nome search is a prefix RANGE, and Firestore demands the
   * inequality field be the first `orderBy`. It behaves exactly like the
   * `forcedOrderBy` prop, which still outranks it when both are set.
   *
   * `resolveIds` covers the terms `toFilters` cannot: one whose match lives
   * somewhere the collection cannot be filtered by, so finding it costs a
   * query FIRST (a marketplace item id sits in a produto's link subcollection).
   * Returning `null` declines the term and falls through to `toFilters`, which
   * is what lets ONE box serve two search modes; returning ids constrains the
   * query to them via the same `idIn` a subcollection-lookup filter uses.
   *
   * ⚠️ An empty `ids` array is a real answer — "handled, nothing matched" —
   * and renders an empty table WITHOUT querying the collection. It is NOT the
   * same as `null`: falling through there would run the other mode's filter
   * over a term it was never meant for and report ITS miss instead.
   *
   * ⚠️ `toFilters` and `toForcedOrderBy` are skipped entirely while a
   * resolution is pending or has produced ids. Two search modes must never be
   * AND-ed: a nome range plus an id restriction asks for rows that satisfy
   * both, which is not what either mode means.
   *
   * ⚠️ Without `resolveIds` this prop stays SYNCHRONOUS-only. `/clientes`
   * and `/nfe/comunicacoes` still own their input and their `?q=` handling
   * through `useSearchTermParam` in `apps/web`; they predate `resolveIds` and
   * could migrate onto it, but until they do, do not give them this prop.
   */
  search?: {
    placeholder?: string;
    toFilters: (term: string) => ReadonlyArray<PipelineFieldFilter>;
    toForcedOrderBy?: (term: string) => { field: string; direction?: 'asc' | 'desc' } | undefined;
    resolveIds?: SearchIdResolver;
  };

  /**
   * Escape hatch: pass a custom `Query` (e.g. with composite filters the
   * Pipelines wrapper doesn't cover). When set, search/orderBy/pageSize and
   * `meta.defaultQuery` are ignored — the caller owns the query lifecycle.
   * Column filters still apply client-side to the returned rows.
   */
  queryOverride?: Query<z.infer<S>>;

  /**
   * Opt-in persistent action panel docked to the right of the table. When
   * enabled it REPLACES the top ActionBar — "Novo" / "Copiar" / bulk
   * `actions` move into the panel, still acting on the current selection
   * (the same actions in two places would mean two confirm modals). The
   * panel collapses to a slim rail; the collapsed state persists per
   * collection in localStorage. `width` widens the expanded rail past its
   * 220px default, for panels that host more than buttons (see
   * `renderActionsPanelExtra`).
   */
  actionsPanel?: boolean | { defaultCollapsed?: boolean; width?: number };
  /**
   * Extra content rendered inside the `actionsPanel`, below the buttons —
   * e.g. the live progress of a job the buttons started. Ignored when
   * `actionsPanel` is off. A render prop (same idiom as `renderNewButton`),
   * so the content is a component element and may own hooks. `collapsed`
   * lets the caller shrink to a badge on the slim rail instead of vanishing.
   */
  renderActionsPanelExtra?: (ctx: { collapsed: boolean }) => ReactNode;

  /**
   * Called whenever the checked row set changes (and once with `[]` on
   * mount). Lets a page react to the selection outside an action — e.g. to
   * look up per-row state the panel then renders. Purely observational:
   * TableView owns the selection either way.
   */
  onSelectionChange?: (rows: SnapshotRow<z.infer<S>>[]) => void;
  /**
   * Called whenever the LOADED row set changes (and once with `[]` on mount).
   * Lets a page do per-page work the cells would otherwise do per-row — above
   * all batching reads that a `renderCell` fires one at a time, which is what
   * makes a virtual column's cost scale with `limit`.
   *
   * Purely observational, exactly like {@link onSelectionChange}: TableView owns
   * the rows either way, and a consumer must not assume it is called before the
   * cells render. Anything built on it has to work — more slowly — when it never
   * fires at all.
   */
  onRowsChange?: (rows: SnapshotRow<z.infer<S>>[]) => void;
}

/**
 * Generic TableView. Drives column derivation from the Zod schema, manages
 * per-column filters / sort / ColumnPicker / ActionBar state, and subscribes
 * to a Pipeline (or `queryOverride`) for the row source.
 */
export function TableView<S extends ZodObject<ZodRawShape>>({
  title,
  description,
  schema,
  collection,
  db,
  pathContext = {},
  defaultColumns,
  showColumnPicker = true,
  fields: fieldOverrides = {},
  virtualColumns = [],
  actions = [],
  actionsLayout,
  overflowThreshold,
  selectable = false,
  copyHref,
  monitorField,
  rowHref,
  onRowClick,
  newHref,
  renderNewButton,
  renderRowLink,
  meta,
  queryParams,
  pageSize,
  forcedOrderBy,
  orderBy,
  extraFilters,
  search: searchConfig,
  queryOverride,
  actionsPanel,
  renderActionsPanelExtra,
  onSelectionChange,
  onRowsChange,
}: TableViewProps<S>) {
  // Derive once per schema identity.
  const descriptors = useMemo(() => extractFieldsFromSchema(schema), [schema]);

  const defaultQuery = meta?.defaultQuery;
  // pageSize prop wins, then the declared default, then 50.
  const resolvedPageSize = pageSize ?? defaultQuery?.limit ?? 50;

  // Columns visible by default: the `defaultColumns` prop wins, then the
  // schema's declared `meta.defaultQuery.columns`, then every non-unknown
  // schema field (drops embeddings and other opaque blobs automatically)
  // followed by every virtual column.
  //
  // This is not only presentation: `selectFields` below derives the Pipelines
  // projection from the VISIBLE columns, and Enterprise bills data scanned —
  // which is why the declaration lives next to where/orderBy/limit.
  const defaultVisibleKeys = useMemo<string[]>(
    () =>
      defaultColumns ??
      (defaultQuery?.columns ? [...defaultQuery.columns] : undefined) ?? [
        ...descriptors.filter((d) => d.kind !== 'unknown').map((d) => d.key),
        ...virtualColumns.map((v) => v.key),
      ],
    [defaultColumns, defaultQuery, descriptors, virtualColumns],
  );

  // Storage key is per-collection so /clientes and /categorias never
  // collide. resolvePath('clientes') → 'clientes'; for subcollections it
  // includes the parent ids, giving per-parent column prefs.
  const columnsStorageKey = useMemo(
    () => `delfrance:tableview:columns:${collection.resolvePath(pathContext)}`,
    // pathContext is identity-tracked like the rest of the data layer.
    [collection],
  );

  // Persisted visible columns. `useLocalStorage` returns defaultValue on
  // the server + first client render, then reads localStorage in an effect
  // (getInitialValueInEffect default) — no hydration mismatch.
  const [storedKeysArr, setVisibleKeysArr] = useLocalStorage<string[]>({
    key: columnsStorageKey,
    defaultValue: defaultVisibleKeys,
  });
  // ⚠️ With no ⚙ there is no way to edit the persisted set, so honouring it
  // would pin a returning operator to whatever they last picked — including a
  // set saved BEFORE the screen went fixed, which is how a newly declared
  // default column reaches nobody who has already opened the page. The hook
  // still runs unconditionally (rules of hooks); only its value is bypassed,
  // and nothing writes the key while `showColumnPicker` is false.
  const visibleKeysArr = showColumnPicker ? storedKeysArr : defaultVisibleKeys;

  // Right-side action panel (opt-in). Collapse state persists per
  // collection, same key scheme as the column prefs above.
  const panelEnabled = !!actionsPanel;
  const panelStorageKey = useMemo(
    () => `delfrance:tableview:actionspanel:${collection.resolvePath(pathContext)}`,
    // pathContext is identity-tracked like the rest of the data layer.
    [collection],
  );
  const [panelCollapsed, setPanelCollapsed] = useLocalStorage<boolean>({
    key: panelStorageKey,
    defaultValue:
      typeof actionsPanel === 'object' ? (actionsPanel.defaultCollapsed ?? false) : false,
  });
  const panelWidth = typeof actionsPanel === 'object' ? actionsPanel.width : undefined;

  const visibleKeys = useMemo(() => new Set(visibleKeysArr), [visibleKeysArr]);

  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Bumped by the update-monitor's "Atualizar" button to force the row query
  // to re-execute (the Pipelines path is one-shot — see `pipeline` below).
  const [refreshKey, setRefreshKey] = useState(0);
  // The copy action needs row selection; enabling copy implies `selectable`.
  const selectionEnabled = selectable || !!copyHref;

  // Synthetic filter fields for the virtual columns that declare a `filter`.
  // They carry no Zod descriptor, so build the minimal shape the ColumnFilter
  // UI + the URL value-coercion read (kind drives the input and the number/date
  // coercion). Custom (renderFilter / subcollection-lookup) filters default to
  // string coercion — fine for ref paths and the `"<subfield>:<term>"` NF value.
  const virtualFilterFields = useMemo<FilterableField[]>(
    () =>
      virtualColumns
        .filter((v) => v.filter)
        .map((v) => {
          const f = v.filter!;
          return {
            key: f.field,
            kind: f.kind ?? 'string',
            label: f.label ?? v.label,
            enumValues: f.options,
            dateUnit: f.dateUnit,
          };
        }),
    [virtualColumns],
  );
  const filterableFields = useMemo<FilterableField[]>(
    () => [...descriptors, ...virtualFilterFields],
    [descriptors, virtualFilterFields],
  );

  // URL-synced per-column filters + sort + search term (hydrated from the query
  // string, mirrored back via history.replaceState), plus the per-screen
  // sessionStorage memory that reopens this list where it was last left.
  // `orderBy` is the initial-sort fallback when the URL carries none.
  const {
    filters,
    setFilters,
    filtersSerial,
    sort,
    setSort,
    search: searchTerm,
    setSearch,
    clearAll,
    restored,
    rememberView,
  } = useTableUrlState(filterableFields, orderBy, {
    collectionPath: collection.resolvePath(pathContext),
    // Only claim `?q=` when this component actually renders the search box;
    // otherwise the param belongs to the page and must survive our URL sync.
    ownsSearch: !!searchConfig,
  });

  // "Carregar mais": grows the query limit by `resolvedPageSize` per click.
  // Each bump re-reads the whole window (the one-shot pipeline has no cursor) —
  // fine for admin lists; true cursor pagination is deliberately deferred.
  //
  // Seeded from the sticky list memory (capped — see `MAX_RESTORED_PAGES`) in
  // the initializer rather than an effect, so a restored window is issued as
  // ONE query instead of a default page followed immediately by a wider re-read.
  const [pages, setPages] = useState(() => Math.min(restored?.pages ?? 1, MAX_RESTORED_PAGES));
  const effectiveLimit = resolvedPageSize * pages;

  // A term whose match cannot be expressed as a filter on this collection is
  // resolved to a candidate id list first — see the `search.resolveIds` prop.
  // `undefined` ids means the resolver declined (or there is none), which is
  // what falls the term through to `toFilters` below.
  const searchResolve = useSearchIdResolution(searchConfig?.resolveIds, searchTerm);
  const searchIdsActive = searchResolve.ids !== undefined;
  // While a resolution is in flight we do not yet know WHICH mode the term
  // belongs to, so neither mode may run: issuing the filter search first would
  // paint rows for a term that is about to resolve to different ones.
  const searchResolving = searchResolve.loading;

  // The page's own extra filters, widened by whatever the search term implies.
  // Kept as one value so every downstream consumer (serial, empty-list guard,
  // pipeline, classic fallback) sees the same set.
  //
  // ⚠️ A resolved term contributes NO filters. The two search modes are
  // alternatives, not conjuncts: AND-ing a nome range onto an id restriction
  // asks for rows satisfying both, which is neither mode's meaning.
  const effectiveExtraFilters = useMemo<ReadonlyArray<PipelineFieldFilter> | undefined>(() => {
    if (!searchConfig || searchTerm === '') return extraFilters;
    if (searchIdsActive || searchResolving) return extraFilters;
    const fromSearch = searchConfig.toFilters(searchTerm);
    if (fromSearch.length === 0) return extraFilters;
    return [...(extraFilters ?? []), ...fromSearch];
  }, [extraFilters, searchConfig, searchTerm, searchIdsActive, searchResolving]);

  // Value renderers for filters whose stored value is not self-describing.
  // A subcollection-lookup filter packs its child field into the value as
  // `"<subfield>:<term>"`, which a chip would otherwise print raw
  // (`numeracao:1234` on the pedido NF column); a custom popover can supply
  // its own via `filter.formatValue`.
  const filterValueFormatters = useMemo(() => {
    const out: Record<string, (value: ColumnFilterValue['value']) => string> = {};
    for (const v of virtualColumns) {
      const f = v.filter;
      if (!f) continue;
      if (f.formatValue) out[f.field] = f.formatValue;
      else if (f.subcollectionLookup) {
        out[f.field] = subcollectionLookupFormatter(f.subcollectionLookup.fields);
      }
    }
    return out;
  }, [virtualColumns]);

  // Everything currently narrowing the list, as chips. Labels resolve exactly
  // the way the column HEADER resolves them — a relabelled column whose chip
  // used the raw descriptor label would name a column that is not on screen.
  const activeFilterChips = useMemo(
    () =>
      buildFilterChips({
        filters,
        fields: filterableFields,
        labelFor: (f) => fieldOverrides[f.key]?.label ?? f.label,
        formatters: filterValueFormatters,
        search: searchTerm,
      }),
    // filtersSerial stands in for the `filters` object content.
    [filtersSerial, filterableFields, fieldOverrides, filterValueFormatters, searchTerm],
  );

  // Apply/clear a single column filter (shared by schema + virtual columns).
  function setColumnFilter(field: string, next: ColumnFilterValue | undefined) {
    setFilters((cur) => {
      const copy = { ...cur };
      if (next === undefined) delete copy[field];
      else copy[field] = next;
      return copy;
    });
  }

  // --- Subcollection-lookup filters (e.g. pedido NF by numero/chave) ---------
  // A virtual column may resolve its filter through a sibling collection group
  // instead of a direct where(): parse the active filter's `"<subfield>:<term>"`
  // value, run a collection-group lookup, and constrain the main query to the
  // matching parent ids. Only one such filter is supported at a time (the only
  // consumer is NF); a second would need id-set intersection.
  const subLookupFields = useMemo(
    () => virtualColumns.filter((v) => v.filter?.subcollectionLookup),
    [virtualColumns],
  );
  const subLookupKeys = useMemo(
    () => new Set(subLookupFields.map((v) => v.filter!.field)),
    [subLookupFields],
  );
  const subLookupSpec = useMemo<SubcollectionLookupSpec | null>(() => {
    for (const v of subLookupFields) {
      const f = v.filter!;
      const active = filters[f.field];
      if (!active) continue;
      const raw = String(active.value ?? '');
      const sep = raw.indexOf(':');
      const subfield = sep >= 0 ? raw.slice(0, sep) : '';
      const term = sep >= 0 ? raw.slice(sep + 1) : raw;
      if (!subfield || term === '') continue;
      const spec = f.subcollectionLookup!.fields.find((x) => x.value === subfield);
      if (!spec) continue;
      // A numeric child field (e.g. nfev4.numeracao) must parse cleanly — skip
      // the lookup on a non-numeric term rather than push NaN into the query.
      const value = spec.numeric ? Number(term) : term;
      if (spec.numeric && !Number.isFinite(value as number)) continue;
      return {
        subcollection: f.subcollectionLookup!.subcollection,
        match: [{ field: subfield, value }],
      };
    }
    return null;
    // filtersSerial stands in for `filters`.
  }, [subLookupFields, filtersSerial]);

  const subLookup = useSubcollectionIdLookup(db, subLookupSpec);
  const lookupActive = subLookupSpec !== null;

  // TWO independent id restrictions can now be active at once: a
  // subcollection-lookup filter (the pedido NF column) and an async search
  // term (`search.resolveIds`). Both mean "the row must be one of these", so
  // the only correct combination is the INTERSECTION — a union would widen
  // each past what its own control asked for, and honouring just one would
  // silently drop the other's restriction while its chip still claims to apply.
  const combinedIds = useMemo<string[] | undefined>(() => {
    const fromLookup = lookupActive ? (subLookup.ids ?? undefined) : undefined;
    const fromSearch = searchResolve.ids;
    if (fromLookup && fromSearch) {
      const keep = new Set(fromSearch);
      return fromLookup.filter((id) => keep.has(id));
    }
    if (fromLookup) return [...fromLookup];
    return fromSearch ? [...fromSearch] : undefined;
  }, [lookupActive, subLookup.ids, searchResolve.ids]);

  const lookupLoading = (lookupActive && subLookup.loading) || searchResolving;
  // Resolved to zero matches → no rows; don't build a whole-collection query.
  const lookupEmpty = combinedIds !== undefined && combinedIds.length === 0;
  const idIn = combinedIds;
  // Is the row set restricted to a resolved id list at all — from EITHER
  // source, and including while one is still resolving? Only the pipeline can
  // honour `idIn`, so the classic fallback keys on this to render nothing
  // rather than the whole collection. ⚠️ `lookupActive` alone is not this
  // question: it covers the subcollection filter only, and a search resolution
  // that fell back would silently paint the entire catalog under a term that
  // matched one produto.
  const idRestrictionActive = lookupActive || searchIdsActive || searchResolving;
  // JSON (not join) so an id containing the separator can't collide and strand
  // the pipeline memo on a stale value.
  const idInSerial = idIn ? JSON.stringify(idIn) : '';

  // Filters pushed to the server / applied client-side, EXCLUDING the
  // subcollection-lookup keys (which are resolved via `idIn`, not a where()).
  const serverFilters = useMemo<Record<string, ColumnFilterValue>>(() => {
    if (subLookupKeys.size === 0) return filters;
    return Object.fromEntries(Object.entries(filters).filter(([k]) => !subLookupKeys.has(k)));
  }, [filtersSerial, subLookupKeys]);
  const serverFiltersSerial = useMemo(
    () =>
      JSON.stringify(
        Object.keys(serverFilters)
          .sort()
          .map((k) => [k, serverFilters[k]]),
      ),
    [serverFilters],
  );

  // Stable serial for `queryParams` so the base-filter memo rebuilds only when
  // a bound value actually changes (callers needn't memoize the object).
  const queryParamsSerial = useMemo(() => JSON.stringify(queryParams ?? null), [queryParams]);

  // Base equality filters from `meta.defaultQuery.where`. Always applied,
  // independent of user column filters — silently dropping them (e.g. listing
  // variation children on a catalog screen) would be a data bug. `param`
  // entries are bound from `queryParams`; a missing binding throws.
  const baseFilters = useMemo<PipelineFieldFilter[]>(() => {
    const where = defaultQuery?.where;
    if (!where || where.length === 0) return [];
    return where.map((w) => {
      if ('param' in w) {
        if (!queryParams || !(w.field in queryParams)) {
          throw new Error(
            `TableView: meta.defaultQuery declares param "${w.field}" but no ` +
              `queryParams value was provided. Pass queryParams={{ ${w.field}: … }}.`,
          );
        }
        return { field: w.field, op: 'eq' as const, value: queryParams[w.field] ?? null };
      }
      return { field: w.field, op: 'eq' as const, value: w.value };
    });
    // queryParamsSerial stands in for queryParams; defaultQuery is identity-
    // tracked like meta itself.
  }, [defaultQuery, queryParamsSerial]);
  const baseFiltersSerial = useMemo(() => JSON.stringify(baseFilters), [baseFilters]);

  // Page-owned extra filters (see the prop jsdoc). Serialized for memo deps
  // so callers needn't memoize the array. An `array-contains-any` entry whose
  // candidate list resolved to nothing means "no rows" — short-circuit instead
  // of querying, mirroring `lookupEmpty`. Scoped to that op on purpose: an
  // empty array on any other op is a programmer error that must reach the
  // `buildPipeline` guard (or the fallback guard below) and throw, not render
  // an empty table. Under `queryOverride` the extras (and the short-circuit)
  // don't apply: that query is caller-owned.
  const extraFiltersSerial = useMemo(
    () => JSON.stringify(effectiveExtraFilters ?? null),
    [effectiveExtraFilters],
  );
  // Same rule for a USER column filter carrying a candidate list (a virtual
  // column's `renderFilter` can emit `array-contains-any`). Its UI is expected
  // to emit `undefined` rather than `[]` — dropping the filter is what "nothing
  // selected" means — so this is the backstop for the one that doesn't: an
  // empty list reaches `buildPipeline` as a THROW, which blanks the screen with
  // an uncaught error instead of rendering zero rows.
  const columnFilterEmpty = useMemo(
    () =>
      Object.values(serverFilters).some(
        (f) => f.op === 'array-contains-any' && Array.isArray(f.value) && f.value.length === 0,
      ),
    [serverFiltersSerial],
  );
  const extraEmpty =
    columnFilterEmpty ||
    (!queryOverride &&
      (effectiveExtraFilters ?? []).some(
        (f) => f.op === 'array-contains-any' && Array.isArray(f.value) && f.value.length === 0,
      ));

  // Sort actually issued to Firestore: an explicit user/prop sort wins;
  // otherwise the declared default `orderBy` (full array — supports multi-key
  // defaults and matches the declared composite index).
  // The built-in search box forces its own order for the same reason the prop
  // exists: a prefix RANGE has to be the first `orderBy` or the query is
  // invalid on the classic path and silently stops matching its composite
  // index on the Pipelines path. The explicit prop still outranks it — a page
  // that states its order means it.
  // ⚠️ A term resolved to ids contributes no order either: its forced sort
  // exists to make the RANGE `toFilters` builds index-seekable, and that range
  // is not being issued. Forcing `nome asc` anyway would re-sort the id hits by
  // a rule nothing on screen is applying.
  const searchForcedOrderBy =
    searchConfig && searchTerm !== '' && !searchIdsActive && !searchResolving
      ? searchConfig.toForcedOrderBy?.(searchTerm)
      : undefined;
  const resolvedForcedOrderBy = forcedOrderBy ?? searchForcedOrderBy;
  const forcedSort: SortState | undefined = resolvedForcedOrderBy
    ? {
        field: resolvedForcedOrderBy.field,
        direction: resolvedForcedOrderBy.direction ?? 'asc',
      }
    : undefined;
  const effectiveOrderBy = useMemo<PipelineOrderSpec[] | undefined>(() => {
    // `forcedOrderBy` outranks the user sort on purpose — see its prop doc.
    if (forcedSort) return [{ field: forcedSort.field, direction: forcedSort.direction }];
    if (sort) return [{ field: sort.field, direction: sort.direction }];
    if (defaultQuery?.orderBy?.length) {
      return defaultQuery.orderBy.map((o) => ({ field: o.field, direction: o.direction }));
    }
    return undefined;
  }, [forcedSort?.field, forcedSort?.direction, sort?.field, sort?.direction, defaultQuery]);
  // Column the header arrow points at. Mirrors what was actually issued, so a
  // forced sort is visible to the user rather than silently disagreeing with
  // the arrow.
  const displaySort: SortState | undefined =
    forcedSort ??
    sort ??
    (defaultQuery?.orderBy?.[0]
      ? { field: defaultQuery.orderBy[0].field, direction: defaultQuery.orderBy[0].direction }
      : undefined);

  // Pipeline projection (`select`). Project the visible schema columns to cut
  // payload; `buildPipeline` re-appends the doc id. Visible virtual columns
  // can read arbitrary fields from `row.data`, so a visible virtual WITHOUT a
  // `dependsOn` declaration disables projection (full-doc read); otherwise we
  // widen the projection by every declared dependsOn. `undefined` = no select.
  const selectFields = useMemo<string[] | undefined>(() => {
    const schemaKeys = [...visibleKeys].filter((k) => descriptors.some((d) => d.key === k));
    const visibleVirtuals = virtualColumns.filter((v) => visibleKeys.has(v.key));
    if (visibleVirtuals.length === 0) return schemaKeys;
    if (visibleVirtuals.some((v) => v.dependsOn === undefined)) return undefined;
    const union = new Set(schemaKeys);
    for (const v of visibleVirtuals) for (const f of v.dependsOn ?? []) union.add(f);
    return [...union];
  }, [visibleKeys, descriptors, virtualColumns]);
  const selectFieldsSerial = useMemo(
    () => (selectFields ? selectFields.join('|') : '*'),
    [selectFields],
  );

  // Clicking a header cycles that column's sort. Flip relative to the
  // *displayed* sort (`displaySort`, which includes the meta default), not the
  // raw `sort` state — otherwise the first click on a column shown ascending
  // by the meta default would re-set ascending (a visual no-op) instead of
  // going to descending. A different column starts ascending.
  // While a forced sort is active the headers are not interactive — see
  // `toggleSort`. Say so rather than leaving a pointer cursor on a dead control.
  const FORCED_SORT_TITLE = 'Ordenação fixada pela busca ativa';
  const sortable = !forcedSort;

  function toggleSort(fieldKey: string) {
    // A forced sort outranks the user's, so recording their click would do
    // nothing NOW and then silently re-sort the list the moment the forced sort
    // clears — a delayed jump with no visible cause, which reads worse than the
    // click being inert. Ignore it while forced; the header renders as
    // non-interactive so it should not be reachable anyway.
    if (forcedSort) return;
    const current = displaySort?.field === fieldKey ? displaySort.direction : undefined;
    setSort({ field: fieldKey, direction: current === 'asc' ? 'desc' : 'asc' });
  }

  // --- Data source selection ----------------------------------------------
  // Always use the classic Query path when an override is supplied. Otherwise,
  // try Pipelines first; fall back to buildQuery when unsupported by the SDK.
  const pipeline: Pipeline | null = useMemo(() => {
    if (queryOverride) return null;
    if (!isPipelineSupported(db)) return null;
    // A subcollection-lookup filter is active but still resolving, or it
    // resolved to zero parent ids — either way don't query the collection.
    if (lookupLoading || lookupEmpty) return null;
    // An extraFilters entry carries an empty candidate list → no rows; don't
    // query at all (buildPipeline would throw on the empty list).
    if (extraEmpty) return null;
    try {
      return buildPipeline(db, {
        collection: collection.resolvePath(pathContext),
        // Base equality filters (from meta.defaultQuery), the page-owned
        // extraFilters, AND the user's per-column filters (minus
        // subcollection-lookup keys, applied via `idIn`). Base first so it
        // reads like the declared query.
        filters: [
          ...baseFilters,
          ...(effectiveExtraFilters ?? []),
          ...Object.entries(serverFilters).map(([field, v]) => ({ field, ...v })),
        ],
        // Constrain to the parent ids a subcollection lookup resolved (NF
        // by numero/chave). Undefined when no such filter is active.
        idIn,
        // Project the visible schema columns (+ any virtual-column
        // `dependsOn`) to cut data transfer; `undefined` reads the full doc.
        // See `selectFields` above. `buildPipeline` re-appends the document-id
        // projection so row identity survives `.select()` (PIPELINE_ID_FIELD).
        select: selectFields,
        orderBy: effectiveOrderBy,
        limit: effectiveLimit,
      });
    } catch (err) {
      // Only the documented "SDK lacks pipeline()" signal falls back to
      // buildQuery; anything else (bad field path, SDK bug) must surface.
      if (err instanceof PipelineUnsupportedError) return null;
      throw err;
    }
    // `pathContext` is intentionally not stringified; consumers should keep
    // the object stable across renders (matches the rest of the data layer).
  }, [
    db,
    collection,
    queryOverride,
    effectiveLimit,
    effectiveOrderBy,
    baseFiltersSerial,
    extraFiltersSerial,
    extraEmpty,
    serverFiltersSerial,
    idInSerial,
    lookupLoading,
    lookupEmpty,
    selectFieldsSerial,
    refreshKey,
  ]);

  const fallbackQuery: Query<z.infer<S>> | null = useMemo(() => {
    if (queryOverride) return queryOverride;
    if (pipeline) return null;
    // An id restriction resolves via `idIn` (pipeline-only) — a subcollection
    // lookup or an async search term. On the classic fallback we can't honor
    // it, so render nothing rather than the whole list.
    if (idRestrictionActive) return null;
    // Same short-circuit as the pipeline path: an empty extra-filter
    // candidate list means "no rows" — don't build a query.
    if (extraEmpty) return null;
    const base = collection.ref(db, pathContext);
    const constraints = [];
    // Base equality filters first (same as the pipeline path) — these must
    // never be dropped. equality + orderBy is a legal classic query.
    for (const f of baseFilters) constraints.push(whereEqual(f.field, f.value));
    // Page-owned extraFilters stay server-side on the classic path too. The
    // pipeline-only ops degrade: `array-contains-any` maps to the classic
    // operator, which caps the candidate list at 30 values (Firestore limit —
    // callers must truncate); `contains`/`startsWith` have no classic
    // equivalent, so extra filters using them are pipeline-only by contract.
    for (const f of effectiveExtraFilters ?? []) {
      // Mirror `buildPipeline`'s guard: only `array-contains-any` takes a
      // list. Surfacing the error beats silently querying nonsense.
      if (f.op !== 'array-contains-any' && Array.isArray(f.value)) {
        throw new Error(
          `TableView: extraFilters op "${f.op}" on "${f.field}" received an array ` +
            `value; only "array-contains-any" accepts a list.`,
        );
      }
      switch (f.op) {
        case 'eq':
          constraints.push(whereEqual(f.field, f.value));
          break;
        case 'lt':
          constraints.push(whereOp(f.field, '<', f.value));
          break;
        case 'lte':
          constraints.push(whereOp(f.field, '<=', f.value));
          break;
        case 'gt':
          constraints.push(whereOp(f.field, '>', f.value));
          break;
        case 'gte':
          constraints.push(whereOp(f.field, '>=', f.value));
          break;
        case 'array-contains':
          constraints.push(whereArrayContains(f.field, f.value));
          break;
        case 'array-contains-any':
          constraints.push(whereOp(f.field, 'array-contains-any', f.value));
          break;
        case 'contains':
        case 'startsWith':
          throw new Error(
            `TableView: extraFilters op "${f.op}" on "${f.field}" is pipeline-only ` +
              `and has no classic-query fallback.`,
          );
      }
    }
    for (const o of effectiveOrderBy ?? []) constraints.push(orderByField(o.field, o.direction));
    constraints.push(fsLimit(effectiveLimit));
    return buildQuery(base, constraints);
  }, [
    db,
    collection,
    queryOverride,
    pipeline,
    lookupActive,
    effectiveLimit,
    effectiveOrderBy,
    baseFiltersSerial,
    extraFiltersSerial,
    extraEmpty,
    refreshKey,
  ]);

  const fromPipeline = usePipelineSnapshot<z.infer<S>>(pipeline);
  const fromQuery = useSnapshot<z.infer<S>>(fallbackQuery);
  const snap: SnapshotState<SnapshotRow<z.infer<S>>[]> = pipeline ? fromPipeline : fromQuery;

  // Rows to display. The Pipeline path applies per-column filters server-side;
  // the classic fallback and `queryOverride` paths can't, so narrow them here
  // to match (base meta filters are already in the fallback query / owned by
  // the override). Everything below — selection, counts, the table body —
  // reads `rows`, not `snap.data`, so it all stays consistent with the filter.
  const rows = useMemo<SnapshotRow<z.infer<S>>[] | undefined>(
    () => {
      // A subcollection lookup that matched nothing, or an extra filter with
      // an empty candidate list → no rows (no query ran).
      if (lookupEmpty || extraEmpty) return [];
      if (pipeline || !snap.data) return snap.data;
      return applyColumnFilters(snap.data, serverFilters);
    },
    // serverFiltersSerial stands in for the `serverFilters` object content.
    [pipeline, snap.data, serverFiltersSerial, lookupEmpty, extraEmpty],
  );

  // Collapse "Carregar mais" back to one page whenever the query shape changes
  // (filters, sort, base filters or bound params) — the expanded window only
  // makes sense for the result set the user was looking at.
  //
  // ⚠️ Keyed on the query SHAPE, not on "have I run before". The window is now
  // seeded from the sticky memory in `useState` above, so this effect's mount
  // run must not collapse it — but a boolean "skip the first run" ref does NOT
  // survive contact with React StrictMode, which `apps/web/next.config` turns
  // on: StrictMode mounts, unmounts and remounts on the SAME fiber, so the ref
  // is already armed on the second run, `setPages(1)` fires, and the restored
  // window silently disappears in `next dev` while production behaves
  // correctly. Comparing the shape is idempotent under double-invocation —
  // the second run computes the same signature and finds nothing changed — and
  // it also says what this effect actually means: reset when the result set
  // the window described is no longer the one being queried.
  // Declared here rather than beside its own effect so the shape effect below
  // can burn it: the two halves of the restored position have to expire
  // together.
  const scrollRestoredRef = useRef(false);

  const pagesResetShape = useRef<string | null>(null);
  useEffect(() => {
    const shape = JSON.stringify([
      filtersSerial,
      baseFiltersSerial,
      extraFiltersSerial,
      queryParamsSerial,
      sort?.field,
      sort?.direction,
      forcedSort?.field,
      forcedSort?.direction,
    ]);
    if (pagesResetShape.current === shape) return;
    const firstRun = pagesResetShape.current === null;
    pagesResetShape.current = shape;
    if (firstRun) return;
    setPages(1);
    // The remembered offset described the result set the operator LEFT, so it
    // is meaningless against a different one. Burn the latch rather than let it
    // sit armed: the search box and the chip row are interactive while the
    // first (possibly slow, restored-window-sized) query is still loading, so
    // an operator who types there would otherwise be thrown down a result set
    // they never scrolled the moment their own rows land.
    scrollRestoredRef.current = true;
  }, [
    filtersSerial,
    baseFiltersSerial,
    extraFiltersSerial,
    queryParamsSerial,
    sort?.field,
    sort?.direction,
    forcedSort?.field,
    forcedSort?.direction,
  ]);

  // Remember the window for the next visit.
  useEffect(() => {
    rememberView({ pages });
  }, [pages, rememberView]);

  // Remember where the operator was scrolled to.
  //
  // The WINDOW is the scroller, not any element here: this component wraps the
  // table in plain `Stack`/`Group` with no overflow, and Mantine's `AppShell`
  // runs in its default `mode: "fixed"`, where `AppShell.Main` sets a
  // `min-height` and no overflow at all. Reading a container's `scrollTop`
  // would sample a constant zero.
  // Debounced on a TRAILING edge rather than coalesced per animation frame: a
  // frame-coalesced write still runs ~60 `JSON.stringify` + `setItem` pairs a
  // second for the whole gesture, and not one of them is ever read — the offset
  // is only consumed by `resolveInitialTableState` on the NEXT mount. One write
  // when the gesture settles is equivalent and two orders of magnitude cheaper.
  useEffect(() => {
    let handle = 0;
    let moved = false;
    const onScroll = () => {
      moved = true;
      window.clearTimeout(handle);
      handle = window.setTimeout(
        () => rememberView({ scroll: window.scrollY }),
        SCROLL_PERSIST_DEBOUNCE_MS,
      );
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.clearTimeout(handle);
      // Flush what the debounce still owes — otherwise clicking a row within
      // the debounce window of the last scroll loses that scroll entirely,
      // which is exactly the gesture this feature exists to remember.
      //
      // ⚠️ Only when this mount actually saw a scroll. StrictMode mounts,
      // cleans up and remounts immediately, and an unconditional flush there
      // would persist `scrollY` 0 over the offset the restore is still on its
      // way to putting back.
      if (moved) rememberView({ scroll: window.scrollY });
    };
  }, [rememberView]);

  // Put it back, once, after the rows that give the page its height exist —
  // scrolling to an offset the document is not yet tall enough for silently
  // lands at the bottom instead.
  useEffect(() => {
    if (scrollRestoredRef.current) return;
    if (!restored || restored.scroll <= 0) return;
    if (!rows || rows.length === 0) return;
    scrollRestoredRef.current = true;
    const target = restored.scroll;
    window.requestAnimationFrame(() => window.scrollTo(0, target));
  }, [rows, restored]);

  // Drop selected ids that left the current row set (filter change, refresh,
  // delete in another tab) so bulk actions and the header checkbox never act
  // on ghost rows. Returns the same Set when nothing changed, so the effect
  // can't loop on Set identity.
  useEffect(() => {
    if (!rows) return;
    setSelected((cur) => {
      if (cur.size === 0) return cur;
      const live = new Set(rows.map((r) => r.id));
      const next = new Set([...cur].filter((id) => live.has(id)));
      return next.size === cur.size ? cur : next;
    });
  }, [rows]);

  /**
   * Ordered list of columns to render — schema descriptors AND virtual
   * columns interleaved. Each entry is tagged with its kind so the
   * header / cell render switches cleanly without re-doing the lookup.
   *
   * Order is exactly `visibleKeysArr`: the persisted, user-reorderable
   * list of visible keys (seeded from `defaultVisibleKeys`, then edited
   * via the ColumnPicker's visibility checkboxes and reorder mode).
   * Unknown-kind descriptors, `fieldOverrides[k].hidden` descriptors and
   * keys that match neither a descriptor nor a virtual column are skipped.
   */
  const visibleColumns = useMemo(() => {
    const schemaByKey = new Map(descriptors.map((d) => [d.key, d]));
    const virtualByKey = new Map(virtualColumns.map((v) => [v.key, v]));
    const out: Array<
      | { kind: 'schema'; descriptor: FieldDescriptor }
      | { kind: 'virtual'; column: VirtualColumn<z.infer<S>> }
    > = [];
    const seen = new Set<string>();
    for (const key of visibleKeysArr) {
      if (seen.has(key)) continue;
      seen.add(key);
      const descriptor = schemaByKey.get(key);
      if (descriptor) {
        if (descriptor.kind === 'unknown') continue;
        if (fieldOverrides[key]?.hidden) continue;
        out.push({ kind: 'schema', descriptor });
        continue;
      }
      const virtual = virtualByKey.get(key);
      if (virtual) out.push({ kind: 'virtual', column: virtual });
    }
    return out;
  }, [visibleKeysArr, descriptors, virtualColumns, fieldOverrides]);

  /**
   * Columns offered by the ColumnPicker. It MUST apply the same exclusions as
   * `visibleColumns` above: `hidden` is a design-time decision by the page, so
   * a hidden field is not a column the user may turn on, and offering its
   * checkbox anyway is a control that does nothing — it ticks, it persists, and
   * no column appears. #1264 shipped exactly that on /produtos, where the
   * picker's label search matched only the dead "Integracoes Com Produto"
   * entry and never the virtual "Canais de venda" column that replaced it.
   *
   * The label comes from the override too, so the picker names a column exactly
   * as its header does (same expression as the schema header below).
   */
  const pickerFields = useMemo(
    () => [
      ...descriptors
        .filter((d) => d.kind !== 'unknown' && !fieldOverrides[d.key]?.hidden)
        .map((d) => ({ key: d.key, label: fieldOverrides[d.key]?.label ?? d.label })),
      ...virtualColumns.map((v) => ({ key: v.key, label: v.label })),
    ],
    [descriptors, fieldOverrides, virtualColumns],
  );

  /**
   * Subset of schema descriptors that are currently visible — for legacy
   * call sites (filter parsing, monitor-field auto-detect) that don't
   * need to know about virtual columns.
   */
  const visibleDescriptors = useMemo(
    () => visibleColumns.flatMap((c) => (c.kind === 'schema' ? [c.descriptor] : [])),
    [visibleColumns],
  );

  // Hiding drops the key; showing appends it to the end of the order. The
  // array doubles as the display order — see `visibleColumns` above.
  function toggleColumn(key: string) {
    setVisibleKeysArr((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  }

  function reorderColumns(next: string[]) {
    setVisibleKeysArr(next);
  }

  function toggleRow(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (!rows) return;
    setSelected((cur) => (cur.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))));
  }

  const selectedRows = useMemo(
    () => (rows ?? []).filter((r) => selected.has(r.id)),
    [rows, selected],
  );

  // Notify on the selected ID SET, never on `selectedRows`: that memo is
  // re-derived on every snapshot tick, so depending on it would re-fire the
  // callback for unrelated row updates. Both the rows and the callback are
  // read through a latest-ref so a consumer passing an inline arrow (the
  // normal case) doesn't turn "set state from the callback" into a loop.
  const selectionNotifyRef = useRef<{
    rows: SnapshotRow<z.infer<S>>[];
    cb: TableViewProps<S>['onSelectionChange'];
  }>({ rows: selectedRows, cb: onSelectionChange });
  useEffect(() => {
    selectionNotifyRef.current = { rows: selectedRows, cb: onSelectionChange };
  });
  useEffect(() => {
    selectionNotifyRef.current.cb?.(selectionNotifyRef.current.rows);
  }, [selected]);

  // Same shape as the selection notifier above, and for the same reason: notify
  // on the row IDENTITY set, never on the `rows` array, so a re-render that
  // produces an equal-but-new array does not re-fire the callback (a consumer
  // that batches reads would re-issue them every render).
  const rowIdsSerial = JSON.stringify((rows ?? []).map((r) => r.id));
  const rowsNotifyRef = useRef<{
    rows: SnapshotRow<z.infer<S>>[];
    cb: TableViewProps<S>['onRowsChange'];
  }>({ rows: rows ?? [], cb: onRowsChange });
  useEffect(() => {
    rowsNotifyRef.current = { rows: rows ?? [], cb: onRowsChange };
  });
  useEffect(() => {
    rowsNotifyRef.current.cb?.(rowsNotifyRef.current.rows);
  }, [rowIdsSerial]);

  // Update-monitor field: explicit prop wins; otherwise prefer a
  // last-modified field, then the creation timestamp.
  const resolvedMonitorField = useMemo<string | null>(() => {
    if (monitorField === false) return null;
    if (typeof monitorField === 'string') return monitorField;
    const keys = new Set(descriptors.map((d) => d.key));
    if (keys.has('ultimaModificacao')) return 'ultimaModificacao';
    if (keys.has('timestamp')) return 'timestamp';
    return null;
  }, [monitorField, descriptors]);

  const monitor = useCollectionMonitor({
    db,
    collection,
    pathContext,
    field: resolvedMonitorField,
  });

  // The top-right toolbar row. Every member is conditional, so without this
  // guard a screen that has none of them (picker off, nothing stale, actions
  // in the docked rail — exactly /produtos) still renders an empty flex row
  // and pays for its vertical space.
  const actionBarShown =
    !panelEnabled && (actions.length > 0 || !!newHref || !!renderNewButton || !!copyHref);
  const headerToolbarShown = monitor.stale || showColumnPicker || actionBarShown;

  // An id restriction that hit its cap is showing a PREFIX of the real answer.
  // Both sources compute this and neither used to render it, so the 30-row cap
  // read as a complete result set — the failure mode a silent cap always has.
  const lookupTruncated = subLookup.truncated || searchResolve.truncated;

  return (
    <Stack>
      {(title || description) && (
        <Stack gap={2}>
          {title && (typeof title === 'string' ? <Title order={2}>{title}</Title> : title)}
          {description && (
            <Text c="dimmed" size="sm">
              {description}
            </Text>
          )}
        </Stack>
      )}

      {/* Table column + optional right action panel. `minWidth: 0` lets the
          table shrink inside the nowrap flex row instead of overflowing. */}
      <Group align="flex-start" wrap="nowrap" gap="md">
        <Stack style={{ flex: 1, minWidth: 0 }}>
          {headerToolbarShown && (
            <Group justify="flex-end" wrap="nowrap" align="flex-end">
              <Group gap="xs">
                {monitor.stale && (
                  <Tooltip
                    label="Os dados desta coleção foram alterados desde que a página carregou. Clique para atualizar."
                    withinPortal
                    multiline
                    maw={260}
                  >
                    <ActionIcon
                      variant="subtle"
                      color="yellow"
                      aria-label="Página desatualizada — atualizar"
                      onClick={() => {
                        monitor.acknowledge();
                        setRefreshKey((k) => k + 1);
                      }}
                    >
                      <IconRefreshAlert size={18} />
                    </ActionIcon>
                  </Tooltip>
                )}
                {showColumnPicker && (
                  <ColumnPicker
                    fields={pickerFields}
                    visibleKeys={visibleKeys}
                    onToggle={toggleColumn}
                    order={visibleKeysArr}
                    onReorder={reorderColumns}
                  />
                )}
                {actionBarShown && (
                  <ActionBar
                    actions={actions}
                    selectedRows={selectedRows}
                    visibleRows={rows ?? []}
                    newHref={newHref}
                    renderNewButton={renderNewButton}
                    copyHref={copyHref}
                    actionsLayout={actionsLayout}
                    overflowThreshold={overflowThreshold}
                    onActionComplete={() => {
                      setSelected(new Set());
                      setRefreshKey((k) => k + 1);
                    }}
                  />
                )}
              </Group>
            </Group>
          )}

          {searchConfig && (
            <SearchBar
              placeholder={searchConfig.placeholder}
              value={searchTerm}
              onChange={setSearch}
            />
          )}

          <ActiveFilters
            chips={activeFilterChips}
            onRemove={(key) =>
              key === SEARCH_CHIP_KEY ? setSearch('') : setColumnFilter(key, undefined)
            }
            onClearAll={clearAll}
          />

          {lookupTruncated && (
            <Text c="dimmed" size="sm">
              Mais resultados do que o limite da busca — apenas os primeiros foram carregados.
              Refine o termo.
            </Text>
          )}

          {(snap.error || subLookup.error || searchResolve.error) && (
            <Alert color="red" title="Erro ao carregar">
              {(snap.error ?? subLookup.error ?? searchResolve.error)?.message}
            </Alert>
          )}

          {(snap.loading || lookupLoading) && (
            <Stack>
              <Skeleton height={36} />
              <Skeleton height={36} />
              <Skeleton height={36} />
            </Stack>
          )}

          {!snap.loading && !lookupLoading && rows && (
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  {selectionEnabled && (
                    <Table.Th style={{ width: 36 }}>
                      <Checkbox
                        aria-label="Selecionar todas as linhas"
                        checked={selected.size > 0 && selected.size === rows.length}
                        indeterminate={selected.size > 0 && selected.size < rows.length}
                        onChange={toggleAll}
                      />
                    </Table.Th>
                  )}
                  {visibleColumns.map((col) => {
                    if (col.kind === 'virtual') {
                      const vc = col.column;
                      const sf = vc.sortField;
                      const f = vc.filter;
                      return (
                        <Table.Th
                          key={vc.key}
                          style={vc.width !== undefined ? { width: vc.width } : undefined}
                        >
                          <Group gap={4} wrap="nowrap" justify="space-between">
                            <Group
                              gap={2}
                              wrap="nowrap"
                              style={
                                sf
                                  ? { cursor: sortable ? 'pointer' : 'default', userSelect: 'none' }
                                  : undefined
                              }
                              onClick={sf ? () => toggleSort(sf) : undefined}
                              title={
                                sf
                                  ? sortable
                                    ? 'Ordenar por esta coluna'
                                    : FORCED_SORT_TITLE
                                  : vc.tooltip
                              }
                            >
                              <span title={vc.tooltip}>{vc.label}</span>
                              {sf && (
                                <SortIndicator
                                  active={displaySort?.field === sf}
                                  direction={displaySort?.direction}
                                />
                              )}
                            </Group>
                            {f &&
                              (f.renderFilter ? (
                                <FilterPopover
                                  active={filters[f.field] !== undefined}
                                  label={f.label ?? vc.label}
                                >
                                  {() =>
                                    f.renderFilter!({
                                      value: filters[f.field],
                                      onChange: (next) => setColumnFilter(f.field, next),
                                    })
                                  }
                                </FilterPopover>
                              ) : (
                                <ColumnFilter
                                  descriptor={{
                                    key: f.field,
                                    kind: f.kind ?? 'string',
                                    label: f.label ?? vc.label,
                                    enumValues: f.options,
                                    dateUnit: f.dateUnit,
                                  }}
                                  value={filters[f.field]}
                                  onChange={(next) => setColumnFilter(f.field, next)}
                                />
                              ))}
                          </Group>
                        </Table.Th>
                      );
                    }
                    const d = col.descriptor;
                    return (
                      <Table.Th key={d.key}>
                        <Group gap={4} wrap="nowrap" justify="space-between">
                          <Group
                            gap={2}
                            wrap="nowrap"
                            style={{
                              cursor: sortable ? 'pointer' : 'default',
                              userSelect: 'none',
                            }}
                            onClick={() => toggleSort(d.key)}
                            title={sortable ? 'Ordenar por esta coluna' : FORCED_SORT_TITLE}
                          >
                            <span>{fieldOverrides[d.key]?.label ?? d.label}</span>
                            <SortIndicator
                              active={displaySort?.field === d.key}
                              direction={displaySort?.direction}
                            />
                          </Group>
                          <ColumnFilter
                            descriptor={d}
                            value={filters[d.key]}
                            onChange={(next) => setColumnFilter(d.key, next)}
                          />
                        </Group>
                      </Table.Th>
                    );
                  })}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.length === 0 && (
                  <Table.Tr>
                    <Table.Td
                      colSpan={visibleColumns.length + (selectionEnabled ? 1 : 0)}
                      align="center"
                    >
                      <Text c="dimmed">Nenhum resultado.</Text>
                    </Table.Td>
                  </Table.Tr>
                )}
                {rows.map((row) => {
                  const href = rowHref ? rowHref(row.id, row.data) : undefined;
                  // `onRowClick` takes precedence over `rowHref` navigation.
                  const clickable = !!row.id && (!!onRowClick || !!href);
                  return (
                    <Table.Tr
                      key={row.id}
                      // Whole row navigates when rowHref is supplied, or invokes
                      // `onRowClick` when that's set instead. <Table> has
                      // `highlightOnHover`, so the row highlights and the cursor
                      // becomes a pointer. Empty `id` (e.g. a pipeline that used
                      // .select() and lost the ref) would generate /collection/''
                      // — skip onClick in that case.
                      //
                      // If the user has an active text selection, treat the click
                      // as a select-and-copy gesture and don't act on it.
                      onClick={
                        clickable
                          ? () => {
                              if (window.getSelection()?.toString()) return;
                              if (onRowClick) onRowClick(row.id, row.data);
                              else if (href) router.push(href);
                            }
                          : undefined
                      }
                      style={clickable ? { cursor: 'pointer' } : undefined}
                    >
                      {selectionEnabled && (
                        <Table.Td onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            aria-label={`Selecionar ${row.id}`}
                            checked={selected.has(row.id)}
                            onChange={() => toggleRow(row.id)}
                          />
                        </Table.Td>
                      )}
                      {visibleColumns.map((col) => {
                        if (col.kind === 'virtual') {
                          return (
                            <Table.Td key={col.column.key}>{col.column.renderCell(row)}</Table.Td>
                          );
                        }
                        const d = col.descriptor;
                        const override = fieldOverrides[d.key];
                        const value = (row.data as Record<string, unknown>)[d.key];
                        const content = override?.renderCell
                          ? override.renderCell(value as never, row.data)
                          : renderCell(value, d);
                        return <Table.Td key={d.key}>{content}</Table.Td>;
                      })}
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          )}

          {/* A full page implies there may be more — offer to grow the window.
              Gauge "page was full" on the *fetched* window (`snap.data`), not
              the post-filter `rows`: client-side column filtering (the fallback
              / queryOverride paths) can shrink `rows` below the limit even when
              the server returned a full page, which would wrongly hide the
              button and strand matches on later pages. The standard heuristic
              over-offers by one click on an exact multiple, which is harmless.
              Hidden entirely under `queryOverride`: that query is caller-owned
              and ignores `effectiveLimit`, so the button couldn't fetch more. */}
          {!snap.loading && !queryOverride && snap.data && snap.data.length === effectiveLimit && (
            <Center>
              <Button variant="subtle" onClick={() => setPages((p) => p + 1)}>
                Carregar mais
              </Button>
            </Center>
          )}
        </Stack>

        {panelEnabled && (
          <ActionSidePanel
            actions={actions}
            selectedRows={selectedRows}
            visibleRows={rows ?? []}
            newHref={newHref}
            renderNewButton={renderNewButton}
            copyHref={copyHref}
            onActionComplete={() => {
              setSelected(new Set());
              setRefreshKey((k) => k + 1);
            }}
            collapsed={panelCollapsed}
            onToggleCollapsed={() => setPanelCollapsed((c) => !c)}
            width={panelWidth}
            extra={renderActionsPanelExtra?.({ collapsed: panelCollapsed })}
          />
        )}
      </Group>
    </Stack>
  );
}

/**
 * Sort arrow shown next to a column title. Filled up/down arrow on the active
 * column; a dimmed neutral icon on the rest to advertise that the header is
 * clickable.
 */
function SortIndicator({ active, direction }: { active: boolean; direction?: 'asc' | 'desc' }) {
  if (!active) {
    return <IconArrowsSort size={14} style={{ opacity: 0.35 }} />;
  }
  return direction === 'desc' ? <IconArrowDown size={14} /> : <IconArrowUp size={14} />;
}
