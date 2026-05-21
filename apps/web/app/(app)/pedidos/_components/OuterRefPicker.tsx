'use client';

/**
 * Generic picker for an opaque outer-ref field on the Pedido. Fetches
 * every doc in `collection`, renders a Mantine `Select` with one option
 * per doc (label resolved via `labelKey`), and writes a
 * `{ path: 'collection/<id>' }` object that
 * `dereferenceOuterRef` (in `lib/data/dereferenceOuterRef.ts`) accepts.
 *
 * Used by the minimal `/pedidos/novo` create form for the 5 outer-ref
 * pickers (filial / cliente / operação / endereço / integração).
 */
import { useMemo } from 'react';
import { Select, Skeleton } from '@mantine/core';
import type { CollectionHandle } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { buildQuery, limit } from '@delfrance/data';
import type { ZodObject, ZodRawShape } from 'zod';

import { getFirebaseFirestore } from '@/lib/firebase/client';

interface OpaqueRef {
  readonly path: string;
}

export interface OuterRefPickerProps<S extends ZodObject<ZodRawShape>> {
  collection: CollectionHandle<S>;
  /** Field on the doc to display as the option label (e.g. 'nome'). */
  labelKey: string;
  /**
   * Current value, in either of the two shapes
   * `dereferenceOuterRef` understands. Stored on the Pedido doc as
   * `{ path: 'collection/<id>' }` — that's the shape we write.
   */
  value: OpaqueRef | null | undefined;
  onChange: (next: OpaqueRef | null) => void;
  label: string;
  placeholder?: string;
  required?: boolean;
  error?: string;
  disabled?: boolean;
  /**
   * Cap how many docs to enumerate. Defaults to 200 — fine for filiais
   * / operações / integrações; for collections with thousands of docs
   * (clientes) the user picks the most recent N and we'd swap in a
   * searchable autocomplete later.
   */
  maxOptions?: number;
}

function extractPath(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'object' && 'path' in value) {
    const p = (value as { path: unknown }).path;
    if (typeof p === 'string') return p;
  }
  return null;
}

export function OuterRefPicker<S extends ZodObject<ZodRawShape>>({
  collection,
  labelKey,
  value,
  onChange,
  label,
  placeholder = 'Selecione…',
  required,
  error,
  disabled,
  maxOptions = 200,
}: OuterRefPickerProps<S>) {
  const db = getFirebaseFirestore();
  const path = collection.resolvePath({});
  const query = useMemo(
    () => buildQuery(collection.ref(db, {}), [limit(maxOptions)]),
    [db, collection, maxOptions],
  );
  const { data, loading } = useSnapshot(query);

  const options = useMemo(() => {
    if (!data) return [];
    return data.map((row) => {
      const rawLabel = (row.data as Record<string, unknown>)[labelKey];
      const label =
        typeof rawLabel === 'string' && rawLabel.length > 0
          ? rawLabel
          : `(${row.id.slice(0, 8)})`;
      return { value: row.id, label };
    });
  }, [data, labelKey]);

  if (loading) {
    return <Skeleton height={36} />;
  }

  const currentPath = extractPath(value);
  const currentId =
    currentPath && currentPath.startsWith(`${path}/`)
      ? currentPath.slice(path.length + 1)
      : null;

  return (
    <Select
      label={label}
      placeholder={placeholder}
      data={options}
      value={currentId}
      required={required}
      error={error}
      disabled={disabled}
      searchable
      clearable={!required}
      nothingFoundMessage="Nenhum resultado"
      onChange={(id) => {
        if (id == null) {
          onChange(null);
          return;
        }
        onChange({ path: `${path}/${id}` });
      }}
    />
  );
}
