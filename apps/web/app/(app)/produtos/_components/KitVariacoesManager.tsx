'use client';

import { useEffect, useMemo, useState, type RefObject } from 'react';
import { Button, Divider, Group, Paper, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { FirebaseError } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';
import { useFormContext } from 'react-hook-form';
import {
  generateKitForVariacoes,
  resolveStagedKitVariacoes,
  type ComponentesKit,
  type GrupoComId,
} from '@delfrance/schemas';
import { saveChildrenComponentesKit } from '@delfrance/data/produto';
import { buildQuery, whereEqual } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { createClientProdutoPort, getVariationChildrenByParent } from '@/lib/produtos/clientPort';
import { KitManager, stripKitForSave } from './KitManager';
import type { VariationRow } from './VariationManager';

/** Persists the staged per-variation kit maps; called by the page after children flush. */
export type KitVariacoesFlush = (parentId: string) => Promise<void>;

export interface KitVariacoesManagerProps {
  /** Edit mode only — variation children exist only after the parent is saved. */
  produtoId: string;
  db: Firestore;
  /** Variation groups (for the matcher's linked-variant resolution). */
  grupos: GrupoComId[];
  /**
   * The current variation set (saved + staged), published by `VariationManager`.
   * Driving the grid off this lets "Gerar Variações" target variations that
   * aren't saved yet (full parity with the Flutter app).
   */
  rows: VariationRow[];
  disabled?: boolean;
  /** Registered with the page; invoked in `onAfterSave` (after the children flush). */
  flushRef: RefObject<KitVariacoesFlush | null>;
}

/**
 * Per-variation kit grid + "Gerar Variações" — port of the Flutter
 * `gerarComponentesParaVariacoes` UX (`produtoCadastro.dart` `KitWidget` +
 * `produtoTableProvider.dart:979`). Rendered below the parent `KitManager` on the
 * Kit tab (edit mode). Each kit-variation gets its own component editor (the
 * reused `KitManager`, forced to kit mode, not syncing cost to the parent form);
 * "Gerar Variações" runs the pure matcher (`generateKitForVariacoes`) and
 * **merges** the result into each variation's components (old `addChildrenMap`
 * semantics). The maps are flushed onto each child produto doc in `onAfterSave`
 * (after the variation-children flush) — staged-new variations are matched to
 * their freshly-minted child by `variacoesUid` via `resolveStagedKitVariacoes`.
 */
export function KitVariacoesManager({
  produtoId,
  db,
  grupos,
  rows,
  disabled,
  flushRef,
}: KitVariacoesManagerProps) {
  const form = useFormContext();
  const ehKit = form?.watch('ehKit') === true;

  // Saved children's persisted `componentesKit`, keyed by id — the initial value
  // of each existing row (the grid SET comes from `rows`, incl. staged ones).
  const childrenQuery = useMemo(
    () => buildQuery(produtoCollection.ref(db, {}), [whereEqual('paiId', produtoId)]),
    [db, produtoId],
  );
  const childrenSnap = useSnapshot(childrenQuery);
  const savedKitById = useMemo(() => {
    const map: Record<string, ComponentesKit | null> = {};
    for (const c of childrenSnap.data ?? []) map[c.id] = c.data.componentesKit ?? null;
    return map;
  }, [childrenSnap.data]);

  const visibleRows = useMemo(() => rows.filter((r) => !r.deleteMark), [rows]);

  // A kit-variation can't include the kit family (parent + any variation).
  const familyExcludeIds = useMemo(
    () => [produtoId, ...rows.map((r) => r.id).filter((id): id is string => id !== null)],
    [produtoId, rows],
  );

  // Staged per-variation maps, keyed by `VariationRow.key` (stable across save).
  const [staged, setStaged] = useState<Record<string, ComponentesKit | null>>({});
  const [gerando, setGerando] = useState(false);

  // Register the flush; re-registers when staged/rows change so the closure is fresh.
  useEffect(() => {
    flushRef.current = async (parentId) => {
      if (Object.keys(staged).length === 0) return;
      // Children now exist (created in the variation flush) — re-read to resolve
      // each staged row's key to the real child id (new rows match by combo).
      const byParent = await getVariationChildrenByParent(db, [parentId]);
      const resolved = resolveStagedKitVariacoes({
        stagedByKey: staged,
        rows,
        realChildren: byParent[parentId] ?? [],
      });
      await saveChildrenComponentesKit(
        createClientProdutoPort(db),
        resolved.map((r) => ({
          id: r.id,
          componentesKit: stripKitForSave(r.componentesKit ?? {}),
        })),
      );
    };
    return () => {
      flushRef.current = null;
    };
  }, [db, staged, rows, flushRef]);

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
        kitVariacoes: visibleRows.map((r) => ({ id: r.key, variacoesUid: r.variacoesUid })),
        componentVariacoesByComponentId,
        grupos,
      });
      // MERGE into each variation's existing map (old `addChildrenMap` — not a replace).
      setStaged((s) => {
        const next = { ...s };
        for (const row of visibleRows) {
          const generated = porFilho[row.key];
          if (!generated) continue;
          const existing =
            row.key in s ? (s[row.key] ?? {}) : row.id ? (savedKitById[row.id] ?? {}) : {};
          next[row.key] = { ...existing, ...generated };
        }
        return next;
      });
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

  // Hidden until the produto is a kit with variations to generate for.
  if (!ehKit || visibleRows.length === 0) return null;

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

      {visibleRows.map((row) => {
        const value =
          row.key in staged ? staged[row.key]! : row.id ? (savedKitById[row.id] ?? null) : null;
        return (
          <Paper key={row.key} withBorder p="sm" radius="sm">
            <Text fw={500} size="sm" mb="xs">
              {(row.sku || 'Sem SKU') + ' - ' + (row.nome || 'Sem nome')}
            </Text>
            <KitManager
              produtoId={row.id}
              db={db}
              ehKit
              syncCustoToForm={false}
              excludeIds={familyExcludeIds}
              value={value}
              onChange={(next) => setStaged((s) => ({ ...s, [row.key]: next }))}
              disabled={disabled}
            />
          </Paper>
        );
      })}
    </Stack>
  );
}
