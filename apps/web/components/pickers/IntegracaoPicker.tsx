'use client';

import { useMemo } from 'react';
import { Select } from '@mantine/core';
import { FirebaseError } from 'firebase/app';
import { type Firestore } from 'firebase/firestore';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { useIntegracoes } from '@/lib/data/useIntegracoes';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';

export interface IntegracaoPickerProps {
  db: Firestore;
  value: unknown;
  onChange: (next: string | null) => void;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
}

export function IntegracaoPicker({
  db,
  value,
  onChange,
  label = 'Integração',
  required,
  disabled,
  error,
}: IntegracaoPickerProps) {
  // The SHARED `['integracoes']` read — see `useIntegracoes`. It must not be
  // re-issued here under the same key with a different row shape.
  const { rows, query } = useIntegracoes(db);

  const currentId = useMemo(() => {
    const r = dereferenceOuterRef(db, value);
    return r?.id ?? null;
  }, [db, value]);

  const options = useMemo(
    () =>
      rows.map((row) => ({
        value: row.id,
        label: row.data.nome,
      })),
    [rows],
  );

  return (
    <Select
      label={label}
      data={options}
      value={currentId}
      onChange={(id) => {
        onChange(id ? `documents/${integracaoCollection.resolvePath({})}/${id}` : null);
      }}
      required={required}
      disabled={disabled || query.isLoading}
      error={error ?? (query.error instanceof FirebaseError ? query.error.message : undefined)}
      placeholder={query.isLoading ? 'Carregando…' : 'Selecione uma integração'}
      searchable
      clearable
      nothingFoundMessage="Nenhuma integração encontrada"
    />
  );
}
