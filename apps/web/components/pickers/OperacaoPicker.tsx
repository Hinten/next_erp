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
import { buildQuery, orderByField, whereOp } from '@delfrance/data';
import type { Operacao } from '@delfrance/schemas';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';

export interface OperacaoPickerProps {
  db: Firestore;
  /**
   * The pedido's `ehSaida`. Used to filter operações by their direction
   * (`tipo == 1` for saída, `tipo == 0` for entrada).
   */
  ehSaida: boolean;
  value: unknown;
  onChange: (next: DocumentReference<Operacao> | null) => void;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
}

export function OperacaoPicker({
  db,
  ehSaida,
  value,
  onChange,
  label = 'Operação fiscal',
  required,
  disabled,
  error,
}: OperacaoPickerProps) {
  const query = useQuery({
    queryKey: ['operacoes', ehSaida],
    queryFn: async () => {
      const base = operacaoCollection.ref(db, {});
      const tipo = ehSaida ? 1 : 0;
      const q = buildQuery(base, [
        whereOp('tipo', '==', tipo),
        orderByField('nome'),
      ]);
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
        if (row) onChange(row.ref as DocumentReference<Operacao>);
      }}
      required={required}
      disabled={disabled || query.isLoading}
      error={error ?? (query.error instanceof FirebaseError ? query.error.message : undefined)}
      placeholder={
        query.isLoading
          ? 'Carregando…'
          : ehSaida
            ? 'Selecione uma operação de saída'
            : 'Selecione uma operação de entrada'
      }
      searchable
      clearable
      nothingFoundMessage="Nenhuma operação encontrada"
    />
  );
}
