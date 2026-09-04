'use client';

import { ActionIcon, Button, Group, NumberInput, Stack, Text, TextInput } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import type { MensagemInatividadeWebchat } from '@delfrance/schemas';
import { DELETE_MARK, type FieldRenderProps } from '@delfrance/ui';

type Row = MensagemInatividadeWebchat & { [DELETE_MARK]?: boolean };

const MAX_ROWS = 3;
const DEFAULT_TEMPO_INATIVIDADE = 60;

/**
 * `mensagens_inatividade` — up to 3 rows of `{ mensagem, tempo_inatividade }`,
 * hard client-side cap (the schema also caps it via `.max(3)`). Removal is
 * staged per `apps/web/CLAUDE.md` rule 7: clicking the trash icon MARKS the
 * row (`DELETE_MARK`) instead of splicing it out immediately, so it stays
 * visible (dimmed, with an undo) until the record is saved — wire
 * `prepareForSave: stripMarkedForDeletion` on this field alongside this
 * component (see `webchatFieldOverrides.tsx`).
 */
export function MensagensInatividadeField({
  value,
  onChange,
  label,
  hint,
  disabled,
  errorTree,
}: FieldRenderProps) {
  const rows: Row[] = Array.isArray(value) ? (value as Row[]) : [];
  const activeCount = rows.filter((r) => !r[DELETE_MARK]).length;
  const rowErrors = (errorTree ?? []) as Array<
    { mensagem?: { message?: string }; tempo_inatividade?: { message?: string } } | undefined
  >;

  function update(index: number, patch: Partial<Row>): void {
    const next = rows.map((r, i) => (i === index ? { ...r, ...patch } : r));
    onChange(next);
  }

  function markDeleted(index: number, deleted: boolean): void {
    update(index, { [DELETE_MARK]: deleted } as Partial<Row>);
  }

  function addRow(): void {
    onChange([
      ...rows,
      { mensagem: '', tempo_inatividade: DEFAULT_TEMPO_INATIVIDADE } satisfies Row,
    ]);
  }

  return (
    <Stack gap="xs">
      <Text fw={500} size="sm">
        {label}
      </Text>
      {hint && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
      {rows.map((row, index) => {
        const deleted = Boolean(row[DELETE_MARK]);
        return (
          <Group key={index} align="flex-start" gap="sm" wrap="nowrap" opacity={deleted ? 0.5 : 1}>
            <TextInput
              placeholder="Mensagem"
              value={row.mensagem ?? ''}
              onChange={(e) => update(index, { mensagem: e.currentTarget.value })}
              disabled={disabled || deleted}
              error={rowErrors[index]?.mensagem?.message}
              style={{ flex: 1 }}
            />
            <NumberInput
              placeholder="Segundos"
              value={row.tempo_inatividade ?? DEFAULT_TEMPO_INATIVIDADE}
              onChange={(v) =>
                update(index, {
                  tempo_inatividade: typeof v === 'number' ? v : DEFAULT_TEMPO_INATIVIDADE,
                })
              }
              disabled={disabled || deleted}
              error={rowErrors[index]?.tempo_inatividade?.message}
              min={1}
              max={3600}
              allowDecimal={false}
              w={140}
            />
            {deleted ? (
              <Button
                size="compact-sm"
                variant="subtle"
                onClick={() => markDeleted(index, false)}
                disabled={disabled}
              >
                Desfazer
              </Button>
            ) : (
              <ActionIcon
                color="red"
                variant="subtle"
                aria-label="Remover mensagem de inatividade"
                onClick={() => markDeleted(index, true)}
                disabled={disabled}
              >
                <IconTrash size={16} />
              </ActionIcon>
            )}
          </Group>
        );
      })}
      {activeCount < MAX_ROWS && (
        <Button
          leftSection={<IconPlus size={14} />}
          variant="light"
          size="compact-sm"
          onClick={addRow}
          disabled={disabled}
          style={{ alignSelf: 'flex-start' }}
        >
          Adicionar mensagem
        </Button>
      )}
    </Stack>
  );
}
