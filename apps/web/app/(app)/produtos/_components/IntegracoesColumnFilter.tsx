'use client';

import { useMemo } from 'react';
import { Box, Button, Group, MultiSelect, Stack } from '@mantine/core';
import type { ColumnFilterValue } from '@delfrance/ui';
import { INTEGRACAO_TIPO_LABELS, type IntegracaoTipo } from '@delfrance/schemas';
import type { IntegracaoRow } from '@/lib/data/useIntegracoes';

/**
 * Firestore's disjunction cap for `array-contains-any`. Mirrors
 * `nfe/comunicacoes/_lib/resolveChaves.ts`'s `MAX_CHAVES`, and it is also the
 * classic-path cap TableView documents.
 */
export const MAX_INTEGRACOES_FILTRO = 30;

export interface IntegracoesColumnFilterProps {
  /** Every integração, already ordered by `nome` (see `useIntegracoes`). */
  integracoes: IntegracaoRow[];
  value: ColumnFilterValue | undefined;
  onChange: (next: ColumnFilterValue | undefined) => void;
}

/**
 * "Canais de venda" column filter for the Produtos TableView: pick any number
 * of integrações and keep the produtos listed on AT LEAST ONE of them.
 *
 * It emits `array-contains-any` against the denormalized
 * `integracoesComProduto` id array — the same shape legacy's "Integração"
 * dropdown used (`produtoTableView.dart:246-268`), widened from its one-at-a-
 * time `DropDownField` to a multi-select.
 *
 * ⚠️ An empty selection emits `undefined`, NOT an empty list. Dropping the
 * filter is what "nothing selected" means, and an empty candidate list is a
 * throw in `buildPipeline` (TableView carries a backstop for that, but the
 * intent belongs here).
 *
 * TableView already wraps this body in the shared `FilterPopover` and passes no
 * `close` callback, so there is no "Aplicar" step — the filter applies as the
 * selection changes, like the Cliente column's.
 */
export function IntegracoesColumnFilter({
  integracoes,
  value,
  onChange,
}: IntegracoesColumnFilterProps) {
  // Not memoized: a `useMemo` keyed on `value?.value` is a dependency the React
  // Compiler cannot preserve (it infers `value`), which turns off optimization
  // for the whole component. Copying a handful of ids each render is cheaper
  // than that, and the compiler memoizes it on its own.
  const selected = Array.isArray(value?.value) ? [...value.value] : [];

  const options = useMemo(
    () =>
      integracoes.map((row) => ({
        value: row.id,
        // The tipo disambiguates two contas on the same channel; `(inativo)`
        // keeps a deactivated conta selectable — a produto can still carry it —
        // while saying why it is not in the channel list any more.
        label:
          `${row.data.nome} (${INTEGRACAO_TIPO_LABELS[row.data.tipo as IntegracaoTipo]})` +
          (row.data.ativo ? '' : ' — inativo'),
      })),
    [integracoes],
  );

  const atCap = selected.length >= MAX_INTEGRACOES_FILTRO;

  return (
    <Box miw={280}>
      <Stack gap="xs">
        <MultiSelect
          label="Canais de venda"
          placeholder={selected.length === 0 ? 'Todos' : undefined}
          data={options}
          value={selected}
          onChange={(next) =>
            onChange(next.length === 0 ? undefined : { op: 'array-contains-any', value: next })
          }
          // `maxValues` REFUSES the 31st pick rather than accepting it and
          // quietly dropping it from the query — a silently truncated filter
          // reads as "these are all the matches" when it is not.
          maxValues={MAX_INTEGRACOES_FILTRO}
          description={atCap ? `Máximo de ${MAX_INTEGRACOES_FILTRO} canais por filtro.` : undefined}
          searchable
          clearable
          hidePickedOptions
          nothingFoundMessage="Nenhuma integração encontrada"
          // Render inline: a portaled dropdown's option click reads as a
          // click-outside and closes the surrounding FilterPopover.
          comboboxProps={{ withinPortal: false }}
        />
        <Group justify="flex-end" gap="xs">
          <Button size="xs" variant="subtle" onClick={() => onChange(undefined)}>
            Limpar
          </Button>
        </Group>
      </Stack>
    </Box>
  );
}
