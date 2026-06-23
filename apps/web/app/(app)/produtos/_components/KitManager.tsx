'use client';

import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  NumberInput,
  Stack,
  Switch,
  Text,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowBackUp, IconCalculator, IconTrash } from '@tabler/icons-react';
import { FirebaseError } from 'firebase/app';
import { type DocumentReference, type Firestore, getDocFromServer } from 'firebase/firestore';
import { useFormContext } from 'react-hook-form';
import { custoDoKit, type ComponentesKit, type Kit } from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { CollectionSelect } from '@/components/collection-select/CollectionSelect';
import { produtoCollection } from '@/lib/data/produtoCollection';

/** A working kit entry: the wire `Kit` plus a transient `_delete` marker. */
type KitDraft = Kit & { _delete?: boolean };

/**
 * Drop staged-deleted components and the transient `_delete` marker before the
 * value is validated/saved (wired as the `componentesKit` field's
 * `prepareForSave`). Returns `null` for an empty map so the produto doc stores a
 * clean `null` rather than `{}`.
 */
export function stripKitForSave(value: unknown): ComponentesKit | null {
  const map = (value ?? {}) as Record<string, KitDraft>;
  const out: ComponentesKit = {};
  for (const [id, entry] of Object.entries(map)) {
    if (entry?._delete) continue;
    const { _delete, ...rest } = entry ?? ({} as KitDraft);
    void _delete;
    out[id] = rest as Kit;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Produto id picked by the component `CollectionSelect` (emits a DocumentReference). */
function refToId(ref: unknown): string | null {
  if (ref && typeof ref === 'object' && 'id' in ref) return (ref as DocumentReference).id;
  return null;
}

/** Resolves a component produto's `<sku> - <nome>` for display. */
function ComponentLabel({ db, produtoId }: { db: Firestore; produtoId: string }) {
  const ref = useMemo(() => produtoCollection.docRef(db, {}, produtoId), [db, produtoId]);
  const snap = useDocSnapshot(ref);
  const data = snap.data?.data as { nome?: string | null; sku?: string | null } | undefined;
  const label = data ? `${data.sku ?? 'Sem SKU'} - ${data.nome ?? 'Sem nome'}` : produtoId;
  return (
    <Text size="sm" style={{ flex: 3, minWidth: 0 }}>
      {label}
    </Text>
  );
}

export interface KitManagerProps {
  /** `null` in create mode — the cost recalc still works once components exist. */
  produtoId: string | null;
  db: Firestore;
  /** The form's `componentesKit` value (map component id → Kit; may carry drafts). */
  value: ComponentesKit | null;
  onChange: (next: Record<string, KitDraft> | null) => void;
  disabled?: boolean;
}

/**
 * Kit tab — port of the Flutter `KitWidget` / `KitManagerWidget`
 * (`produtoCadastro.dart:1918`). Lists the kit's components (each a produto:
 * `quantidade ≥ 1` + `limitarEstoque`), with a staged-deletion trash button
 * (mark → undo → removed on save) and a "Recalcular custo do kit" button that
 * sums the component costs (`custoDoKit`, a single batched read) into the `custo`
 * field. Gated on `ehKit` (read live via `useFormContext`). `componentesKit` is a
 * produto DOC field — it rides the normal ObjectView save.
 */
export function KitManager({ produtoId, db, value, onChange, disabled }: KitManagerProps) {
  // RHF context is typed non-null but IS null outside a provider (ObjectView
  // mounts FormProvider) — guard with `?.`, mirroring PrecoCustoManager.
  const form = useFormContext();
  const ehKit = form?.watch('ehKit') === true;

  const components = useMemo(() => (value ?? {}) as Record<string, KitDraft>, [value]);
  const [pickerValue, setPickerValue] = useState<unknown>(null);
  const [recalculando, setRecalculando] = useState(false);

  const setComponent = (id: string, patch: Partial<KitDraft>) => {
    onChange({ ...components, [id]: { ...components[id], ...patch } as KitDraft });
  };

  const toggleDelete = (id: string) => {
    const entry = components[id];
    if (!entry) return;
    const next = { ...components };
    if (entry._delete) {
      const { _delete, ...rest } = entry;
      void _delete;
      next[id] = rest;
    } else {
      next[id] = { ...entry, _delete: true };
    }
    onChange(next);
  };

  const addComponent = (id: string | null) => {
    if (!id) return;
    if (id === produtoId) {
      notifications.show({
        color: 'yellow',
        message: 'Um produto não pode ser componente de si mesmo.',
      });
      return;
    }
    const existing = components[id];
    if (existing && !existing._delete) {
      notifications.show({ color: 'yellow', message: 'Este componente já foi adicionado.' });
      return;
    }
    // Re-add (un-delete) keeps the previous quantidade; a brand-new one defaults.
    const next = { ...components };
    next[id] = existing
      ? (() => {
          const { _delete, ...rest } = existing;
          void _delete;
          return rest;
        })()
      : { quantidade: 1, limitarEstoque: true, timestamp: null };
    onChange(next);
  };

  async function recalcularCusto() {
    const ids = Object.entries(components)
      .filter(([, e]) => !e._delete)
      .map(([id]) => id);
    if (ids.length === 0) return;
    setRecalculando(true);
    try {
      const custoById: Record<string, number | null> = {};
      await Promise.all(
        ids.map(async (id) => {
          const snap = await getDocFromServer(produtoCollection.docRef(db, {}, id));
          custoById[id] = (snap.data()?.custo as number | null | undefined) ?? null;
        }),
      );
      const { custo, faltando } = custoDoKit(stripKitForSave(components) ?? {}, custoById);
      if (faltando.length > 0) {
        notifications.show({
          color: 'yellow',
          message: `Sem custo cadastrado em ${faltando.length} componente(s) — custo do kit não calculado.`,
        });
        return;
      }
      if (custo !== null) {
        form?.setValue('custo', custo, { shouldDirty: true });
        notifications.show({ color: 'green', message: 'Custo do kit recalculado.' });
      }
    } catch (err) {
      if (err instanceof FirebaseError) {
        notifications.show({
          color: 'red',
          title: 'Falha ao recalcular o custo',
          message: err.message,
        });
        return;
      }
      throw err;
    } finally {
      setRecalculando(false);
    }
  }

  if (!ehKit) {
    return (
      <Text c="dimmed" size="sm">
        Marque “É kit” acima para definir os componentes do kit.
      </Text>
    );
  }

  const entries = Object.entries(components);

  return (
    <Stack gap="xs">
      <Group justify="space-between" align="flex-end">
        <Text size="sm" c="dimmed">
          Produtos que compõem o kit. O custo do kit é a soma dos componentes × quantidade.
        </Text>
        <Button
          variant="light"
          size="xs"
          leftSection={<IconCalculator size={16} />}
          onClick={recalcularCusto}
          loading={recalculando}
          disabled={disabled || entries.length === 0}
        >
          Recalcular custo do kit
        </Button>
      </Group>

      {entries.length === 0 && (
        <Text size="sm" c="dimmed">
          Adicione um componente do kit para continuar.
        </Text>
      )}

      {entries.map(([id, entry]) => {
        const marked = !!entry._delete;
        return (
          <Group key={id} wrap="nowrap" align="flex-end" gap="xs" opacity={marked ? 0.55 : 1}>
            <ComponentLabel db={db} produtoId={id} />
            <NumberInput
              label="Qtd"
              min={1}
              step={1}
              allowDecimal={false}
              value={entry.quantidade}
              onChange={(v) => setComponent(id, { quantidade: typeof v === 'number' ? v : 1 })}
              disabled={disabled || marked}
              w={90}
            />
            <Switch
              label="Limita estoque"
              checked={entry.limitarEstoque}
              onChange={(e) => setComponent(id, { limitarEstoque: e.currentTarget.checked })}
              disabled={disabled || marked}
              mb={6}
            />
            {marked && (
              <Badge color="red" variant="light" mb={8}>
                Será removido
              </Badge>
            )}
            {!disabled && (
              <Tooltip label={marked ? 'Desfazer remoção' : 'Remover componente'}>
                <ActionIcon
                  variant="subtle"
                  color={marked ? 'blue' : 'red'}
                  mb={4}
                  onClick={() => toggleDelete(id)}
                  aria-label={marked ? `Desfazer remoção ${id}` : `Remover componente ${id}`}
                >
                  {marked ? <IconArrowBackUp size={16} /> : <IconTrash size={16} />}
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        );
      })}

      {!disabled && (
        <CollectionSelect
          collection={produtoCollection}
          labelField="nome"
          searchFields={['nome', 'sku']}
          optionHintField="sku"
          fieldName="kit-add-component"
          label="Adicionar componente"
          hint="Selecione um produto para incluir no kit."
          value={pickerValue}
          onChange={(ref) => {
            addComponent(refToId(ref));
            setPickerValue(null);
          }}
        />
      )}
    </Stack>
  );
}
