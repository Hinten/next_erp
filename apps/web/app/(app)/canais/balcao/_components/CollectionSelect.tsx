'use client';

import { useCallback, useMemo, useState } from 'react';
import { Select, type ComboboxData } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import type { ZodObject, ZodRawShape, z } from 'zod';
import {
  type CollectionHandle,
  buildQuery,
  limit as limitConstraint,
  orderByField,
  whereOp,
} from '@delfrance/data';
import { useDocSnapshot, useSnapshot } from '@delfrance/data/hooks';
import { NullClearButton } from '@delfrance/ui';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useRecentSelections } from './useRecentSelections';

const DEFAULT_LIMIT = 15;
const SEARCH_DEBOUNCE_MS = 250;
/** Firestore prefix-range upper sentinel — sorts above any string with the prefix. */
const PREFIX_MAX = '';

export interface CollectionSelectProps<S extends ZodObject<ZodRawShape>> {
  collection: CollectionHandle<S>;
  /** Field on the referenced doc used as the visible label (e.g. `nome`). */
  labelField: string;
  /** RHF field path — makes the per-instance recents cache key unique. */
  fieldName: string;
  /** Current form value — DocumentReference, `{path}`-shaped object, id string, or null. */
  value: unknown;
  /** Emits a fresh DocumentReference for the picked id, or null when cleared. */
  onChange: (next: unknown) => void;
  onBlur?: () => void;
  label: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  /** Firestore query cap. Default 15. */
  limit?: number;
}

/**
 * Convert whatever the form holds (Firestore DocumentReference, opaque
 * `{path}` object, plain id string, or null) into the doc id Mantine's
 * `<Select>` consumes. Anything unrecognised becomes `null`.
 */
function valueToId(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
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
 *  - Server-side prefix search: typing re-queries Firestore so any doc is
 *    findable regardless of collection size.
 *  - Lock-after-select: once a value is set the field is read-only; the user
 *    must clear it (✕) to pick again.
 *  - Remembers the last 5 picks per instance in localStorage (24h TTL) and
 *    surfaces them in a "Recentes" group.
 *
 * On change it emits a `DocumentReference`; on load it normalises a stored
 * `DocumentReference` / `{path}` / id-string back to the doc id.
 */
export function CollectionSelect<S extends ZodObject<ZodRawShape>>({
  collection,
  labelField,
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
}: CollectionSelectProps<S>) {
  const db = getFirebaseFirestore();

  const selectedId = valueToId(value);
  const locked = selectedId !== null;

  // One recents cache per (collection, field). `resolvePath({})` is safe —
  // every collection wired to this component is placeholder-free.
  const cacheKey = `delfrance:collectionselect:recents:${collection.resolvePath(
    {},
  )}:${fieldName}`;
  const { recents, record } = useRecentSelections(cacheKey);

  const [searchValue, setSearchValue] = useState('');
  const [debounced] = useDebouncedValue(searchValue, SEARCH_DEBOUNCE_MS);
  // While locked the dropdown is closed — ignore the search term so a stale
  // value (Mantine sets `searchValue` to the picked label) can't fire a
  // phantom prefix query.
  const term = locked ? '' : debounced.trim();

  // Server-side prefix search: add the range filters only when a term is
  // present. Range filter + orderBy on the same field needs no composite index.
  const listQuery = useMemo(() => {
    const constraints = [orderByField(labelField, 'asc')];
    if (term !== '') {
      constraints.push(whereOp(labelField, '>=', term));
      constraints.push(whereOp(labelField, '<=', `${term}${PREFIX_MAX}`));
    }
    constraints.push(limitConstraint(limit));
    return buildQuery(collection.ref(db, {}), constraints);
  }, [db, collection, labelField, term, limit]);

  const { data: listData } = useSnapshot<z.infer<S>>(listQuery);

  // The saved value may point to a doc outside the limited list — fetch it
  // directly so its label still renders.
  const selectedRef = useMemo(
    () => dereferenceOuterRef(db, value),
    [db, value],
  );
  const { data: selectedDoc } = useDocSnapshot(selectedRef);

  const selectedLabel =
    readLabelField(selectedDoc?.data, labelField) ??
    recents.find((r) => r.id === selectedId)?.label ??
    selectedId ??
    '';

  const resultItems = useMemo(
    () =>
      (listData ?? []).map((row) => ({
        value: row.id,
        label: readLabelField(row.data, labelField) ?? row.id,
      })),
    [listData, labelField],
  );

  const data: ComboboxData = useMemo(() => {
    if (locked && selectedId) {
      return [{ value: selectedId, label: selectedLabel }];
    }
    if (term !== '') {
      return resultItems;
    }
    const recentIds = new Set(recents.map((r) => r.id));
    const todos = resultItems.filter((o) => !recentIds.has(o.value));
    return [
      ...(recents.length > 0
        ? [
            {
              group: 'Recentes',
              items: recents.map((r) => ({ value: r.id, label: r.label })),
            },
          ]
        : []),
      ...(todos.length > 0 ? [{ group: 'Todos', items: todos }] : []),
    ];
  }, [locked, selectedId, selectedLabel, term, resultItems, recents]);

  const handleChange = useCallback(
    (id: string | null) => {
      if (!id) {
        setSearchValue('');
        onChange(null);
        return;
      }
      const picked =
        resultItems.find((o) => o.value === id) ??
        recents.find((r) => r.id === id);
      record(id, picked?.label ?? id);
      onChange(collection.docRef(db, {}, id));
    },
    [onChange, resultItems, recents, record, collection, db],
  );

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
      readOnly={locked}
      searchable={!locked}
      searchValue={searchValue}
      onSearchChange={setSearchValue}
      filter={({ options }) => options}
      rightSection={
        locked ? (
          <NullClearButton onClear={() => handleChange(null)} />
        ) : undefined
      }
      rightSectionPointerEvents={locked ? 'all' : undefined}
      placeholder={
        !locked && listData === undefined ? 'Carregando…' : undefined
      }
      nothingFoundMessage="Nenhum registro"
    />
  );
}
