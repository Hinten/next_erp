'use client';

import { useEffect, useMemo, useState, type RefObject } from 'react';
import { Button, Divider, Group, Paper, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { FirebaseError } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';
import { useFormContext } from 'react-hook-form';
import { generateKitForVariacoes, type ComponentesKit, type GrupoComId } from '@delfrance/schemas';
import { saveChildrenComponentesKit } from '@delfrance/data/produto';
import { buildQuery, whereEqual } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { createClientProdutoPort, getVariationChildrenByParent } from '@/lib/produtos/clientPort';
import { KitManager, stripKitForSave } from './KitManager';

/** Persists the staged per-child kit maps; called by the page after children flush. */
export type KitVariacoesFlush = (parentId: string) => Promise<void>;

export interface KitVariacoesManagerProps {
  /** Edit mode only — variation children exist only after the parent is saved. */
  produtoId: string;
  db: Firestore;
  /** Variation groups (for the matcher's linked-variant resolution). */
  grupos: GrupoComId[];
  disabled?: boolean;
  /** Registered with the page; invoked in `onAfterSave` (after the children flush). */
  flushRef: RefObject<KitVariacoesFlush | null>;
}

/**
 * Per-variation kit grid + "Gerar Variações" — port of the Flutter
 * `gerarComponentesParaVariacoes` UX (`produtoCadastro.dart` `KitWidget` +
 * `produtoTableProvider.dart:979`). Rendered below the parent `KitManager` on the
 * Kit tab (edit mode). Each kit-variation child gets its own component editor
 * (the reused `KitManager`, forced to kit mode, not syncing cost to the parent
 * form); the "Gerar Variações" button runs the pure matcher
 * (`generateKitForVariacoes`) to auto-fill each child's components from the
 * parent's, then stages the maps for the parent save. The staged maps are flushed
 * onto each child produto doc in `onAfterSave` (after the variation-children flush
 * so the docs exist).
 */
export function KitVariacoesManager({
  produtoId,
  db,
  grupos,
  disabled,
  flushRef,
}: KitVariacoesManagerProps) {
  const form = useFormContext();
  const ehKit = form?.watch('ehKit') === true;

  // Live variation children (paiId == produtoId), sorted client-side by `ordem`
  // (Firestore's orderBy would silently drop docs missing the field).
  const childrenQuery = useMemo(
    () => buildQuery(produtoCollection.ref(db, {}), [whereEqual('paiId', produtoId)]),
    [db, produtoId],
  );
  const childrenSnap = useSnapshot(childrenQuery);
  const children = useMemo(
    () =>
      [...(childrenSnap.data ?? [])].sort(
        (a, b) => (a.data.ordem ?? Infinity) - (b.data.ordem ?? Infinity),
      ),
    [childrenSnap.data],
  );

  // Staged per-child maps (keyed by child id) — set by "Gerar Variações" and by
  // manual per-child edits; only these are flushed. A child absent from `staged`
  // keeps its persisted map untouched.
  const [staged, setStaged] = useState<Record<string, ComponentesKit | null>>({});
  const [gerando, setGerando] = useState(false);

  // Register the flush with the page; re-registers when `staged` changes so the
  // closure always persists the latest per-child maps.
  useEffect(() => {
    flushRef.current = async () => {
      const entries = Object.entries(staged);
      if (entries.length === 0) return;
      await saveChildrenComponentesKit(
        createClientProdutoPort(db),
        entries.map(([id, map]) => ({ id, componentesKit: stripKitForSave(map ?? {}) })),
      );
    };
    return () => {
      flushRef.current = null;
    };
  }, [db, flushRef, staged]);

  const gerar = async () => {
    const parentKit = stripKitForSave(form?.watch('componentesKit')) ?? {};
    const componentes = Object.entries(parentKit).map(([id, k]) => ({
      produtoId: id,
      quantidade: k.quantidade,
      limitarEstoque: k.limitarEstoque,
    }));
    if (componentes.length === 0) {
      notifications.show({
        color: 'yellow',
        message: 'Adicione ao menos um componente ao kit antes de gerar as variações.',
      });
      return;
    }
    setGerando(true);
    try {
      const componentVariacoesByComponentId = await getVariationChildrenByParent(
        db,
        componentes.map((c) => c.produtoId),
      );
      const { porFilho, warnings, errors } = generateKitForVariacoes({
        componentes,
        kitVariacoes: children.map((c) => ({
          id: c.id,
          variacoesUid: c.data.variacoesUid ?? [],
        })),
        componentVariacoesByComponentId,
        grupos,
      });
      setStaged((s) => ({ ...s, ...porFilho }));
      if (errors.length > 0) {
        notifications.show({
          color: 'red',
          title: 'Gerar Variações',
          message: [...errors, ...warnings].join('\n'),
        });
      } else if (warnings.length > 0) {
        notifications.show({
          color: 'yellow',
          title: 'Gerar Variações',
          message: warnings.join('\n'),
        });
      } else {
        notifications.show({ color: 'green', message: 'Componentes gerados para as variações.' });
      }
    } catch (err: unknown) {
      if (err instanceof FirebaseError) {
        notifications.show({
          color: 'red',
          message: `Falha ao gerar as variações: ${err.message}`,
        });
        return;
      }
      throw err;
    } finally {
      setGerando(false);
    }
  };

  // Hidden until the produto is a kit with variation children to generate for.
  if (!ehKit || children.length === 0) return null;

  return (
    <Stack gap="sm">
      <Divider label="Componentes por variação" labelPosition="left" />
      <Group justify="space-between" align="center">
        <Text size="sm" c="dimmed">
          Gere os componentes de cada variação do kit a partir dos componentes acima — cada variação
          recebe a variação correspondente de cada componente.
        </Text>
        <Button onClick={gerar} loading={gerando} disabled={disabled} variant="light">
          Gerar Variações
        </Button>
      </Group>

      {children.map((child) => {
        const value = child.id in staged ? staged[child.id]! : (child.data.componentesKit ?? null);
        return (
          <Paper key={child.id} withBorder p="sm" radius="sm">
            <Text fw={500} size="sm" mb="xs">
              {(child.data.sku ?? 'Sem SKU') + ' - ' + (child.data.nome ?? 'Sem nome')}
            </Text>
            <KitManager
              produtoId={child.id}
              db={db}
              ehKit
              syncCustoToForm={false}
              value={value}
              onChange={(next) => setStaged((s) => ({ ...s, [child.id]: next }))}
              disabled={disabled}
            />
          </Paper>
        );
      })}
    </Stack>
  );
}
