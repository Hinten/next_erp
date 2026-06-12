'use client';

import {
  ActionIcon,
  Button,
  Fieldset,
  Group,
  NumberInput,
  Select,
  Stack,
  Text,
} from '@mantine/core';
import { IconArrowBackUp, IconTrash } from '@tabler/icons-react';
import { DIA_DA_SEMANA_LABELS, type DiaDaSemana } from '@delfrance/schemas';
import { DELETE_MARK, type FieldRenderProps } from '@delfrance/ui';
import { rootError, rowFieldError, validatedIndices } from './editorErrors';

/**
 * Editable rows of `intFrete.horarioDeCorte` — the cut-off schedule
 * `getPrazoDespacho` consumes. Same staged-deletion convention as
 * `FaixaCepEditor` (DELETE_MARK + `prepareForSave: stripMarkedForDeletion`).
 */
interface HorarioRow {
  diaDaSemana?: DiaDaSemana;
  horaDeCorte?: number | null;
  minutosDeCorte?: number | null;
  prazoDePostagem?: number | null;
  horaPostagem?: number | null;
  minutosPostagem?: number | null;
  [DELETE_MARK]?: boolean;
  [key: string]: unknown;
}

const EMPTY_ROW: HorarioRow = {
  diaDaSemana: 1,
  horaDeCorte: null,
  minutosDeCorte: null,
  prazoDePostagem: null,
  horaPostagem: null,
  minutosPostagem: null,
};

const DIA_OPTIONS = (Object.entries(DIA_DA_SEMANA_LABELS) as [string, string][]).map(
  ([value, label]) => ({ value, label }),
);

function toRows(value: unknown): HorarioRow[] {
  return Array.isArray(value) ? (value as HorarioRow[]) : [];
}

export function HorarioCorteEditor({
  label,
  hint,
  value,
  onChange,
  onBlur,
  disabled,
  error,
  errorTree,
}: FieldRenderProps) {
  const rows = toRows(value);

  const patchRow = (index: number, patch: Partial<HorarioRow>) => {
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const numberCell = (
    index: number,
    errIdx: number,
    marked: boolean,
    key: keyof HorarioRow & string,
    cellLabel: string,
    max: number,
  ) => (
    <NumberInput
      label={cellLabel}
      aria-label={`${cellLabel} ${index + 1}`}
      value={(rows[index]?.[key] as number | null | undefined) ?? ''}
      onChange={(v) => patchRow(index, { [key]: typeof v === 'number' ? Math.trunc(v) : null })}
      onBlur={onBlur}
      disabled={disabled || marked}
      error={rowFieldError(errorTree, errIdx, key)}
      min={0}
      max={max}
      allowDecimal={false}
      w={92}
    />
  );

  // Validation runs on the value with marked rows stripped — see
  // FaixaCepEditor for the index-mapping rationale.
  const errIndices = validatedIndices(rows, DELETE_MARK);

  return (
    <Fieldset legend={label}>
      <Stack gap="sm">
        {hint && (
          <Text size="xs" c="dimmed">
            {hint}
          </Text>
        )}
        {rows.length === 0 && (
          <Text size="sm" c="dimmed">
            Nenhum horário de corte cadastrado.
          </Text>
        )}
        {rows.map((row, i) => {
          const marked = row[DELETE_MARK] === true;
          const errIdx = errIndices[i] ?? -1;
          return (
            <Group key={i} align="flex-end" gap="xs" opacity={marked ? 0.45 : 1} wrap="nowrap">
              <Select
                label="Dia da semana"
                aria-label={`Dia da semana ${i + 1}`}
                data={DIA_OPTIONS}
                value={String(row.diaDaSemana ?? 1)}
                onChange={(v) => {
                  if (v) patchRow(i, { diaDaSemana: Number(v) as DiaDaSemana });
                }}
                onBlur={onBlur}
                disabled={disabled || marked}
                error={rowFieldError(errorTree, errIdx, 'diaDaSemana')}
                allowDeselect={false}
                w={150}
              />
              {numberCell(i, errIdx, marked, 'horaDeCorte', 'Corte (h)', 23)}
              {numberCell(i, errIdx, marked, 'minutosDeCorte', 'Corte (min)', 59)}
              {numberCell(i, errIdx, marked, 'prazoDePostagem', 'Dias úteis', 31)}
              {numberCell(i, errIdx, marked, 'horaPostagem', 'Postagem (h)', 23)}
              {numberCell(i, errIdx, marked, 'minutosPostagem', 'Postagem (min)', 59)}
              {marked ? (
                <Group gap={4} wrap="nowrap">
                  <Text size="xs" c="red" fw={500}>
                    Será excluído
                  </Text>
                  <ActionIcon
                    type="button"
                    variant="subtle"
                    aria-label={`Desfazer exclusão do horário ${i + 1}`}
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
                  aria-label={`Excluir horário ${i + 1}`}
                  onClick={() => patchRow(i, { [DELETE_MARK]: true })}
                  disabled={disabled}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              )}
            </Group>
          );
        })}
        {rootError(errorTree, error) && (
          <Text size="xs" c="red">
            {rootError(errorTree, error)}
          </Text>
        )}
        <Group>
          <Button
            // Inside the ObjectView <form> an untyped button defaults to
            // type="submit" — row management must never submit.
            type="button"
            variant="light"
            size="xs"
            onClick={() => onChange([...rows, { ...EMPTY_ROW }])}
            disabled={disabled}
          >
            Adicionar horário
          </Button>
        </Group>
      </Stack>
    </Fieldset>
  );
}
