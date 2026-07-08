'use client';

import { useState } from 'react';
import { ActionIcon, Fieldset, Group, Stack, Text, TextInput } from '@mantine/core';
import { IconArrowBackUp, IconTrash } from '@tabler/icons-react';
import { DELETE_MARK } from '@delfrance/ui';
import { CollectionSelect } from '@/components/collection-select/CollectionSelect';
import { categoriaCollection } from '@/lib/data/categoriaCollection';
import { FormulaListEditor } from './FormulaListEditor';

/**
 * One category bucket of pricing formulas (`FormulasPorCategoria`). Entries
 * marked with `DELETE_MARK` stay visible (dimmed, "Será excluída") with an undo
 * affordance; the actual removal happens at save time via the field's
 * `prepareForSave` (`stripFormulasPorCategoria`) — CLAUDE.md rule 7.
 */
interface CategoriaEntry {
  name?: string;
  formulasCalculoPreco?: unknown;
  [DELETE_MARK]?: boolean;
  [key: string]: unknown;
}

/** The record shape held in the form (category id → bucket). */
type CategoriaRecord = Record<string, CategoriaEntry>;

function toRecord(value: unknown): CategoriaRecord {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as CategoriaRecord)
    : {};
}

/** Trailing id segment of a `documents/categorias/<id>` doc-path string. */
function idFromRef(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.split('/').filter(Boolean).pop();
  return id ?? null;
}

export interface FormulasPorCategoriaEditorProps {
  label?: string;
  hint?: string;
  value: unknown;
  onChange: (next: CategoriaRecord) => void;
  disabled?: boolean;
  errorTree?: unknown;
}

export function FormulasPorCategoriaEditor({
  label,
  hint,
  value,
  onChange,
  disabled,
  errorTree,
}: FormulasPorCategoriaEditorProps) {
  const record = toRecord(value);
  const entries = Object.entries(record);
  // Local so the "add" picker resets to empty after each pick (it never holds
  // a persistent value — the picked category becomes a card below).
  const [pickerValue, setPickerValue] = useState<unknown>(null);

  const patchEntry = (key: string, patch: Partial<CategoriaEntry>) => {
    onChange({ ...record, [key]: { ...record[key], ...patch } });
  };

  const handleAdd = (raw: unknown) => {
    setPickerValue(null);
    const id = idFromRef(raw);
    if (!id) return;
    const existing = record[id];
    if (existing) {
      // Re-picking a category staged for deletion just un-stages it.
      if (existing[DELETE_MARK]) patchEntry(id, { [DELETE_MARK]: false });
      return;
    }
    onChange({ ...record, [id]: { name: '', formulasCalculoPreco: null } });
  };

  const perEntryError = (key: string): unknown => {
    if (errorTree == null || typeof errorTree !== 'object') return undefined;
    const node = (errorTree as Record<string, unknown>)[key];
    if (node == null || typeof node !== 'object') return undefined;
    return (node as Record<string, unknown>).formulasCalculoPreco;
  };

  return (
    <Fieldset legend={label}>
      <Stack gap="md">
        {hint && (
          <Text size="xs" c="dimmed">
            {hint}
          </Text>
        )}
        {entries.length === 0 && (
          <Text size="sm" c="dimmed">
            Nenhuma categoria configurada.
          </Text>
        )}
        {entries.map(([key, entry]) => {
          const marked = entry[DELETE_MARK] === true;
          return (
            <Fieldset key={key} opacity={marked ? 0.5 : 1}>
              <Stack gap="sm">
                <Group justify="space-between" align="flex-start" wrap="nowrap">
                  <div style={{ flex: 1 }}>
                    {/* Resolves the category id to its name (read-only display). */}
                    <CollectionSelect
                      collection={categoriaCollection}
                      labelField="nome"
                      fieldName={`formulasPorCategoria.${key}.categoria`}
                      label="Categoria"
                      value={`documents/${categoriaCollection.resolvePath({})}/${key}`}
                      onChange={() => undefined}
                      disabled
                    />
                  </div>
                  {marked ? (
                    <Group gap={4} wrap="nowrap" pt={28}>
                      <Text size="xs" c="red" fw={500}>
                        Será excluída
                      </Text>
                      <ActionIcon
                        type="button"
                        variant="subtle"
                        aria-label={`Desfazer exclusão da categoria ${key}`}
                        onClick={() => patchEntry(key, { [DELETE_MARK]: false })}
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
                      aria-label={`Excluir categoria ${key}`}
                      onClick={() => patchEntry(key, { [DELETE_MARK]: true })}
                      disabled={disabled}
                      mt={28}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  )}
                </Group>
                <TextInput
                  label="Nome da categoria"
                  aria-label={`Nome da categoria ${key}`}
                  value={entry.name ?? ''}
                  onChange={(e) => patchEntry(key, { name: e.currentTarget.value })}
                  disabled={disabled || marked}
                />
                <FormulaListEditor
                  value={entry.formulasCalculoPreco}
                  onChange={(formulas) => patchEntry(key, { formulasCalculoPreco: formulas })}
                  disabled={disabled || marked}
                  errorTree={perEntryError(key)}
                  scope={` da categoria ${key}`}
                />
              </Stack>
            </Fieldset>
          );
        })}
        {!disabled && (
          <CollectionSelect
            collection={categoriaCollection}
            labelField="nome"
            fieldName="formulasPorCategoria.add"
            label="Adicionar categoria"
            hint="Selecione uma categoria para configurar fórmulas específicas."
            value={pickerValue}
            onChange={handleAdd}
          />
        )}
      </Stack>
    </Fieldset>
  );
}
