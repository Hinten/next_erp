'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  CloseButton,
  Combobox,
  InputBase,
  Loader,
  ScrollArea,
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
import type { Produto } from '@delfrance/schemas';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';

const PAGE_SIZE = 20;
// U+F8FF: a very high private-use code point. Appended to the search term it
// bounds a nome prefix range (nome >= term && nome <= term + sentinel).
const PREFIX_SENTINEL = '';

export interface ProdutoPickerResult {
  ref: DocumentReference<Produto>;
  id: string;
  data: Produto;
}

export interface ProdutoPickerProps {
  db: Firestore;
  value: unknown;
  onChange: (next: ProdutoPickerResult | null) => void;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  placeholder?: string;
}

function isSku(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /^[A-Z0-9_-]+$/.test(trimmed);
}

export function ProdutoPicker({
  db,
  value,
  onChange,
  label = 'Produto',
  required,
  disabled,
  error,
  placeholder = 'Buscar produto…',
}: ProdutoPickerProps) {
  const combobox = useCombobox({
    onDropdownClose: () => combobox.resetSelectedOption(),
  });

  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 250);

  const currentRef = useMemo(() => {
    const r = dereferenceOuterRef(db, value);
    return r ? produtoCollection.docRef(db, {}, r.id) : null;
  }, [db, value]);
  const { data: currentDoc, loading: loadingCurrent } = useDocSnapshot(currentRef);
  const currentLabel = currentDoc?.data.nome ?? '';

  const query = useQuery({
    queryKey: ['produtosPicker', debouncedSearch],
    queryFn: async () => {
      const base = produtoCollection.ref(db, {});
      const trimmed = debouncedSearch.trim();
      try {
        // SKU exact match fallback when the search looks like a SKU.
        if (trimmed && isSku(trimmed)) {
          const skuQ = buildQuery(base, [whereOp('sku', '==', trimmed), limit(PAGE_SIZE)]);
          const skuSnap = await getDocs(skuQ);
          if (!skuSnap.empty) {
            return skuSnap.docs.map((d) => ({
              id: d.id,
              ref: d.ref,
              data: d.data(),
            }));
          }
        }
        const q = trimmed
          ? buildQuery(base, [
              orderByField('nome'),
              whereOp('nome', '>=', trimmed),
              whereOp('nome', '<=', `${trimmed}${PREFIX_SENTINEL}`),
              limit(PAGE_SIZE),
            ])
          : buildQuery(base, [orderByField('nome'), limit(PAGE_SIZE)]);
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
          onChange({
            ref: row.ref as DocumentReference<Produto>,
            id: row.id,
            data: row.data,
          });
          setSearch(row.data.nome);
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
            // Gate the fetch-loader on THIS picker being open. The query key is
            // shared across all picker instances (same search), so TanStack's
            // `isFetching` is shared too — without this, opening one picker shows
            // the Loader on every other picker on the screen.
            loadingCurrent || (query.isFetching && combobox.dropdownOpened) ? (
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
          placeholder={placeholder}
        />
      </Combobox.Target>

      <Combobox.Dropdown>
        {/* Scroll the options so a full page of results isn't clipped. */}
        <ScrollArea.Autosize mah={280} type="scroll">
          <Combobox.Options>
            {query.isLoading && <Combobox.Empty>Carregando…</Combobox.Empty>}
            {!query.isLoading && rows.length === 0 && (
              <Combobox.Empty>Nenhum produto encontrado.</Combobox.Empty>
            )}
            {rows.map((row) => (
              <Combobox.Option key={row.id} value={row.id}>
                <Stack gap={0}>
                  <Text size="sm">{row.data.nome}</Text>
                  {row.data.sku && (
                    <Text size="xs" c="dimmed">
                      SKU: {row.data.sku}
                    </Text>
                  )}
                </Stack>
              </Combobox.Option>
            ))}
          </Combobox.Options>
        </ScrollArea.Autosize>
      </Combobox.Dropdown>
    </Combobox>
  );
}
