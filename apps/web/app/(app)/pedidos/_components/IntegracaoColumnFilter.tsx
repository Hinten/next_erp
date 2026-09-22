'use client';

import { useMemo } from 'react';
import { Box, Button, Group, Select, Stack, Text } from '@mantine/core';
import { INTEGRACAO_TIPO_LABELS, type IntegracaoTipo } from '@delfrance/schemas';
import type { ColumnFilterValue } from '@delfrance/ui';

import type { IntegracaoRow } from '@/lib/data/useIntegracoes';
import type { IntegracaoLookup } from './integracaoLookup';
import { integracaoOuterRef } from './integracaoLookup';

/**
 * Canal (integração) column filter for the Pedidos TableView.
 *
 * Single-select `eq`, unlike the produtos "Canais de venda" filter it is
 * modelled on: a pedido belongs to exactly ONE channel
 * (`integracaoPedidoOuterRef` is a scalar), where a produto can be listed on
 * many (`integracoesComProduto` is an array, hence `array-contains-any` there).
 *
 * The emitted value is the full `documents/integracao/<id>` doc-path string,
 * which is byte-identical to what the pedido stores — so the equality match is
 * exact and needs no denormalized name.
 */
export interface IntegracaoColumnFilterProps {
  /** Every integração, ordered by `nome` — see `useIntegracoes`. */
  integracoes: IntegracaoRow[];
  status: IntegracaoLookup['status'];
  value: ColumnFilterValue | undefined;
  onChange: (next: ColumnFilterValue | undefined) => void;
}

export function IntegracaoColumnFilter({
  integracoes,
  status,
  value,
  onChange,
}: IntegracaoColumnFilterProps) {
  // Not memoized on `value`: a `useMemo` keyed on `value?.value` is a dependency
  // the React Compiler cannot preserve, which turns off optimization for the
  // whole component (same note as `IntegracoesColumnFilter`).
  const current = typeof value?.value === 'string' ? value.value : null;

  const options = useMemo(
    () =>
      integracoes.map((row) => ({
        value: integracaoOuterRef(row.id),
        // The tipo disambiguates two contas on the same channel; `inativo` keeps
        // a deactivated conta selectable — old pedidos still carry it — while
        // saying why it is no longer in the channel list.
        label:
          `${row.data.nome} (${INTEGRACAO_TIPO_LABELS[row.data.tipo as IntegracaoTipo]})` +
          (row.data.ativo ? '' : ' — inativo'),
      })),
    [integracoes],
  );

  return (
    <Box miw={280}>
      <Stack gap="xs">
        {status === 'error' ? (
          // ⚠️ Never an empty dropdown: "no options" and "you may not read this
          // collection" look identical on screen and are not the same problem.
          <Text size="xs" c="dimmed">
            Sem permissão para ler os canais de venda.
          </Text>
        ) : (
          <Select
            // ⚠️ Must equal the COLUMN label: the e2e helper resolves the
            // combobox by the column's name.
            label="Canal"
            placeholder={status === 'pending' ? 'Carregando…' : 'Todos'}
            data={options}
            value={current}
            disabled={status === 'pending'}
            onChange={(next) => onChange(next ? { op: 'eq', value: next } : undefined)}
            searchable
            clearable
            nothingFoundMessage="Nenhuma integração encontrada"
            // Render inline: a portaled dropdown's option click reads as a
            // click-outside and closes the surrounding FilterPopover.
            comboboxProps={{ withinPortal: false }}
          />
        )}
        <Group justify="flex-end" gap="xs">
          <Button size="xs" variant="subtle" onClick={() => onChange(undefined)}>
            Limpar
          </Button>
        </Group>
      </Stack>
    </Box>
  );
}
