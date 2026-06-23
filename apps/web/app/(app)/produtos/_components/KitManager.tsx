'use client';

import { useEffect, useMemo, useState } from 'react';
import { ActionIcon, Badge, Group, NumberInput, Stack, Switch, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowBackUp, IconTrash } from '@tabler/icons-react';
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

const fmtBRL = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

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
 * (mark → undo → removed on save). The kit cost is DYNAMIC (Flutter `getCusto`,
 * `produtoTableProvider.dart:1339`): Σ(component custo × quantidade) — read once
 * per component (`custoDoKit`, a single batched read) and pushed live into the
 * read-only `custo` field on any component/quantidade change. Gated on `ehKit`
 * (read live via `useFormContext`). `componentesKit` is a produto DOC field — it
 * rides the normal ObjectView save.
 */
export function KitManager({ produtoId, db, value, onChange, disabled }: KitManagerProps) {
  // RHF context is typed non-null but IS null outside a provider (ObjectView
  // mounts FormProvider) — guard with `?.`, mirroring PrecoCustoManager.
  const form = useFormContext();
  const ehKit = form?.watch('ehKit') === true;

  const components = useMemo(() => (value ?? {}) as Record<string, KitDraft>, [value]);
  const [pickerValue, setPickerValue] = useState<unknown>(null);
  // Component costs read once per component (a component's `custo` doesn't change
  // while editing this kit) — the kit cost re-sums from this cache on any
  // quantidade change without re-reading. `faltando` = components with no custo.
  const [custoCache, setCustoCache] = useState<Record<string, number | null>>({});

  const activeIds = useMemo(
    () =>
      Object.entries(components)
        .filter(([, e]) => !e._delete)
        .map(([id]) => id),
    [components],
  );
  const activeIdsKey = activeIds.join(',');

  // Read the custo of any newly-added component (batched); cached ones are reused.
  useEffect(() => {
    if (!ehKit) return;
    const missing = activeIds.filter((id) => !(id in custoCache));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map(async (id) => {
        const snap = await getDocFromServer(produtoCollection.docRef(db, {}, id));
        return [id, (snap.data()?.custo as number | null | undefined) ?? null] as const;
      }),
    )
      .then((pairs) => {
        if (!cancelled) setCustoCache((c) => ({ ...c, ...Object.fromEntries(pairs) }));
      })
      .catch((err: unknown) => {
        if (err instanceof FirebaseError) {
          notifications.show({
            color: 'red',
            message: `Falha ao ler o custo dos componentes: ${err.message}`,
          });
          return;
        }
        throw err;
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ehKit, activeIdsKey]);

  // Kit cost is DYNAMIC (Flutter `getCusto`): Σ(component custo × quantidade).
  // Derived (not state) — `null` until every active component's custo is cached;
  // a component with no custo lands in `faltando` and leaves `custo` untouched.
  const custoResult = useMemo(() => {
    if (activeIds.length === 0) return { custo: null as number | null, faltando: [] as string[] };
    if (activeIds.some((id) => !(id in custoCache))) return null; // wait for reads
    return custoDoKit(stripKitForSave(components) ?? {}, custoCache);
  }, [activeIds, custoCache, components]);

  // Push the computed cost into the read-only `custo` form field (writing to the
  // form = an external system, the legitimate use of an effect).
  useEffect(() => {
    if (!ehKit || !custoResult || custoResult.custo === null) return;
    if (form?.getValues('custo') !== custoResult.custo) {
      form?.setValue('custo', custoResult.custo, { shouldDirty: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ehKit, custoResult]);

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

  const custoKit = custoResult?.custo ?? null;
  const faltando = custoResult?.faltando ?? [];

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
      <Group justify="space-between" align="center">
        <Text size="sm" c="dimmed">
          Produtos que compõem o kit. O custo do kit é calculado automaticamente (soma dos
          componentes × quantidade) e preenche o campo Custo.
        </Text>
        {custoKit !== null && (
          <Text size="sm" fw={600}>
            Custo do kit: {fmtBRL(custoKit)}
          </Text>
        )}
      </Group>
      {faltando.length > 0 && (
        <Text size="sm" c="orange">
          {faltando.length} componente(s) sem custo cadastrado — o custo do kit não pôde ser
          calculado.
        </Text>
      )}

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
