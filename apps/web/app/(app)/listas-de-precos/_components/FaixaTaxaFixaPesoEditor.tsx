'use client';

import { ActionIcon, Button, Group, Stack, Text } from '@mantine/core';
import { IconArrowBackUp, IconTrash } from '@tabler/icons-react';
import { DELETE_MARK, DecimalInput } from '@delfrance/ui';

/**
 * One editable row of a formula's `faixasTaxaFixaPeso` (peso range → fixed
 * fee). Rows marked with `DELETE_MARK` stay visible (dimmed, "Será excluída")
 * with an undo affordance; the actual removal happens at save time via the
 * parent field's `prepareForSave` (see `formulaStrip.ts`) — CLAUDE.md rule 7.
 */
interface FaixaRow {
  pesoMinKg?: number;
  pesoMaxKg?: number;
  taxaFixa?: number;
  [DELETE_MARK]?: boolean;
  [key: string]: unknown;
}

const EMPTY_ROW: FaixaRow = { pesoMinKg: 0, pesoMaxKg: 0, taxaFixa: 0 };

function toRows(value: unknown): FaixaRow[] {
  return Array.isArray(value) ? (value as FaixaRow[]) : [];
}

export interface FaixaTaxaFixaPesoEditorProps {
  value: unknown;
  onChange: (next: FaixaRow[]) => void;
  disabled?: boolean;
  /** Suffix appended to every aria-label so nested editors stay unique. */
  scope: string;
}

export function FaixaTaxaFixaPesoEditor({
  value,
  onChange,
  disabled,
  scope,
}: FaixaTaxaFixaPesoEditorProps) {
  const rows = toRows(value);

  const patchRow = (index: number, patch: Partial<FaixaRow>) => {
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  return (
    <Stack gap="xs">
      <Text size="xs" fw={500} c="dimmed">
        Faixas de taxa fixa por peso
      </Text>
      <Text size="xs" c="dimmed">
        O peso do produto é arredondado para cima em 2 casas antes de procurar a faixa — um produto
        de 0,252 kg conta como 0,26 kg.
      </Text>
      {rows.length === 0 && (
        <Text size="xs" c="dimmed">
          Nenhuma faixa de peso.
        </Text>
      )}
      {rows.map((row, i) => {
        const marked = row[DELETE_MARK] === true;
        return (
          <Group key={i} align="flex-end" gap="xs" opacity={marked ? 0.45 : 1} wrap="nowrap">
            {/*
              2 decimals, not 3, deliberately. `taxaFixaPorPeso` compares these
              bounds against a weight first rounded UP to 2 decimals
              (`Math.ceil(pesoKg * 100) / 100`), so the comparison only ever
              lands on a 0,01 grid: a third decimal in a bound is inert
              (`0,499` behaves exactly as `0,49`), and a band with no multiple
              of 0,01 inside it (`0,251`-`0,259`) can never match at all — it
              falls back to the formula's default `taxaFixa` with nothing on
              screen to say so. Offering a digit the engine discards is what
              made that invisible. Pinned by `faixaTaxaFixaPeso.test.ts`.

              The rounding itself is NOT changed: it is faithful to the legacy
              `getTaxaFixaPorPeso` and matches how carriers bill weight.
            */}
            <DecimalInput
              label="Peso mín. (kg)"
              ariaLabel={`Peso mínimo ${i + 1}${scope}`}
              value={row.pesoMinKg ?? 0}
              onChange={(n) => patchRow(i, { pesoMinKg: n ?? 0 })}
              disabled={disabled || marked}
              min={0}
              decimalScale={2}
              w={130}
            />
            <DecimalInput
              label="Peso máx. (kg)"
              ariaLabel={`Peso máximo ${i + 1}${scope}`}
              value={row.pesoMaxKg ?? 0}
              onChange={(n) => patchRow(i, { pesoMaxKg: n ?? 0 })}
              disabled={disabled || marked}
              min={0}
              decimalScale={2}
              w={130}
            />
            <DecimalInput
              label="Taxa fixa"
              ariaLabel={`Taxa fixa por peso ${i + 1}${scope}`}
              value={row.taxaFixa ?? 0}
              onChange={(n) => patchRow(i, { taxaFixa: n ?? 0 })}
              disabled={disabled || marked}
              min={0}
              decimalScale={2}
              w={120}
            />
            {marked ? (
              <Group gap={4} wrap="nowrap">
                <Text size="xs" c="red" fw={500}>
                  Será excluída
                </Text>
                <ActionIcon
                  type="button"
                  variant="subtle"
                  aria-label={`Desfazer exclusão da faixa de peso ${i + 1}${scope}`}
                  onClick={() => patchRow(i, { [DELETE_MARK]: false })}
                  disabled={disabled}
                >
                  <IconArrowBackUp size={16} />
                </ActionIcon>
              </Group>
            ) : (
              <ActionIcon
                type="button"
                variant="subtle"
                color="red"
                aria-label={`Excluir faixa de peso ${i + 1}${scope}`}
                onClick={() => patchRow(i, { [DELETE_MARK]: true })}
                disabled={disabled}
              >
                <IconTrash size={16} />
              </ActionIcon>
            )}
          </Group>
        );
      })}
      <Group>
        <Button
          type="button"
          variant="subtle"
          size="compact-xs"
          onClick={() => onChange([...rows, { ...EMPTY_ROW }])}
          disabled={disabled}
        >
          Adicionar faixa de peso
        </Button>
      </Group>
    </Stack>
  );
}
