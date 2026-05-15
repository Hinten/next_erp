'use client';

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLocalStorage } from '@mantine/hooks';
import {
  Alert, Checkbox, Group, Skeleton, Stack, Table, Text, Title,
} from '@mantine/core';
import type { Firestore, Query } from 'firebase/firestore';
import type { z, ZodObject, ZodRawShape } from 'zod';
import {
  type CollectionHandle,
  type PathContext,
  type PipelineFilterOp,
  buildQuery,
  limit as fsLimit,
  orderByField,
} from '@delfrance/data';
import {
  type SnapshotRow,
  type SnapshotState,
  useSnapshot,
} from '@delfrance/data/hooks';
import { usePipelineSnapshot } from '@delfrance/data/hooks/usePipelineSnapshot';
import {
  type Pipeline,
  buildPipeline,
  isPipelineSupported,
} from '@delfrance/data/pipeline-queries';
import { extractFieldsFromSchema } from '../schema/derive';
import type {
  ActionConfig, FieldConfig, FieldDescriptor,
} from '../schema/types';
import { ActionBar } from './ActionBar';
import { IconArrowDown, IconArrowsSort, IconArrowUp } from '@tabler/icons-react';
import { ColumnFilter, type ColumnFilterValue } from './ColumnFilter';
import { ColumnPicker } from './ColumnPicker';
import { Pagination } from './Pagination';
import { renderCell } from './cell-renderers';

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

  /** Default visible columns. Omit to show every non-`unknown` field. */
  defaultColumns?: string[];

  /** Per-field overrides keyed by field key. */
  fields?: Record<string, FieldConfig>;

  actions?: Array<ActionConfig<z.infer<S>>>;
  selectable?: boolean;

  /** Click-through target for each row. */
  rowHref?: (id: string, row: z.infer<S>) => string;
  /** Optional "Novo" link rendered in the ActionBar. */
  newHref?: string;
  /**
   * Render-prop alternative to `newHref` — typical Next.js usage passes a
   * `<Button component={Link} href="/x/novo">` instance.
   */
  renderNewButton?: () => ReactNode;
  /** Optional rich row-link renderer (defaults to plain <a>). */
  renderRowLink?: (href: string, content: ReactNode) => ReactNode;

  pageSize?: number;
  /** Initial sort. The user can change it by clicking column headers. */
  orderBy?: { field: string; direction?: 'asc' | 'desc' };

  /**
   * Escape hatch: pass a custom `Query` (e.g. with composite filters the
   * Pipelines wrapper doesn't cover). When set, search/orderBy/pageSize are
   * ignored — the caller owns the query lifecycle.
   */
  queryOverride?: Query<z.infer<S>>;
}

type SortState = { field: string; direction: 'asc' | 'desc' };

const FILTER_OPS = new Set<PipelineFilterOp>([
  'contains', 'startsWith', 'eq', 'lt', 'lte', 'gt', 'gte',
]);

/**
 * Pipelines have no realtime listener (`usePipelineSnapshot` is one-shot), so
 * a row written after the initial fetch never surfaces on its own. Re-run the
 * query on this interval so the list stays current — e.g. a record created on
 * a "novo" page shows up once the user navigates back to the list.
 */
const PIPELINE_REFETCH_MS = 5_000;

/**
 * Parse `?<field>=<op>:<value>` query params into the `filters` state. The
 * value is coerced by the field's `kind` (boolean / number / string). Params
 * that don't map to a known descriptor, or carry an unknown op, are skipped.
 */
