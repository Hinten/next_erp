'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Anchor,
  CloseButton,
  Combobox,
  Group,
  InputBase,
  Loader,
  Stack,
  Text,
  useCombobox,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';
import { type DocumentReference, type Firestore, getDocs } from 'firebase/firestore';
import { buildQuery, limit, orderByField, whereOp } from '@delfrance/data';
import { useDocSnapshot } from '@delfrance/data/hooks';
import type { Cliente } from '@delfrance/schemas';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';

const PAGE_SIZE = 20;

export interface ClientePickerProps {
  db: Firestore;
  value: unknown;
  onChange: (next: DocumentReference<Cliente> | null) => void;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
}

export function ClientePicker({
  db,
  value,
  onChange,
  label = 'Cliente',
  required,
  disabled,
  error,
}: ClientePickerProps) {
  const combobox = useCombobox({
    onDropdownClose: () => combobox.resetSelectedOption(),
  });

  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 250);

  const currentRef = useMemo(
    () => dereferenceOuterRef(db, value) as DocumentReference<Cliente> | null,
    [db, value],
  );
  const currentRefTyped = useMemo(() => {
    if (!currentRef) return null;
    return clienteCollection.docRef(db, {}, currentRef.id);
  }, [db, currentRef]);
  const { data: currentDoc, loading: loadingCurrent } = useDocSnapshot(currentRefTyped);
  const currentLabel = currentDoc?.data.nome ?? '';

  const query = useQuery({
    queryKey: ['clientesPicker', debouncedSearch],
    queryFn: async () => {
      const base = clienteCollection.ref(db, {});
      const trimmed = debouncedSearch.trim();
      const q = trimmed
        ? buildQuery(base, [
            orderByField('nome'),
            whereOp('nome', '>=', trimmed),
            whereOp('nome', '<=', `${trimmed}`),
            limit(PAGE_SIZE),
          ])
        : buildQuery(base, [orderByField('nome'), limit(PAGE_SIZE)]);
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
    enabled: combobox.dropdownOpened,
  });

  // Keep the rendered text in sync with the resolved current value
  // whenever the dropdown is closed.
  useEffect(() => {
    if (!combobox.dropdownOpened) {
      setSearch(currentLabel);
    }
  }, [currentLabel, combobox.dropdownOpened]);

  const rows = query.data ?? [];

  return (
    <Combobox
      store={combobox}
      onOptionSubmit={(optionId) => {
        const row = rows.find((r) => r.id === optionId);
        if (row) {
          onChange(row.ref as DocumentReference<Cliente>);
          setSearch(row.data.nome ?? '');
        }
        combobox.closeDropdown();
      }}
      disabled={disabled}
    >
      <Combobox.Target>
        <InputBase
          label={label}
          required={required}
          disabled={disabled}
          error={error}
          rightSection={
            loadingCurrent || query.isFetching ? (
              <Loader size={16} />
            ) : currentRef ? (
              <CloseButton
                size="sm"
                aria-label="Limpar"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(null);
                  setSearch('');
                }}
              />
            ) : (
              <Combobox.Chevron />
            )
          }
          rightSectionPointerEvents={currentRef ? 'auto' : 'none'}
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value);
            combobox.openDropdown();
            combobox.updateSelectedOptionIndex();
          }}
          onClick={() => combobox.openDropdown()}
          onFocus={() => combobox.openDropdown()}
          onBlur={() => combobox.closeDropdown()}
          placeholder="Buscar cliente por nome…"
        />
      </Combobox.Target>

      <Combobox.Dropdown>
        <Combobox.Options>
          {query.isLoading && <Combobox.Empty>Carregando…</Combobox.Empty>}
          {!query.isLoading && rows.length === 0 && (
            <Combobox.Empty>Nenhum cliente encontrado.</Combobox.Empty>
          )}
          {rows.map((row) => (
            <Combobox.Option key={row.id} value={row.id}>
              <Stack gap={0}>
                <Text size="sm">{row.data.nome ?? '(sem nome)'}</Text>
                {row.data.cpf_cnpj && (
                  <Text size="xs" c="dimmed">
                    {row.data.cpf_cnpj}
                  </Text>
                )}
              </Stack>
            </Combobox.Option>
          ))}
        </Combobox.Options>
        <Combobox.Footer>
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              {rows.length} resultado(s)
            </Text>
            <Anchor size="xs" component={Link} href="/clientes/novo" target="_blank">
              + Novo cliente
            </Anchor>
          </Group>
        </Combobox.Footer>
      </Combobox.Dropdown>
    </Combobox>
  );
}
