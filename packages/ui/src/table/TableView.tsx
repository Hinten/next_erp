'use client';

import { type ReactNode, useEffect, useMemo, useState } from 'react';
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
import { useCollectionMonitor } from './useCollectionMonitor';
import { IconArrowDown, IconArrowsSort, IconArrowUp, IconRefreshAlert } from '@tabler/icons-react';
import { ColumnFilter, FilterPopover } from './ColumnFilter';
import { ColumnPicker } from './ColumnPicker';
import { applyColumnFilters } from './filterRows';
import {
  type SortState,
  parseFiltersFromParams,
  parseSortFromParams,
  useTableUrlState,
} from './useTableUrlState';
import { renderCell } from './cell-renderers';

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
   * the schema first, then against `virtualColumns`. Omit to show every
   * non-`unknown` schema field (in schema order) followed by every
   * virtual column.
   */
  defaultColumns?: string[];

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
   * collection in localStorage.
   */
  actionsPanel?: boolean | { defaultCollapsed?: boolean };
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
  orderBy,
  extraFilters,
  queryOverride,
  actionsPanel,
}: TableViewProps<S>) {
  // Derive once per schema identity.
  const descriptors = useMemo(() => extractFieldsFromSchema(schema), [schema]);

  const defaultQuery = meta?.defaultQuery;
  // pageSize prop wins, then the declared default, then 50.
  const resolvedPageSize = pageSize ?? defaultQuery?.limit ?? 50;

  // Columns visible by default: caller-supplied keys, or every non-unknown
  // schema field (drops embeddings and other opaque blobs automatically)
  // followed by every virtual column.
  const defaultVisibleKeys = useMemo<string[]>(
    () =>
      defaultColumns ?? [
        ...descriptors.filter((d) => d.kind !== 'unknown').map((d) => d.key),
        ...virtualColumns.map((v) => v.key),
      ],
    [defaultColumns, descriptors, virtualColumns],
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
  const [visibleKeysArr, setVisibleKeysArr] = useLocalStorage<string[]>({
    key: columnsStorageKey,
    defaultValue: defaultVisibleKeys,
  });

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

  const visibleKeys = useMemo(() => new Set(visibleKeysArr), [visibleKeysArr]);

  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Bumped by the update-monitor's "Atualizar" button to force the row query
  // to re-execute (the Pipelines path is one-shot — see `pipeline` below).
  const [refreshKey, setRefreshKey] = useState(0);
  // "Carregar mais": grows the query limit by `resolvedPageSize` per click.
  // Each bump re-reads the whole window (the one-shot pipeline has no cursor) —
  // fine for admin lists; true cursor pagination is deliberately deferred.
  const [pages, setPages] = useState(1);
  const effectiveLimit = resolvedPageSize * pages;

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

  // URL-synced per-column filters + sort (hydrated from the query string,
  // mirrored back via history.replaceState). `orderBy` is the initial-sort
  // fallback when the URL carries none.
  const { filters, setFilters, filtersSerial, sort, setSort } = useTableUrlState(
    filterableFields,
    orderBy,
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
  const lookupLoading = lookupActive && subLookup.loading;
  // Resolved to zero matches → no rows; don't build a whole-collection query.
  const lookupEmpty = lookupActive && Array.isArray(subLookup.ids) && subLookup.ids.length === 0;
  const idIn = lookupActive ? (subLookup.ids ?? undefined) : undefined;
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
  const extraFiltersSerial = useMemo(() => JSON.stringify(extraFilters ?? null), [extraFilters]);
  const extraEmpty =
    !queryOverride &&
    (extraFilters ?? []).some(
      (f) => f.op === 'array-contains-any' && Array.isArray(f.value) && f.value.length === 0,
    );

  // Sort actually issued to Firestore: an explicit user/prop sort wins;
  // otherwise the declared default `orderBy` (full array — supports multi-key
  // defaults and matches the declared composite index).
  const effectiveOrderBy = useMemo<PipelineOrderSpec[] | undefined>(() => {
    if (sort) return [{ field: sort.field, direction: sort.direction }];
    if (defaultQuery?.orderBy?.length) {
      return defaultQuery.orderBy.map((o) => ({ field: o.field, direction: o.direction }));
    }
    return undefined;
  }, [sort?.field, sort?.direction, defaultQuery]);
  // Column the header arrow points at when the user hasn't sorted yet.
  const displaySort: SortState | undefined =
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
  function toggleSort(fieldKey: string) {
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
          ...(extraFilters ?? []),
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
    // A subcollection lookup resolves via `idIn` (pipeline-only). On the classic
    // fallback we can't honor it, so render nothing rather than the whole list.
    if (lookupActive) return null;
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
    for (const f of extraFilters ?? []) {
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
  useEffect(() => {
    setPages(1);
  }, [
    filtersSerial,
    baseFiltersSerial,
    extraFiltersSerial,
    queryParamsSerial,
    sort?.field,
    sort?.direction,
  ]);

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
              <ColumnPicker
                fields={[
                  ...descriptors
                    .filter((d) => d.kind !== 'unknown')
                    .map((d) => ({ key: d.key, label: d.label })),
                  ...virtualColumns.map((v) => ({ key: v.key, label: v.label })),
                ]}
                visibleKeys={visibleKeys}
                onToggle={toggleColumn}
                order={visibleKeysArr}
                onReorder={reorderColumns}
              />
              {!panelEnabled && (actions.length > 0 || newHref || renderNewButton || copyHref) && (
                <ActionBar
                  actions={actions}
                  selectedRows={selectedRows}
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

          {(snap.error || subLookup.error) && (
            <Alert color="red" title="Erro ao carregar">
              {(snap.error ?? subLookup.error)?.message}
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
                              style={sf ? { cursor: 'pointer', userSelect: 'none' } : undefined}
                              onClick={sf ? () => toggleSort(sf) : undefined}
                              title={sf ? 'Ordenar por esta coluna' : vc.tooltip}
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
                            style={{ cursor: 'pointer', userSelect: 'none' }}
                            onClick={() => toggleSort(d.key)}
                            title="Ordenar por esta coluna"
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
            newHref={newHref}
            renderNewButton={renderNewButton}
            copyHref={copyHref}
            onActionComplete={() => {
              setSelected(new Set());
              setRefreshKey((k) => k + 1);
            }}
            collapsed={panelCollapsed}
            onToggleCollapsed={() => setPanelCollapsed((c) => !c)}
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
