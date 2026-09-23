'use client';

import { useState } from 'react';
import { Button, Group, SegmentedControl, Stack, Text } from '@mantine/core';
import type { ColumnFilterValue } from '@delfrance/ui';

import { CollectionSelect } from '@/components/collection-select/CollectionSelect';
import { clienteCollection } from '@/lib/data/clienteCollection';

/**
 * Cliente column filter for the Pedidos TableView, in two modes.
 *
 * **Cliente** reuses the shared `CollectionSelect` (the cliente selector
 * primitive, without the picker's "+ Novo cliente" affordance — a filter only
 * narrows, it never creates) to pick a cliente, then emits an `eq` filter on
 * `clientePedidoOuterRef`. `CollectionSelect` emits the
 * `documents/clientes/<id>` doc-path string, which is exactly what the pedido
 * stores, so the equality match is exact — no denormalized name needed.
 *
 * **Anônimo** emits `isNull`, i.e. `clientePedidoOuterRef == null`. That is a
 * real and frequent state rather than a data defect: marketplaces redact buyer
 * data outside a bounded unmask window, so a masked import writes NO cliente ref
 * at all (see `capturaCompradorSchema` in `packages/schemas`). `ClienteCell`
 * already labels those rows "Anônimo"; this is how an operator finds them.
 *
 * Two segments rather than a checkbox, because the modes are mutually exclusive:
 * a checkbox alongside the select would admit a fourth, meaningless state (a
 * cliente picked AND "somente anônimos" ticked). `NfColumnFilter`, one header
 * over on this same table, already uses this shape for the same reason.
 */
const SEARCH_FIELDS = ['nome', 'cpf_cnpj', 'idEstrangeiro', 'email', 'telefone'];
const RECENCY_ORDER = [
  { field: 'ultimaModificacao', direction: 'desc' as const },
  { field: 'timestamp', direction: 'desc' as const },
];

/** The word `ClienteCell` renders for a pedido with no cliente ref. Keep them equal. */
export const ANONIMO_LABEL = 'Anônimo';

type ClienteFilterMode = 'cliente' | 'anonimo';

/**
 * Chip text for the active Cliente filter.
 *
 * Exported and pure so the virtual column can reference it without the popover
 * being mounted — `formatValue` runs from the chip row, not from here.
 *
 * ⚠️ A specific cliente degrades to its bare document id, NOT its name.
 * Resolving the name would need a lookup this callback cannot reach: it is
 * synchronous, and unlike `/produtos`' integrações there is no table-wide
 * cliente map (`rowReadPrefetch` batches only the rows on the current page).
 * Printing the id is still strictly better than the raw
 * `documents/clientes/<id>` path the chip showed before.
 */
export function formatClienteFilterValue(value: ColumnFilterValue['value']): string {
  if (value === null) return ANONIMO_LABEL;
  const raw = String(value);
  const slash = raw.lastIndexOf('/');
  return slash < 0 ? raw : raw.slice(slash + 1);
}

export interface ClienteColumnFilterProps {
  value: ColumnFilterValue | undefined;
  onChange: (next: ColumnFilterValue | undefined) => void;
}

export function ClienteColumnFilter({ value, onChange }: ClienteColumnFilterProps) {
  // Seeded once from the incoming filter, never re-derived: while the operator
  // is on the `cliente` segment with nothing picked there IS no filter, so a
  // derived mode would snap the control back to whatever the value says. Same
  // reason `NfColumnFilter` seeds its own mode in a `useState` initializer.
  // A hydrated URL or a restored sticky filter therefore reopens on the right
  // segment.
  const [mode, setMode] = useState<ClienteFilterMode>(() =>
    value?.op === 'isNull' ? 'anonimo' : 'cliente',
  );
  const current = typeof value?.value === 'string' ? value.value : null;

  return (
    <Stack gap="xs" miw={260}>
      <SegmentedControl
        value={mode}
        onChange={(next) => {
          const m = next as ClienteFilterMode;
          setMode(m);
          // `anonimo` is a complete filter on its own — apply it on the toggle,
          // matching this popover's existing no-"Aplicar" behaviour. `cliente`
          // with nothing picked honestly means no filter.
          onChange(m === 'anonimo' ? { op: 'isNull', value: null } : undefined);
        }}
        data={[
          { value: 'cliente', label: 'Cliente' },
          { value: 'anonimo', label: ANONIMO_LABEL },
        ]}
        fullWidth
      />
      {mode === 'anonimo' ? (
        <Text size="xs" c="dimmed">
          Pedidos sem cliente vinculado — comprador não identificado no marketplace.
        </Text>
      ) : (
        <CollectionSelect
          collection={clienteCollection}
          labelField="nome"
          searchFields={SEARCH_FIELDS}
          optionHintField="cpf_cnpj"
          fieldName="pedido-cliente-filter"
          label="Filtrar por cliente"
          value={current}
          onChange={(next) =>
            onChange(typeof next === 'string' && next ? { op: 'eq', value: next } : undefined)
          }
          limit={5}
          orderBy={RECENCY_ORDER}
          // Render the dropdown inline: a portaled option click reads as a
          // click-outside and closes the surrounding FilterPopover, and the
          // dialog-scoped e2e locators cannot reach a portaled listbox.
          comboboxProps={{ withinPortal: false }}
        />
      )}
      <Group justify="flex-end" gap="xs">
        <Button
          size="xs"
          variant="subtle"
          onClick={() => {
            setMode('cliente');
            onChange(undefined);
          }}
        >
          Limpar
        </Button>
      </Group>
    </Stack>
  );
}
