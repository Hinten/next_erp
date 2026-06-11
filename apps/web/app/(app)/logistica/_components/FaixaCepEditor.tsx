'use client';

import {
  ActionIcon,
  Button,
  Fieldset,
  Group,
  NumberInput,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconArrowBackUp, IconTrash } from '@tabler/icons-react';
import { DELETE_MARK, type FieldRenderProps } from '@delfrance/ui';

/**
 * One editable row of `intFrete.faixaCep`. Rows marked with `DELETE_MARK`
 * stay visible (dimmed, "Será excluída") with an undo affordance; the actual
 * removal happens at save time via `prepareForSave: stripMarkedForDeletion`
 * (CLAUDE.md rule 7 — see `intFreteFields.tsx` for the wiring).
 */
interface FaixaRow {
  cepInicial?: string;
  cepFinal?: string;
  custo?: number;
  valor?: number;
  prazo?: number;
  [DELETE_MARK]?: boolean;
  [key: string]: unknown;
}

const EMPTY_ROW: FaixaRow = { cepInicial: '', cepFinal: '', custo: 0, valor: 0, prazo: 0 };

function toRows(value: unknown): FaixaRow[] {
  return Array.isArray(value) ? (value as FaixaRow[]) : [];
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
}: FieldRenderProps) {
  const rows = toRows(value);

  const patchRow = (index: number, patch: Partial<FaixaRow>) => {
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

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
        {rows.map((row, i) => {
          const marked = row[DELETE_MARK] === true;
          return (
            <Group key={i} align="flex-end" gap="xs" opacity={marked ? 0.45 : 1} wrap="nowrap">
              <TextInput
                label="CEP Inicial"
                aria-label={`CEP Inicial ${i + 1}`}
                value={row.cepInicial ?? ''}
                onChange={(e) => patchRow(i, { cepInicial: onlyDigits(e.currentTarget.value) })}
                onBlur={onBlur}
                disabled={disabled || marked}
                w={110}
              />
              <TextInput
                label="CEP Final"
                aria-label={`CEP Final ${i + 1}`}
                value={row.cepFinal ?? ''}
                onChange={(e) => patchRow(i, { cepFinal: onlyDigits(e.currentTarget.value) })}
                onBlur={onBlur}
                disabled={disabled || marked}
                w={110}
              />
              <NumberInput
                label="Custo"
                aria-label={`Custo ${i + 1}`}
                value={row.custo ?? 0}
                onChange={(v) => patchRow(i, { custo: typeof v === 'number' ? v : 0 })}
                onBlur={onBlur}
                disabled={disabled || marked}
                min={0}
                decimalScale={2}
                w={100}
              />
              <NumberInput
                label="Preço"
                aria-label={`Preço ${i + 1}`}
                value={row.valor ?? 0}
                onChange={(v) => patchRow(i, { valor: typeof v === 'number' ? v : 0 })}
                onBlur={onBlur}
                disabled={disabled || marked}
                min={0}
                decimalScale={2}
                w={100}
              />
              <NumberInput
                label="Prazo (dias)"
                aria-label={`Prazo ${i + 1}`}
                value={row.prazo ?? 0}
                onChange={(v) => patchRow(i, { prazo: typeof v === 'number' ? Math.trunc(v) : 0 })}
                onBlur={onBlur}
                disabled={disabled || marked}
                min={0}
                allowDecimal={false}
                w={100}
              />
              {marked ? (
                <Group gap={4} wrap="nowrap">
                  <Text size="xs" c="red" fw={500}>
                    Será excluída
                  </Text>
                  <ActionIcon
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
                  variant="subtle"
                  color="red"
                  aria-label={`Excluir faixa ${i + 1}`}
                  onClick={() => patchRow(i, { [DELETE_MARK]: true })}
                  disabled={disabled}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              )}
            </Group>
          );
        })}
        {error && (
          <Text size="xs" c="red">
            {error}
          </Text>
        )}
        <Group>
          <Button
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
