'use client';

import { useCallback, useMemo, useState } from 'react';
import { Pill, PillsInput, Select, Stack, Text, type ComboboxData } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import type { WhereFilterOp } from 'firebase/firestore';
import type { ZodObject, ZodRawShape, z } from 'zod';
import {
  type CollectionHandle,
  type PipelineFieldFilter,
  PipelineUnsupportedError,
  buildPipeline,
  buildQuery,
  isPipelineSupported,
  limit as limitConstraint,
  orderByField,
  whereOp,
} from '@delfrance/data';
import { useDocSnapshot, usePipelineSnapshot, useSnapshot } from '@delfrance/data/hooks';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useRecentSelections } from './useRecentSelections';

const DEFAULT_LIMIT = 15;
const SEARCH_DEBOUNCE_MS = 250;
/** Firestore prefix-range upper sentinel — sorts above any string with the prefix. */
const PREFIX_MAX = String.fromCharCode(0xffff);

export interface CollectionSelectProps<S extends ZodObject<ZodRawShape>> {
  collection: CollectionHandle<S>;
  /** Field on the referenced doc used as the visible label (e.g. `nome`). */
  labelField: string;
  /** Doc fields a typed term is matched against. Defaults to `[labelField]`. */
  searchFields?: string[];
  /** RHF field path — makes the per-instance recents cache key unique. */
  fieldName: string;
  /** Current form value — DocumentReference, `{path}` object, doc-path/id string, or null. */
  value: unknown;
  /** Emits a `documents/<col>/<id>` doc-path string, or null when cleared. */
  onChange: (next: unknown) => void;
  onBlur?: () => void;
  label: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  /** Firestore query cap. Default 15. */
  limit?: number;
  /**
   * Ordering for the option list (initial AND searched), pipeline path only.
   * Defaults to `[{ field: labelField, direction: 'asc' }]`. Multi-key sorts
   * are supported (e.g. recency: `ultimaModificacao desc, timestamp desc` —
   * pipeline sorts treat a missing field as null instead of excluding the
   * doc). The non-pipeline fallback keeps the labelField-asc prefix query —
   * classic `orderBy` on a possibly-missing field would silently EXCLUDE
   * legacy docs, and pipelines are the supported path on Firestore
   * Enterprise anyway.
   */
  orderBy?: ReadonlyArray<{ field: string; direction?: 'asc' | 'desc' }>;
  /**
   * Doc field rendered as a dimmed second line under each option label
   * (e.g. `cpf_cnpj` on a cliente). Query-result options only — "Recentes"
   * entries cache just the label.
   */
  optionHintField?: string;
  /**
   * Per-field equality/comparison filters AND-combined onto the option query
   * (e.g. exclude kits with `[{ field: 'ehKit', op: 'eq', value: false }]`).
   * Applied to BOTH query paths. NB the comparison drops docs where the field
   * is null/absent (Firestore equality semantics), and the "Recentes" group is
   * NOT filtered — callers that must hard-exclude a value should also guard on
   * select. The pipeline path supports all ops; the non-pipeline fallback
   * supports only the comparison ops (`eq`/`lt`/`lte`/`gt`/`gte`).
   */
  filters?: PipelineFieldFilter[];
  /**
   * Doc ids to hide from the option list AND the "Recentes" group (e.g. a kit's
   * own produto + its variations, which can't be its own components). Filtered
   * client-side after the query, so the visible list may show a few fewer than
   * `limit` rows.
   */
  excludeIds?: string[];
}

/** Fallback-query operator for each comparison filter op (substring ops are pipeline-only). */
const FALLBACK_FILTER_OP: Partial<Record<PipelineFieldFilter['op'], WhereFilterOp>> = {
  eq: '==',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
};

/**
 * Convert whatever the form holds (Firestore DocumentReference, opaque
 * `{path}` object, doc-path string — possibly Flutter-ODM `documents/...`
 * prefixed — plain id string, or null) into the doc id Mantine's `<Select>`
 * consumes. Anything unrecognised becomes `null`.
 */
function valueToId(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    if (value.length === 0) return null;
    const segs = value.split('/').filter(Boolean);
    return segs[segs.length - 1] ?? null;
  }
  if (typeof value !== 'object') return null;
  const v = value as { id?: unknown; path?: unknown };
  if (typeof v.id === 'string' && v.id.length > 0) return v.id;
  if (typeof v.path === 'string' && v.path.length > 0) {
    const segs = v.path.split('/');
    return segs[segs.length - 1] ?? null;
  }
  return null;
}

