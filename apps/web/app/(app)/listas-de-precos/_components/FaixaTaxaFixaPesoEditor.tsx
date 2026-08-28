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

/**
 * Snap a stored bound onto the 0,01 grid `taxaFixaPorPeso` compares on.
 *
 * A bound can already carry a third decimal — from the legacy corpus
 * (`pesoMinKg`/`pesoMaxKg` are plain `z.number()`) or from this screen, which
 * accepted three until the cap below. Every such bound has an EXACT 2-decimal
 * equivalent, and it is NOT the rounded one: because the product weight is
 * rounded UP before the comparison, a min of `0,251` admits exactly the
 * weights a min of `0,26` admits, and a max of `0,499` exactly those of
 * `0,49`. Hence ceil for the lower bound, floor for the upper.
 *
 * Without this, rendering the raw value through `decimalScale={2}` would
 * ROUND it — `0,499` displays as "0,50", stating a band end that a 0,50 kg
 * product does not actually fall into. That is the same silent failure this
 * editor's help text exists to remove. Snapping shows the bound the engine
 * really uses. It is display-only: `onChange` does not fire on mount, so the
 * stored value is never rewritten behind the operator's back.
 *
 * ⚠️ `Math.floor(n * 100)` alone is wrong — `1.15 * 100` is
 * `114.99999999999999`, which floors to `1,14`. Round the scaled value first.
 *
 * ⚠️ A band that spans no grid step (`0,251`-`0,259`) snaps to min 0,26 >
 * max 0,25. That looks broken because it IS: such a band can never match.
 */
function naGrade(n: number, arredonda: (x: number) => number): number {
  return arredonda(Number((n * 100).toFixed(6))) / 100;
}
const gradeMin = (n: number) => naGrade(n, Math.ceil);
const gradeMax = (n: number) => naGrade(n, Math.floor);

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
              lands on a 0,01 grid and a third decimal can express nothing a
              2-decimal bound cannot — see {@link naGrade} for the exact
              equivalence, which is ceil for the min and floor for the max.

              ⚠️ That is NOT the same as the third decimal being ignored. It is
              ignored on the MAX bound (`0,499` behaves as `0,49`) but fully
              observable on the MIN bound: `0,251` behaves as `0,26`, so
              truncating it to `0,25` would WIDEN the band. Both directions
              are pinned by `faixaTaxaFixaPeso.test.ts`.

              What the cap removes is a digit that only ever restates a
              coarser bound — including bands spanning no grid step at all
              (`0,251`-`0,259`), which silently fall back to the formula's
              default `taxaFixa`.

              The rounding itself is NOT changed: it is faithful to the legacy
              `getTaxaFixaPorPeso` and matches how carriers bill weight.
            */}
            <DecimalInput
              label="Peso mín. (kg)"
              ariaLabel={`Peso mínimo ${i + 1}${scope}`}
              value={gradeMin(row.pesoMinKg ?? 0)}
              onChange={(n) => patchRow(i, { pesoMinKg: n ?? 0 })}
              disabled={disabled || marked}
              min={0}
              decimalScale={2}
              w={130}
            />
            <DecimalInput
              label="Peso máx. (kg)"
              ariaLabel={`Peso máximo ${i + 1}${scope}`}
              value={gradeMax(row.pesoMaxKg ?? 0)}
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
