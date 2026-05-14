'use client';

import { type ReactNode, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert, Checkbox, Group, Skeleton, Stack, Table, Text, Title,
} from '@mantine/core';
import type { Firestore, Query } from 'firebase/firestore';
import type { z, ZodObject, ZodRawShape } from 'zod';
import {
  type CollectionHandle,
  type PathContext,
  buildQuery,
  limit as fsLimit,
  orderByField,
  whereOp,
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
import { ColumnFilter, type ColumnFilterValue } from './ColumnFilter';
import { ColumnPicker } from './ColumnPicker';
import { Pagination } from './Pagination';
import { SearchBar } from './SearchBar';
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
  /** Fields the search bar prefix-matches. Omit to hide search. */
  searchFields?: string[];

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
  orderBy?: { field: string; direction?: 'asc' | 'desc' };

  /**
   * Escape hatch: pass a custom `Query` (e.g. with composite filters the
   * Pipelines wrapper doesn't cover). When set, search/orderBy/pageSize are
   * ignored — the caller owns the query lifecycle.
   */
  queryOverride?: Query<z.infer<S>>;
}

/**
 * Generic TableView. Drives column derivation from the Zod schema, manages
 * search/ColumnPicker/ActionBar state, and subscribes to a Pipeline (or
 * `queryOverride`) for the row source.
 */
export function TableView<S extends ZodObject<ZodRawShape>>({
  title,
  description,
  schema,
  collection,
  db,
  pathContext = {},
  defaultColumns,
  searchFields,
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
  // Initialize once — consumers swap the schema by remounting (key prop).
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(() => {
    if (defaultColumns) return new Set(defaultColumns);
    return new Set(descriptors.filter((d) => d.kind !== 'unknown').map((d) => d.key));
  });

  const router = useRouter();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Per-column filters keyed by field key. AND-combined; cleared by setting
  // the entry to `undefined` (or deleting the key).
  const [filters, setFilters] = useState<Record<string, ColumnFilterValue>>({});

  // filters changes shape per click; bucket it into a deterministic string
  // so the pipeline only rebuilds when content actually changes.
  const filtersSerial = useMemo(() => JSON.stringify(filters), [filters]);

  // --- Data source selection ----------------------------------------------
  // Always use the classic Query path when an override is supplied. Otherwise,
  // try Pipelines first; fall back to buildQuery when unsupported by the SDK.
  const pipeline: Pipeline | null = useMemo(() => {
    if (queryOverride) return null;
    if (!isPipelineSupported(db)) return null;
    try {
      return buildPipeline(db, {
        collection: collection.resolvePath(pathContext),
        search: searchFields?.length
          ? { fields: searchFields, term: search.trim() }
          : undefined,
        filters: Object.entries(filters).map(([field, v]) => ({ field, ...v })),
        // NOTE: do NOT pass `select` here. The Pipelines `.select()` stage
        // produces ad-hoc records and strips `PipelineResult.ref` — the row
        // id we use for `rowHref` navigation becomes undefined and the UI
        // routes to /collection/0, /collection/1 (404). Data-transfer
        // optimization via select() is fine for read-only aggregations; not
        // for listings that need row identity.
        orderBy: orderBy ? [{ field: orderBy.field, direction: orderBy.direction ?? 'asc' }] : undefined,
        limit: pageSize,
      });
    } catch {
      return null;
    }
    // `pathContext` is intentionally not stringified; consumers should keep
    // the object stable across renders (matches the rest of the data layer).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, collection, queryOverride, search, pageSize, orderBy?.field, orderBy?.direction, searchFields?.join('|'), filtersSerial]);

  const fallbackQuery: Query<z.infer<S>> | null = useMemo(() => {
    if (queryOverride) return queryOverride;
    if (pipeline) return null;
    const base = collection.ref(db, pathContext);
    const constraints = [];
    const sortField = orderBy?.field ?? searchFields?.[0];
    if (sortField) constraints.push(orderByField(sortField, orderBy?.direction ?? 'asc'));
    const trimmed = search.trim();
    if (trimmed && searchFields?.length) {
      // Prefix-match on the first search field. Multi-field OR isn't
      // expressible in a single classic Query — when the user opts into the
      // fallback path (e.g. older SDK), single-field prefix is the lcd.
      constraints.push(whereOp(searchFields[0]!, '>=', trimmed));
      constraints.push(whereOp(searchFields[0]!, '<=', `${trimmed}`));
    }
    constraints.push(fsLimit(pageSize));
    return buildQuery(base, constraints);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, collection, queryOverride, pipeline, search, pageSize, orderBy?.field, orderBy?.direction, searchFields?.join('|')]);

  const fromPipeline = usePipelineSnapshot<z.infer<S>>(pipeline);
  const fromQuery = useSnapshot<z.infer<S>>(fallbackQuery);
  const snap: SnapshotState<SnapshotRow<z.infer<S>>[]> = pipeline ? fromPipeline : fromQuery;

  const visibleDescriptors = useMemo(
    () => descriptors.filter((d) => visibleKeys.has(d.key) && !fieldOverrides[d.key]?.hidden),
    [descriptors, visibleKeys, fieldOverrides],
  );

  function toggleColumn(key: string) {
    setVisibleKeys((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
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

      <Group justify="space-between" wrap="nowrap" align="flex-end">
        {searchFields?.length ? (
          <SearchBar onChange={setSearch} placeholder="Buscar…" />
        ) : <span />}
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
                    <span>{fieldOverrides[d.key]?.label ?? d.label}</span>
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
                  // Whole row navigates when rowHref is supplied. <Table> at
                  // line 264 already enables `highlightOnHover`, so the row
                  // visibly highlights and the cursor becomes pointer.
                  // Empty `id` (e.g. pipeline used .select() and lost ref)
                  // would generate /collection/'' — skip onClick in that case.
                  onClick={href && row.id ? () => router.push(href) : undefined}
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
