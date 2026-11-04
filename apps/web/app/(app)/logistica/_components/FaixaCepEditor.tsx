'use client';

import {
  ActionIcon,
  Box,
  Button,
  Fieldset,
  Group,
  NumberInput,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconArrowBackUp, IconTrash } from '@tabler/icons-react';
import { DELETE_MARK, type FieldRenderProps, DecimalInput } from '@delfrance/ui';
import { rootError, rowError, rowFieldError, validatedIndices } from './editorErrors';

/**
 * One editable row of `intFrete.faixaCep`. Rows marked with `DELETE_MARK`
 * stay visible (dimmed, "Será excluída") with an undo affordance; the actual
 * removal happens at save time via `prepareForSave: stripMarkedForDeletion`
 * (CLAUDE.md rule 7 — see `intFreteFields.tsx` for the wiring).
 */
interface FaixaRow {
  cepInicial?: string;
  cepFinal?: string;
  custo?: number | null;
  valor?: number | null;
  prazo?: number | null;
  [DELETE_MARK]?: boolean;
  [key: string]: unknown;
}

const EMPTY_ROW: FaixaRow = {
  cepInicial: '',
  cepFinal: '',
  custo: null,
  valor: null,
  prazo: null,
};

function toRows(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/**
 * The fields of one stored row — what the row SHOWS, and what an edit of it
 * starts from. A row that is not an object (`null`, a string — imported shapes
 * the schema does not model) reads as the blank row "Adicionar faixa" starts
 * from, instead of crashing the editor and with it the whole motoboy screen.
 * It is kept verbatim until the operator edits or deletes it; then the edit
 * lands on that blank row, never on the stored value (spreading a string
 * would save one key per character). The same guard `HorarioCorteEditor` has.
 */
function camposDe(row: unknown): FaixaRow {
  return row !== null && typeof row === 'object' ? (row as FaixaRow) : EMPTY_ROW;
}

const onlyDigits = (s: string) => s.replace(/\D/g, '').slice(0, 8);

export function FaixaCepEditor({
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

  const patchRow = (index: number, patch: Partial<FaixaRow>) => {
    onChange(rows.map((r, i) => (i === index ? { ...camposDe(r), ...patch } : r)));
  };

  // Validation runs on the value with marked rows stripped, so the error
  // index of a visible row is the count of UNMARKED rows before it; marked
  // rows aren't validated and show no errors (errIdx = -1).
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
            Nenhuma faixa de CEP cadastrada.
          </Text>
        )}
        {rows.map((stored, i) => {
          const row = camposDe(stored);
          const marked = row[DELETE_MARK] === true;
          const errIdx = errIndices[i] ?? -1;
          const erroDaLinha = rowError(errorTree, errIdx);
          return (
            <Stack key={i} gap={4}>
              <Group align="flex-start" gap="xs" opacity={marked ? 0.45 : 1} wrap="nowrap">
                <TextInput
                  label="CEP Inicial"
                  aria-label={`CEP Inicial ${i + 1}`}
                  value={row.cepInicial ?? ''}
                  onChange={(e) => patchRow(i, { cepInicial: onlyDigits(e.currentTarget.value) })}
                  onBlur={onBlur}
                  disabled={disabled || marked}
                  error={rowFieldError(errorTree, errIdx, 'cepInicial')}
                  w={110}
                />
                <TextInput
                  label="CEP Final"
                  aria-label={`CEP Final ${i + 1}`}
                  value={row.cepFinal ?? ''}
                  onChange={(e) => patchRow(i, { cepFinal: onlyDigits(e.currentTarget.value) })}
                  onBlur={onBlur}
                  disabled={disabled || marked}
                  error={rowFieldError(errorTree, errIdx, 'cepFinal')}
                  w={110}
                />
                <DecimalInput
                  label="Custo"
                  ariaLabel={`Custo ${i + 1}`}
                  value={row.custo ?? null}
                  onChange={(n) => patchRow(i, { custo: n })}
                  onBlur={onBlur}
                  disabled={disabled || marked}
                  error={rowFieldError(errorTree, errIdx, 'custo')}
                  min={0}
                  decimalScale={2}
                  w={100}
                />
                <DecimalInput
                  label="Preço"
                  ariaLabel={`Preço ${i + 1}`}
                  value={row.valor ?? null}
                  onChange={(n) => patchRow(i, { valor: n })}
                  onBlur={onBlur}
                  disabled={disabled || marked}
                  error={rowFieldError(errorTree, errIdx, 'valor')}
                  min={0}
                  decimalScale={2}
                  w={100}
                />
                <NumberInput
                  label="Prazo (dias)"
                  aria-label={`Prazo ${i + 1}`}
                  value={row.prazo ?? ''}
                  onChange={(v) =>
                    patchRow(i, { prazo: typeof v === 'number' ? Math.trunc(v) : null })
                  }
                  onBlur={onBlur}
                  disabled={disabled || marked}
                  error={rowFieldError(errorTree, errIdx, 'prazo')}
                  min={0}
                  allowDecimal={false}
                  w={100}
                />
                <Box pt={25}>
                  {marked ? (
                    <Group gap={4} wrap="nowrap">
                      <Text size="xs" c="red" fw={500}>
                        Será excluída
                      </Text>
                      <ActionIcon
                        type="button"
                        variant="subtle"
                        aria-label={`Desfazer exclusão da faixa ${i + 1}`}
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
                      aria-label={`Excluir faixa ${i + 1}`}
                      onClick={() => patchRow(i, { [DELETE_MARK]: true })}
                      disabled={disabled}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  )}
                </Box>
              </Group>
              {erroDaLinha && (
                <Text size="xs" c="red">
                  {erroDaLinha}
                </Text>
              )}
            </Stack>
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
            Adicionar faixa
          </Button>
        </Group>
      </Stack>
    </Fieldset>
  );
}