/** Read a string-typed field off a Firestore doc payload. */
function readLabelField(data: unknown, labelField: string): string | undefined {
  if (data == null || typeof data !== 'object') return undefined;
  const v = (data as Record<string, unknown>)[labelField];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Mantine `<Select>` bound to a Firestore collection.
 *
 *  - Loads at most `limit` (default 15) docs, ordered by `labelField`.
 *  - Pipeline-backed search: a typed term is matched (case/accent-insensitive
 *    substring) against `searchFields` via the Firestore Pipeline API; falls
 *    back to a single-field prefix query when pipelines are unavailable.
 *  - Lock-after-select: once a value is set the field renders as a removable
 *    chip; clearing the chip returns it to the searchable state.
 *  - Remembers the last 5 picks per instance in localStorage (24h TTL) and
 *    surfaces them in a "Recentes" group.
 *
 * On change it emits a `documents/<col>/<id>` doc-path string; on load it
 * normalises a stored `DocumentReference` / `{path}` / id-string back to the
 * doc id (legacy reads stay tolerant).
 */
export function CollectionSelect<S extends ZodObject<ZodRawShape>>({
  collection,
  labelField,
  searchFields,
  fieldName,
  value,
  onChange,
  onBlur,
  label,
  hint,
  required,
  disabled,
  error,
  limit = DEFAULT_LIMIT,
  orderBy,
  optionHintField,
  filters,
  excludeIds,
}: CollectionSelectProps<S>) {
  const db = getFirebaseFirestore();

  const selectedId = valueToId(value);
  const locked = selectedId !== null;

  // One recents cache per (collection, field). `resolvePath({})` is safe —
  // every collection wired to this component is placeholder-free.
  const cacheKey = `delfrance:collectionselect:recents:${collection.resolvePath({})}:${fieldName}`;
  const { recents, record } = useRecentSelections(cacheKey);

  const [searchValue, setSearchValue] = useState('');
  const [debounced] = useDebouncedValue(searchValue, SEARCH_DEBOUNCE_MS);
  // While locked the dropdown is closed — ignore the search term so a stale
  // value can't fire a phantom query.
  const term = locked ? '' : debounced.trim();

  // Value-stable keys for the array props so the query memos below don't
  // rebuild (and re-query) on every render.
  const searchFieldsKey = (searchFields ?? [labelField]).join('|');
  const orderByKey = JSON.stringify(orderBy ?? [{ field: labelField, direction: 'asc' }]);
  const filtersKey = JSON.stringify(filters ?? []);
  const excludeKey = (excludeIds ?? []).join('|');
  const excludeSet = useMemo(() => new Set(excludeKey ? excludeKey.split('|') : []), [excludeKey]);

  // Primary source: the Firestore Pipeline API — a typed term is matched
  // (case/accent-insensitive substring) against every `searchFields` entry,
  // OR-combined. Runs fully client-side.
  const pipeline = useMemo(() => {
    if (locked) return null;
    if (!isPipelineSupported(db)) return null;
    try {
      const parsedFilters = JSON.parse(filtersKey) as PipelineFieldFilter[];
      return buildPipeline(db, {
        collection: collection.resolvePath({}),
        ...(term !== '' ? { search: { fields: searchFieldsKey.split('|'), term } } : {}),
        ...(parsedFilters.length > 0 ? { filters: parsedFilters } : {}),
        orderBy: JSON.parse(orderByKey) as Array<{ field: string; direction?: 'asc' | 'desc' }>,
        limit,
      });
    } catch (err) {
      if (err instanceof PipelineUnsupportedError) return null;
      throw err;
    }
  }, [db, collection, locked, term, searchFieldsKey, orderByKey, filtersKey, limit]);

  // Fallback when the SDK lacks the Pipeline API: a single-field Firestore
  // prefix-range query — substring / multi-field search is pipeline-only.
  const fallbackQuery = useMemo(() => {
    if (pipeline || locked) return null;
    const constraints = [orderByField(labelField, 'asc')];
    for (const f of JSON.parse(filtersKey) as PipelineFieldFilter[]) {
      const op = FALLBACK_FILTER_OP[f.op];
      if (op) constraints.push(whereOp(f.field, op, f.value));
    }
    if (term !== '') {
      constraints.push(whereOp(labelField, '>=', term));
      constraints.push(whereOp(labelField, '<=', `${term}${PREFIX_MAX}`));
    }
    constraints.push(limitConstraint(limit));
    return buildQuery(collection.ref(db, {}), constraints);
  }, [db, collection, pipeline, locked, labelField, term, filtersKey, limit]);

  // Pipelines are one-shot — each debounced term re-executes; the fallback
  // path stays real-time. Both hooks run every render (Rules of Hooks); only
  // the active one receives a non-null argument.
  const fromPipeline = usePipelineSnapshot<z.infer<S>>(pipeline);
  const fromQuery = useSnapshot<z.infer<S>>(fallbackQuery);
  const listData = (pipeline ? fromPipeline : fromQuery).data;

  // The saved value may point to a doc outside the limited list — fetch it
  // directly so its label still renders.
  const selectedRef = useMemo(() => dereferenceOuterRef(db, value), [db, value]);
  const { data: selectedDoc } = useDocSnapshot(selectedRef);

  const selectedLabel =
    readLabelField(selectedDoc?.data, labelField) ??
    recents.find((r) => r.id === selectedId)?.label ??
    selectedId ??
    '';

  const resultItems = useMemo(
    () =>
      (listData ?? [])
        .filter((row) => !excludeSet.has(row.id))
        .map((row) => ({
          value: row.id,
          label: readLabelField(row.data, labelField) ?? row.id,
        })),
    [listData, labelField, excludeSet],
  );

  // id → hint lookup for renderOption (recents entries carry no hint).
  const optionHints = useMemo(() => {
    if (!optionHintField) return null;
    const hints: Record<string, string> = {};
    for (const row of listData ?? []) {
      const hintValue = readLabelField(row.data, optionHintField);
      if (hintValue) hints[row.id] = hintValue;
    }
    return hints;
  }, [listData, optionHintField]);

  const data: ComboboxData = useMemo(() => {
    if (term !== '') {
      return resultItems;
    }
    // "Recentes" is a localStorage cache (not query-filtered) — apply excludeIds here.
    const visibleRecents = recents.filter((r) => !excludeSet.has(r.id));
    const recentIds = new Set(visibleRecents.map((r) => r.id));
    const todos = resultItems.filter((o) => !recentIds.has(o.value));
    return [
      ...(visibleRecents.length > 0
        ? [
            {
              group: 'Recentes',
              items: visibleRecents.map((r) => ({ value: r.id, label: r.label })),
            },
          ]
        : []),
      ...(todos.length > 0 ? [{ group: 'Todos', items: todos }] : []),
    ];
  }, [term, resultItems, recents, excludeSet]);

  const handleChange = useCallback(
    (id: string | null) => {
      if (!id) {
        setSearchValue('');
        onChange(null);
        return;
      }
      const picked = resultItems.find((o) => o.value === id) ?? recents.find((r) => r.id === id);
      record(id, picked?.label ?? id);
      onChange(`documents/${collection.resolvePath({})}/${id}`);
    },
    [onChange, resultItems, recents, record, collection],
  );

  // Locked: the value renders as a removable chip inside a field-shaped
  // container — visibly "set & locked" until the user clears it.
  if (locked && selectedId) {
    return (
      <PillsInput
        label={label}
        description={hint}
        required={required}
        error={error}
        disabled={disabled}
      >
        <Pill.Group>
          <Pill
            withRemoveButton={!disabled}
            disabled={disabled}
            removeButtonProps={{ 'aria-label': 'Limpar' }}
            onRemove={() => handleChange(null)}
          >
            {selectedLabel}
          </Pill>
        </Pill.Group>
      </PillsInput>
    );
  }

  return (
    <Select
      label={label}
      description={hint}
      data={data}
      value={selectedId}
      onChange={handleChange}
      onBlur={onBlur}
      required={required}
      disabled={disabled}
      error={error}
      searchable
      searchValue={searchValue}
      onSearchChange={setSearchValue}
      filter={({ options }) => options}
      placeholder={listData === undefined ? 'Carregando…' : undefined}
      nothingFoundMessage="Nenhum registro"
      renderOption={
        optionHints
          ? ({ option }) => (
              <Stack gap={0}>
                <Text size="sm">{option.label}</Text>
                {optionHints[option.value] && (
                  <Text size="xs" c="dimmed">
                    {optionHints[option.value]}
                  </Text>
                )}
              </Stack>
            )
          : undefined
      }
    />
  );
}
