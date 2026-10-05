'use client';

import { Button, Group, Stack, Text } from '@mantine/core';
import { DELETE_MARK, stripMarkedForDeletion, type FieldRenderProps } from '@delfrance/ui';
import { normalizeTelefone, normalizeTelefoneInternacional } from '@delfrance/core/phone';
import { TelefoneTextInput } from './TelefoneInput';

type PhoneRow = string | { telefone: string; edited?: boolean; [DELETE_MARK]?: boolean };

function rowsOf(value: unknown): PhoneRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is PhoneRow =>
      typeof row === 'string' ||
      (typeof row === 'object' &&
        row !== null &&
        'telefone' in row &&
        typeof row.telefone === 'string'),
  );
}

/** Keep removals visible and reversible until the parent cliente is saved. */
export function TelefonesAdicionaisInput({
  value,
  onChange,
  disabled,
  error,
  errorTree,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  error?: string;
  errorTree?: unknown;
}) {
  const rows = rowsOf(value);
  const changeRow = (index: number, next: PhoneRow) =>
    onChange(rows.map((row, i) => (i === index ? next : row)));
  return (
    <Stack gap="xs">
      <Text size="sm" fw={500}>
        Telefones adicionais
      </Text>
      <Text size="xs" c="dimmed">
        Números anteriores ou alternativos. Não alteram o destinatário do WhatsApp. As alterações
        serão aplicadas ao salvar o cliente.
      </Text>
      {rows.map((row, index) => {
        const removed = typeof row !== 'string' && row[DELETE_MARK] === true;
        const telefone = typeof row === 'string' ? row : row.telefone;
        const displayPhone =
          (typeof row === 'string' || !row.edited) && telefone !== '' ? `+${telefone}` : telefone;
        const rowError =
          errorTree && typeof errorTree === 'object'
            ? (Reflect.get(
                errorTree,
                rows
                  .slice(0, index)
                  .filter((entry) => typeof entry === 'string' || entry[DELETE_MARK] !== true)
                  .length,
              ) as unknown)
            : null;
        const rowMessage =
          rowError &&
          typeof rowError === 'object' &&
          'message' in rowError &&
          typeof rowError.message === 'string'
            ? rowError.message
            : undefined;
        return (
          <Group key={index} align="flex-start" wrap="nowrap">
            <Stack gap={2} style={{ flex: 1, opacity: removed ? 0.5 : 1 }}>
              <TelefoneTextInput
                label={`Telefone adicional ${String(index + 1)}`}
                value={displayPhone}
                error={removed ? undefined : rowMessage}
                onChange={(next) => changeRow(index, { telefone: next, edited: true })}
                disabled={disabled || removed}
              />
              {removed && <Text size="xs">Será excluído ao salvar</Text>}
            </Stack>
            <Button
              mt={24}
              size="xs"
              variant="subtle"
              disabled={disabled}
              onClick={() =>
                changeRow(
                  index,
                  removed
                    ? typeof row !== 'string' && row.edited
                      ? { telefone, edited: true }
                      : telefone
                    : {
                        telefone,
                        edited: typeof row !== 'string' && row.edited,
                        [DELETE_MARK]: true,
                      },
                )
              }
            >
              {removed ? 'Desfazer' : 'Remover'}
            </Button>
          </Group>
        );
      })}
      {error && (
        <Text size="xs" c="red" role="alert">
          {error}
        </Text>
      )}
      <Button
        variant="light"
        size="xs"
        disabled={disabled}
        onClick={() => onChange([...rows, { telefone: '', edited: true }])}
      >
        Adicionar telefone
      </Button>
    </Stack>
  );
}

export function prepareForSaveTelefonesAdicionais(value: unknown): unknown {
  const active = stripMarkedForDeletion(value);
  if (!Array.isArray(active)) return active;
  return active.map((phone: unknown) => {
    if (typeof phone === 'string') return normalizeTelefoneInternacional(phone) ?? phone;
    if (
      phone &&
      typeof phone === 'object' &&
      'telefone' in phone &&
      typeof phone.telefone === 'string'
    )
      return normalizeTelefone(phone.telefone);
    return phone;
  });
}

export function TelefonesAdicionaisField(props: FieldRenderProps) {
  return <TelefonesAdicionaisInput {...props} />;
}
