'use client';

import { useMemo } from 'react';
import { Select } from '@mantine/core';
import type { ZodObject, ZodRawShape, z } from 'zod';
import { type CollectionHandle, buildQuery, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export interface CollectionSelectProps<S extends ZodObject<ZodRawShape>> {
  collection: CollectionHandle<S>;
  /** Field on the referenced doc used as the visible label (e.g. `nome`). */
  labelField: string;
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

/**
 * Mantine `<Select>` bound to a Firestore collection. Renders one option per
 * document (sorted by `labelField`) and emits a `DocumentReference` on change
 * so the form persists a real reference, not just an id string.
 */
export function CollectionSelect<S extends ZodObject<ZodRawShape>>({
  collection,
  labelField,
  value,
  onChange,
  onBlur,
  label,
  hint,
  required,
  disabled,
  error,
}: CollectionSelectProps<S>) {
  const db = getFirebaseFirestore();

  const q = useMemo(
    () => buildQuery(collection.ref(db, {}), [orderByField(labelField, 'asc')]),
    [db, collection, labelField],
  );
  const { data, loading } = useSnapshot<z.infer<S>>(q);

  const options = useMemo(() => {
    if (!data) return [];
    return data.map((row) => ({
      value: row.id,
      label:
        ((row.data as Record<string, unknown>)[labelField] as string | undefined) ??
        row.id,
    }));
  }, [data, labelField]);

  const selectedId = valueToId(value);

  return (
    <Select
      label={label}
      description={hint}
      data={options}
      value={selectedId}
      onChange={(id) => onChange(id ? collection.docRef(db, {}, id) : null)}
      onBlur={onBlur}
      required={required}
      disabled={disabled || loading}
      error={error}
      placeholder={loading ? 'Carregando…' : undefined}
      clearable={!required}
      searchable
      nothingFoundMessage="Nenhum registro"
    />
  );
}
