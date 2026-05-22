'use client';

import { useMemo } from 'react';
import { Select } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';
import {
  type DocumentReference,
  type Firestore,
  getDocs,
} from 'firebase/firestore';
import { buildQuery, orderByField } from '@delfrance/data';
import type { Integracao } from '@delfrance/schemas';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';

export interface IntegracaoPickerProps {
  db: Firestore;
  value: unknown;
  onChange: (next: DocumentReference<Integracao> | null) => void;
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
  const query = useQuery({
    queryKey: ['integracoes'],
    queryFn: async () => {
      const base = integracaoCollection.ref(db, {});
      const q = buildQuery(base, [orderByField('nome')]);
      try {
        const snap = await getDocs(q);
        return snap.docs.map((d) => ({
          id: d.id,
          ref: d.ref,
          data: d.data(),
        }));
      } catch (err) {
        if (err instanceof FirebaseError) {
          throw err;
        }
        throw err;
      }
    },
  });

  const rows = useMemo(() => query.data ?? [], [query.data]);

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
        if (!id) {
          onChange(null);
          return;
        }
        const row = rows.find((r) => r.id === id);
        if (row) onChange(row.ref as DocumentReference<Integracao>);
      }}
      required={required}
      disabled={disabled || query.isLoading}
      error={error ?? (query.error instanceof FirebaseError ? query.error.message : undefined)}
      placeholder={
        query.isLoading ? 'Carregando…' : 'Selecione uma integração'
      }
      searchable
      clearable
      nothingFoundMessage="Nenhuma integração encontrada"
    />
  );
}
