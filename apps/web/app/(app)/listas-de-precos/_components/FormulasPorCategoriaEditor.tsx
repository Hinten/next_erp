'use client';

import { useState } from 'react';
import { ActionIcon, Fieldset, Group, Stack, Text, TextInput } from '@mantine/core';
import { IconArrowBackUp, IconTrash } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';
import { getDoc } from 'firebase/firestore';
import { useFormContext } from 'react-hook-form';
import { DELETE_MARK } from '@delfrance/ui';
import { CollectionSelect } from '@/components/collection-select/CollectionSelect';
import { categoriaCollection } from '@/lib/data/categoriaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { FormulaListEditor } from './FormulaListEditor';
import { stripFormulasCalculoPreco } from './formulaStrip';

/**
 * Read-only categoria name for a bucket header. The key is fixed for the life
 * of the card, so a one-shot `getDoc` (cached by TanStack Query) is enough — a
 * full `CollectionSelect` would mount a live `useDocSnapshot` listener, the
 * option-list query and the recents cache per entry, all wasted on a label
 * that never changes. Falls back to the raw id while loading or if the doc is
 * gone.
 */
function CategoriaNomeLabel({ categoriaId }: { categoriaId: string }) {
  const db = getFirebaseFirestore();
  const { data: nome } = useQuery({
    queryKey: ['categoria-nome', categoriaId],
    queryFn: async () => {
      const snap = await getDoc(categoriaCollection.docRef(db, {}, categoriaId));
      return snap.data()?.nome ?? null;
    },
  });
  return <TextInput label="Categoria" value={nome ?? categoriaId} readOnly variant="filled" />;
}

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
  const db = getFirebaseFirestore();
  // RHF context so `handleAdd` can read the sibling `formulasCalculoPreco`
  // field's live (possibly unsaved) value. Typed non-null by RHF but actually
  // `null` outside a `FormProvider` — this editor is always mounted inside
  // `ObjectView`'s provider (see `listaDePrecosFields.tsx`), so the `?? null`
  // fallbacks below are just defensive.
  const form = useFormContext();

  const patchEntry = (key: string, patch: Partial<CategoriaEntry>) => {
    onChange({ ...record, [key]: { ...record[key], ...patch } });
  };

  const handleAdd = async (raw: unknown) => {
    setPickerValue(null);
    const id = idFromRef(raw);
    if (!id) return;
    const existing = record[id];
    if (existing) {
      // Re-picking a category staged for deletion just un-stages it.
      if (existing[DELETE_MARK]) patchEntry(id, { [DELETE_MARK]: false });
      return;
    }
    // Legacy parity (.old/lib/produtos/pages/listaDePrecosCadastroView.dart:955-966):
    // adding a categoria snapshots the lista's CURRENT default
    // `formulasCalculoPreco` (deep copy, so later edits to either list never
    // cross-contaminate) into the new bucket, with any staged-deletion rows
    // already dropped. An empty default collapses to `null` — the pricing
    // engine already falls back to the default list for a null bucket.
    const rawDefault = form?.getValues('formulasCalculoPreco') ?? null;
    const formulasCalculoPreco = stripFormulasCalculoPreco(structuredClone(rawDefault));
    // Legacy also names the bucket after the categoria. `CollectionSelect`
    // only emits the picked doc-path (no label), so resolve the name the same
    // way `CategoriaNomeLabel` displays it below; fall back to the raw id if
    // the read fails or the doc has no `nome`.
    let name = id;
    try {
      const snap = await getDoc(categoriaCollection.docRef(db, {}, id));
      const nome = snap.data()?.nome;
      if (typeof nome === 'string' && nome) name = nome;
    } catch (err) {
      if (!(err instanceof FirebaseError)) throw err;
    }
    // Merge base re-read AFTER the awaited categoria fetch: `record` was
    // captured before the round-trip, so a concurrent edit during the await
    // (e.g. staging another bucket for deletion) would be clobbered by the
    // stale closure. The live RHF value is the freshest source.
    const live = form?.getValues('formulasPorCategoria');
    const base = live !== undefined ? toRecord(live) : record;
    onChange({ ...base, [id]: { name, formulasCalculoPreco } });
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
                    <CategoriaNomeLabel categoriaId={key} />
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
