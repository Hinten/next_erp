'use client';

import type { ReactNode } from 'react';
import { ActionIcon, Button, Group, Stack, Text, TextInput } from '@mantine/core';

export interface ChaveListEditorProps {
  titulo: ReactNode;
  descricao?: ReactNode;
  /** Shown when the list is empty. */
  vazio: string;
  value: readonly string[];
  /** Receives the whole new list; the caller decides how an empty one is stored. */
  onChange: (next: string[]) => void;
  /** The error for one non-empty chave, or undefined when it is fine. */
  validar: (chave: string) => string | undefined;
  /** Label of the first input (the others carry none, as one column). */
  labelPrimeiro: string;
  /** Accessible name of the add button (two lists share a tab — "+ Adicionar" alone is ambiguous). */
  rotuloAdicionar: string;
  /** Accessible name of each remove button. */
  rotuloRemover: string;
  /** A list-level message (the page model's), under the inputs. */
  erro?: string;
  disabled?: boolean;
}

/**
 * An editable list of chaves de acesso — one input per chave, "+ Adicionar" and
 * a remove button per row. Shared by the pedido's note-level references
 * (`chNFeReferenciadas`) and the NF-e de pagamento antecipado
 * (`chNFePagamentoAntecipado`, #331), each with its own rule in `validar`.
 */
export function ChaveListEditor({
  titulo,
  descricao,
  vazio,
  value,
  onChange,
  validar,
  labelPrimeiro,
  rotuloAdicionar,
  rotuloRemover,
  erro,
  disabled,
}: ChaveListEditorProps) {
  return (
    <Stack gap="xs">
      <Group justify="space-between" align="center">
        <Text fw={500}>{titulo}</Text>
        <Button
          type="button"
          size="xs"
          variant="light"
          onClick={() => onChange([...value, ''])}
          aria-label={rotuloAdicionar}
          disabled={disabled}
        >
          + Adicionar
        </Button>
      </Group>
      {descricao != null && (
        <Text size="sm" c="dimmed">
          {descricao}
        </Text>
      )}
      {value.length === 0 && (
        <Text size="sm" c="dimmed">
          {vazio}
        </Text>
      )}
      {value.map((atual, index) => (
        <Group key={index} align="end">
          <TextInput
            style={{ flex: 1 }}
            label={index === 0 ? labelPrimeiro : undefined}
            value={atual ?? ''}
            onChange={(e) => {
              const next = [...value];
              next[index] = e.currentTarget.value;
              onChange(next);
            }}
            maxLength={44}
            error={atual ? validar(atual) : undefined}
            disabled={disabled}
          />
          <ActionIcon
            type="button"
            color="red"
            variant="subtle"
            onClick={() => onChange(value.filter((_, i) => i !== index))}
            aria-label={rotuloRemover}
            disabled={disabled}
          >
            ✕
          </ActionIcon>
        </Group>
      ))}
      {erro && (
        <Text size="sm" c="red">
          {erro}
        </Text>
      )}
    </Stack>
  );
}
