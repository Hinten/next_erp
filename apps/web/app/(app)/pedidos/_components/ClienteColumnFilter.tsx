'use client';

import { Box } from '@mantine/core';
import type { ColumnFilterValue } from '@delfrance/ui';

import { CollectionSelect } from '@/components/collection-select/CollectionSelect';
import { clienteCollection } from '@/lib/data/clienteCollection';

/**
 * Cliente column filter for the Pedidos TableView. Reuses the shared
 * `CollectionSelect` (the cliente selector primitive, without the picker's
 * "+ Novo cliente" affordance — a filter only narrows, it never creates) to
 * pick a cliente, then emits an `eq` filter on `clientePedidoOuterRef`.
 *
 * `CollectionSelect` emits the `documents/clientes/<id>` doc-path string, which
 * is exactly what the pedido stores in `clientePedidoOuterRef`, so the equality
 * match is exact — no denormalized name needed.
 */
const SEARCH_FIELDS = ['nome', 'cpf_cnpj', 'idEstrangeiro', 'email', 'telefone'];
const RECENCY_ORDER = [
  { field: 'ultimaModificacao', direction: 'desc' as const },
  { field: 'timestamp', direction: 'desc' as const },
];

export interface ClienteColumnFilterProps {
  value: ColumnFilterValue | undefined;
  onChange: (next: ColumnFilterValue | undefined) => void;
}

export function ClienteColumnFilter({ value, onChange }: ClienteColumnFilterProps) {
  const current = typeof value?.value === 'string' ? value.value : null;
  return (
    <Box miw={260}>
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
      />
    </Box>
  );
}
