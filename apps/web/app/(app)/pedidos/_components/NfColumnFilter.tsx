'use client';

import { type KeyboardEvent, useState } from 'react';
import { Button, Group, NumberInput, SegmentedControl, Stack, TextInput } from '@mantine/core';
import type { ColumnFilterValue } from '@delfrance/ui';

/**
 * NF (Nota Fiscal) column filter for the Pedidos TableView. NF data lives in the
 * `pedidos/{id}/nfev4` subcollection, not on the pedido doc, so this filter is
 * resolved by TableView via a collection-group lookup (see the `cliente` /
 * `nf` virtual columns in page.tsx and `useSubcollectionIdLookup`).
 *
 * The chosen child field (`numeracao` vs `chave`) plus the term are encoded as
 * `"<subfield>:<term>"` in the filter value so the whole filter round-trips
 * through the TableView URL sync unchanged.
 */
export interface NfColumnFilterProps {
  value: ColumnFilterValue | undefined;
  onChange: (next: ColumnFilterValue | undefined) => void;
}

function parseValue(value: ColumnFilterValue | undefined): { mode: string; term: string } {
  const raw = typeof value?.value === 'string' ? value.value : '';
  const sep = raw.indexOf(':');
  if (sep < 0) return { mode: 'numeracao', term: '' };
  return { mode: raw.slice(0, sep) || 'numeracao', term: raw.slice(sep + 1) };
}

export function NfColumnFilter({ value, onChange }: NfColumnFilterProps) {
  const initial = parseValue(value);
  const [mode, setMode] = useState(initial.mode);
  const [term, setTerm] = useState(initial.term);
  const disabled = term.trim() === '';
  const apply = () => {
    if (disabled) return;
    onChange({ op: 'eq', value: `${mode}:${term.trim()}` });
  };
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !disabled) {
      e.preventDefault();
      apply();
    }
  };
  return (
    <Stack gap="xs" miw={260}>
      <SegmentedControl
        value={mode}
        // Reset the term on toggle: número and chave are different value types
        // (an integer vs a 44-digit string), so carrying one into the other
        // would be invalid.
        onChange={(m) => {
          setMode(m);
          setTerm('');
        }}
        data={[
          { value: 'numeracao', label: 'Número' },
          { value: 'chave', label: 'Chave' },
        ]}
        fullWidth
      />
      {mode === 'chave' ? (
        <TextInput
          label="Chave de acesso"
          value={term}
          onChange={(e) => setTerm(e.currentTarget.value)}
          onKeyDown={onEnter}
          autoFocus
        />
      ) : (
        // Numeric-only so the lookup never builds a NaN equality match.
        <NumberInput
          label="Número da NF"
          value={term}
          onChange={(v) => setTerm(v === '' || v == null ? '' : String(v))}
          allowDecimal={false}
          allowNegative={false}
          hideControls
          onKeyDown={onEnter}
          autoFocus
        />
      )}
      <Group justify="flex-end" gap="xs">
        <Button
          size="xs"
          variant="subtle"
          onClick={() => {
            setTerm('');
            onChange(undefined);
          }}
        >
          Limpar
        </Button>
        <Button size="xs" onClick={apply} disabled={disabled}>
          Aplicar
        </Button>
      </Group>
    </Stack>
  );
}