export function parseFiltersFromParams(
  params: URLSearchParams,
  descriptors: FieldDescriptor[],
): Record<string, ColumnFilterValue> {
  const byKey = new Map(descriptors.map((d) => [d.key, d]));
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
    if (descriptor.kind === 'boolean') {
      value = rawValue === 'true';
    } else if (
      descriptor.kind === 'number' ||
      descriptor.kind === 'integer' ||
      descriptor.kind === 'currency'
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
  actions = [],
  selectable = false,
  rowHref,
  newHref,
  renderNewButton,
  renderRowLink,
  pageSize = 50,
  orderBy,
  queryOverride,
}: TableViewProps<S>) {
  // Derive once per schema identity.
  const descriptors = useMemo(() => extractFieldsFromSchema(schema), [schema]);

  // Columns visible by default: caller-supplied keys, or every non-unknown
  // field (drops embeddings and other opaque blobs automatically).
  const defaultVisibleKeys = useMemo<string[]>(
    () =>
      defaultColumns ??
      descriptors.filter((d) => d.kind !== 'unknown').map((d) => d.key),
    [defaultColumns, descriptors],
  );

  // Storage key is per-collection so /clientes and /categorias never
  // collide. resolvePath('clientes') → 'clientes'; for subcollections it
  // includes the parent ids, giving per-parent column prefs.
  const columnsStorageKey = useMemo(
    () => `delfrance:tableview:columns:${collection.resolvePath(pathContext)}`,
    // pathContext is identity-tracked like the rest of the data layer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collection],
  );

  // Persisted visible columns. `useLocalStorage` returns defaultValue on
  // the server + first client render, then reads localStorage in an effect
  // (getInitialValueInEffect default) — no hydration mismatch.
  const [visibleKeysArr, setVisibleKeysArr] = useLocalStorage<string[]>({
    key: columnsStorageKey,
    defaultValue: defaultVisibleKeys,
  });

  const visibleKeys = useMemo(() => new Set(visibleKeysArr), [visibleKeysArr]);

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Per-column filters keyed by field key. AND-combined; cleared by setting
  // the entry to `undefined` (or deleting the key). Hydrated once from the
  // URL query string so a shared/bookmarked link reopens filtered.
  const [filters, setFilters] = useState<Record<string, ColumnFilterValue>>(
    () => parseFiltersFromParams(searchParams, descriptors),
  );
  // Active sort. Seeded from the URL, then the `orderBy` prop; the user
  // changes it by clicking column headers.
  const [sort, setSort] = useState<SortState | undefined>(
    () =>
      parseSortFromParams(searchParams) ??
      (orderBy ? { field: orderBy.field, direction: orderBy.direction ?? 'asc' } : undefined),
  );

  // filters changes shape per click; bucket it into a deterministic string
  // so the pipeline only rebuilds when content actually changes.
  const filtersSerial = useMemo(() => JSON.stringify(filters), [filters]);
  // Deterministic key for the visible-column set. Toggling a column in the
  // ColumnPicker changes this, which re-runs the `pipeline` useMemo → new
  // Pipeline with the new `select` → the query re-executes.
  const visibleKeysSerial = useMemo(
    () => [...visibleKeys].sort().join('|'),
    [visibleKeys],
  );

  // Mirror filters + sort into the URL query string (replace — no history
  // spam; the URL stays shareable). Hydration above is one-shot, so there's
  // no read-back loop.
  useEffect(() => {
    const params = new URLSearchParams();
    for (const [field, v] of Object.entries(filters)) {
      params.set(field, `${v.op}:${String(v.value)}`);
    }
    if (sort) params.set('sort', `${sort.field}:${sort.direction}`);
    const qs = params.toString();
    const next = qs ? `${pathname}?${qs}` : pathname;
    if (next !== `${pathname}${window.location.search}`) {
      router.replace(next, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersSerial, sort?.field, sort?.direction, pathname]);

  // Clicking a header cycles that column's sort: a different column starts
  // ascending; the active column flips asc ⇄ desc.
  function toggleSort(fieldKey: string) {
    setSort((cur) =>
      cur?.field === fieldKey
        ? { field: fieldKey, direction: cur.direction === 'asc' ? 'desc' : 'asc' }
        : { field: fieldKey, direction: 'asc' },
    );
  }

  // --- Data source selection ----------------------------------------------
  // Always use the classic Query path when an override is supplied. Otherwise,
  // try Pipelines first; fall back to buildQuery when unsupported by the SDK.
  const pipeline: Pipeline | null = useMemo(() => {
    if (queryOverride) return null;
    if (!isPipelineSupported(db)) return null;
    try {
      return buildPipeline(db, {
        collection: collection.resolvePath(pathContext),
        filters: Object.entries(filters).map(([field, v]) => ({ field, ...v })),
        // Project only the visible columns to cut data transfer (skips the
        // heavy embedding fields). `buildPipeline` appends the document-id
        // projection so row identity survives `.select()` — see
        // PIPELINE_ID_FIELD. `visibleKeysSerial` is in the deps below so
        // toggling a column re-executes the query with the new field set.
        select: [...visibleKeys],
        orderBy: sort ? [{ field: sort.field, direction: sort.direction }] : undefined,
        limit: pageSize,
      });
    } catch {
      return null;
    }
    // `pathContext` is intentionally not stringified; consumers should keep
    // the object stable across renders (matches the rest of the data layer).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, collection, queryOverride, pageSize, sort?.field, sort?.direction, filtersSerial, visibleKeysSerial]);

  const fallbackQuery: Query<z.infer<S>> | null = useMemo(() => {
    if (queryOverride) return queryOverride;
    if (pipeline) return null;
    const base = collection.ref(db, pathContext);
    const constraints = [];
    if (sort) constraints.push(orderByField(sort.field, sort.direction));
    constraints.push(fsLimit(pageSize));
    return buildQuery(base, constraints);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, collection, queryOverride, pipeline, pageSize, sort?.field, sort?.direction]);

  const fromPipeline = usePipelineSnapshot<z.infer<S>>(pipeline, {
    refetchInterval: PIPELINE_REFETCH_MS,
  });
  const fromQuery = useSnapshot<z.infer<S>>(fallbackQuery);
  const snap: SnapshotState<SnapshotRow<z.infer<S>>[]> = pipeline ? fromPipeline : fromQuery;

  const visibleDescriptors = useMemo(
    () => descriptors.filter((d) => visibleKeys.has(d.key) && !fieldOverrides[d.key]?.hidden),
    [descriptors, visibleKeys, fieldOverrides],
  );

  function toggleColumn(key: string) {
    setVisibleKeysArr((cur) => {
      const set = new Set(cur);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      return [...set];
    });
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
    if (!snap.data) return;
    setSelected((cur) =>
      cur.size === snap.data!.length ? new Set() : new Set(snap.data!.map((r) => r.id)),
    );
  }

  const selectedRows = useMemo(
    () => (snap.data ?? []).filter((r) => selected.has(r.id)),
    [snap.data, selected],
  );

  return (
    <Stack>
      {(title || description) && (
        <Stack gap={2}>
          {title && (typeof title === 'string' ? <Title order={2}>{title}</Title> : title)}
          {description && <Text c="dimmed" size="sm">{description}</Text>}
        </Stack>
      )}

      <Group justify="flex-end" wrap="nowrap" align="flex-end">
        <Group gap="xs">
          <ColumnPicker
            fields={descriptors.filter((d) => d.kind !== 'unknown')}
            visibleKeys={visibleKeys}
            onToggle={toggleColumn}
          />
          {(actions.length > 0 || newHref || renderNewButton) && (
            <ActionBar
              actions={actions}
              selectedRows={selectedRows}
              newHref={newHref}
              renderNewButton={renderNewButton}
            />
          )}
        </Group>
      </Group>

      {snap.error && (
        <Alert color="red" title="Erro ao carregar">
          {snap.error.message}
        </Alert>
      )}

      {snap.loading && (
        <Stack>
          <Skeleton height={36} />
          <Skeleton height={36} />
          <Skeleton height={36} />
        </Stack>
      )}

      {!snap.loading && snap.data && (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              {selectable && (
                <Table.Th style={{ width: 36 }}>
                  <Checkbox
                    aria-label="Selecionar todas as linhas"
                    checked={selected.size > 0 && selected.size === snap.data.length}
                    indeterminate={selected.size > 0 && selected.size < snap.data.length}
                    onChange={toggleAll}
                  />
                </Table.Th>
              )}
              {visibleDescriptors.map((d) => (
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
                        active={sort?.field === d.key}
                        direction={sort?.direction}
                      />
                    </Group>
                    <ColumnFilter
                      descriptor={d}
                      value={filters[d.key]}
                      onChange={(next) =>
                        setFilters((cur) => {
                          const copy = { ...cur };
                          if (next === undefined) delete copy[d.key];
                          else copy[d.key] = next;
                          return copy;
                        })
                      }
                    />
                  </Group>
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {snap.data.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={visibleDescriptors.length + (selectable ? 1 : 0)} align="center">
                  <Text c="dimmed">Nenhum resultado.</Text>
                </Table.Td>
              </Table.Tr>
            )}
            {snap.data.map((row) => {
              const href = rowHref ? rowHref(row.id, row.data) : undefined;
              return (
                <Table.Tr
                  key={row.id}
                  // Whole row navigates when rowHref is supplied. <Table> has
                  // `highlightOnHover`, so the row highlights and the cursor
                  // becomes a pointer. Empty `id` (e.g. a pipeline that used
                  // .select() and lost the ref) would generate /collection/''
                  // — skip onClick in that case.
                  //
                  // If the user has an active text selection, treat the click
                  // as a select-and-copy gesture and don't navigate.
                  onClick={
                    href && row.id
                      ? () => {
                          if (window.getSelection()?.toString()) return;
                          router.push(href);
                        }
                      : undefined
                  }
                  style={href && row.id ? { cursor: 'pointer' } : undefined}
                >
                  {selectable && (
                    <Table.Td onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        aria-label={`Selecionar ${row.id}`}
                        checked={selected.has(row.id)}
                        onChange={() => toggleRow(row.id)}
                      />
                    </Table.Td>
                  )}
                  {visibleDescriptors.map((d) => {
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

      {/*
        Cursor-based pagination is wired into the Pipelines layer next iter;
        the buttons are surfaced now so the visual contract is in place.
      */}
      <Pagination
        canGoPrev={false}
        canGoNext={!!snap.data && snap.data.length >= pageSize}
        onPrev={() => {}}
        onNext={() => {}}
      />
    </Stack>
  );
}

/**
 * Sort arrow shown next to a column title. Filled up/down arrow on the active
 * column; a dimmed neutral icon on the rest to advertise that the header is
 * clickable.
 */
function SortIndicator({
  active,
  direction,
}: {
  active: boolean;
  direction?: 'asc' | 'desc';
}) {
  if (!active) {
    return <IconArrowsSort size={14} style={{ opacity: 0.35 }} />;
  }
  return direction === 'desc' ? (
    <IconArrowDown size={14} />
  ) : (
    <IconArrowUp size={14} />
  );
}
