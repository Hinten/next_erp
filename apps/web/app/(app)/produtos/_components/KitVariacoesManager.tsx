'use client';

import { useEffect, useMemo, useState, type RefObject } from 'react';
import { Button, Divider, Group, Modal, Paper, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { FirebaseError } from 'firebase/app';
import { getDocFromServer, type Firestore } from 'firebase/firestore';
import { useFormContext } from 'react-hook-form';
import {
  generateKitForVariacoes,
  resolveStagedKitVariacoes,
  type ComponentesKit,
  type GrupoComId,
} from '@delfrance/schemas';
import { buildQuery, whereEqual } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { AfterSaveBlockedError } from '@delfrance/ui';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { getVariationChildrenByParent } from '@/lib/produtos/clientPort';
import { commitChildKitEdits, type ChildKitEdit } from '@/lib/produtos/kitChildren';
import { KitManager, stripKitForSave } from './KitManager';
import type { VariationRow } from './VariationManager';

/**
 * Persists the staged per-variation kit maps; called by the page right after the
 * children flush, which hands over its `reusedByKey` pairing (`ChildrenFlushResult`)
 * — the only exact record of where a row absorbed by the #117 SKU id reuse was
 * written. It cannot travel through React state: the page awaits both flushes in
 * one microtask, so no render happens between them.
 */
export type KitVariacoesFlush = (
  parentId: string,
  reusedByKey: Record<string, string>,
  action?: 'save' | 'discard' | 'confirm-non-kit',
) => Promise<void>;

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
  resetRevisionRef: RefObject<number>;
  /** Registered with the page; invoked in `onAfterSave` (after the children flush). */
  flushRef: RefObject<KitVariacoesFlush | null>;
  /**
   * Publishes whether a per-variation composition is STAGED — held here, not
   * yet written onto its child by the flush. Same shape and timing as
   * `VariationManager`'s `onPriceDirtyChange`: an effect on the derived flag,
   * no cleanup, so pass a stable setter. The page ORs it into the leave-guard
   * (`extraDirty`) and into a Shopee draft's «Publicar» gate — the publish
   * derives a kit model's stock from the STORED child composition (#1911 P11
   * review, KNOWN #9 round 3). It turns `false` once the flush wrote or
   * dropped every entry; an `unresolved` one stays staged, and so does the
   * flag.
   */
  onDirtyChange?: (dirty: boolean) => void;
}

type SavedRecipes = Readonly<Record<string, ComponentesKit | null>>;

interface RecipeDraft {
  value: ComponentesKit | null;
  // An unsaved variation can reuse another document's id when saved (#117).
  // Capture the saved recipes together so that destination is guarded too.
  baseline: SavedRecipes;
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
 * (after the variation-children flush), using `resolveStagedKitVariacoes` to
 * find each draft's final document id.
 */
export function KitVariacoesManager({
  produtoId,
  db,
  grupos,
  rows,
  disabled,
  resetRevisionRef,
  flushRef,
  onDirtyChange,
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

  // Staged per-variation maps, keyed by `VariationRow.key` — a doc id on both
  // sides of the save, so the flush below releases an entry by the id it wrote.
  const [staged, setStaged] = useState<Record<string, RecipeDraft>>({});
  const [resetBaseline, setResetBaseline] = useState<SavedRecipes | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [gerando, setGerando] = useState(false);
  const saving = form?.formState.isSubmitting === true;
  const recipesReady =
    !childrenSnap.loading && !childrenSnap.error && childrenSnap.fromCache !== true;

  // Report the staged state to the page (`onDirtyChange`). Above the early
  // `return null` below, so a grid hidden by «É kit» off still reports. No
  // cleanup, like `VariationManager`'s reporters: the Kit tab is a persistent
  // section today, but were it ever hidden under `<Activity>` (which unmounts
  // effects and KEEPS state), a cleanup reporting `false` would open the
  // page's gates while the staged maps are still here, waiting for the save.
  const pendente = resetBaseline !== null || Object.keys(staged).length > 0;
  useEffect(() => {
    onDirtyChange?.(pendente);
  }, [pendente, onDirtyChange]);

  // Register the flush; re-registers when staged/rows change so the closure is fresh.
  useEffect(() => {
    flushRef.current = async (parentId, reusedByKey, action = 'save') => {
      if (action === 'confirm-non-kit') {
        if (!pendente && !gerando) return;
        const parent = (await getDocFromServer(produtoCollection.docRef(db, {}, parentId))).data();
        if (parent?.ehKit !== false) {
          throw new AfterSaveBlockedError(
            'O status do kit mudou. Recarregue o produto antes de salvar.',
          );
        }
      }
      if (action !== 'save') {
        resetRevisionRef.current += 1;
        setGerando(false);
        setStaged({});
        setResetBaseline(null);
        return;
      }
      if (gerando) {
        throw new AfterSaveBlockedError('Aguarde a geração dos componentes e salve novamente.');
      }
      if (!pendente) return;
      // Children now exist (created in the variation flush) — re-read to learn
      // which ids are live; `reusedByKey` covers the rows written under another id.
      const byParent = await getVariationChildrenByParent(db, [parentId]);
      const realChildren = byParent[parentId] ?? [];
      const { writes, unresolved, dropped } = resolveStagedKitVariacoes({
        stagedByKey: Object.fromEntries(
          Object.entries(staged).map(([key, draft]) => [key, draft.value]),
        ),
        rows,
        realChildren,
        resolvedByKey: reusedByKey,
      });
      const edits = new Map<string, ChildKitEdit>();
      if (resetBaseline) {
        for (const { id } of realChildren) {
          edits.set(id, { id, componentesKit: null, baseline: resetBaseline[id] ?? null });
        }
      }
      for (const { key, id, componentesKit } of writes) {
        edits.set(id, {
          id,
          componentesKit: stripKitForSave(componentesKit),
          baseline: staged[key]!.baseline[id] ?? null,
        });
      }
      await commitChildKitEdits(db, parentId, {
        recipes: [...edits.values()],
        mirrorSoleMember: resetBaseline !== null,
      });
      // Release by the SOURCE key, not the written id — the two differ exactly
      // when the pairing redirected a row, and releasing by id would then strand
      // the entry. `dropped` must go too: a map whose variation was deleted is
      // not just useless, it is dangerous, because the #117 reuse can put that
      // doc id BACK under a different variation and the stale entry would then
      // overwrite it. Only `unresolved` STAYS staged, so the operator can retry.
      const flushedKeys = new Set([...writes.map((w) => w.key), ...dropped]);
      setStaged((s) =>
        Object.fromEntries(Object.entries(s).filter(([key]) => !flushedKeys.has(key))),
      );
      setResetBaseline(null);
      if (unresolved.length > 0) {
        // Never silent: the save reports success, so without this the operator
        // is told their components were written when they were not.
        const rotulo = (key: string) => {
          const row = rows.find((r) => r.key === key);
          return row ? row.sku || row.nome || key : key;
        };
        notifications.show({
          color: 'yellow',
          title: 'Componentes por variação',
          autoClose: 10_000,
          message:
            `Não foi possível salvar os componentes de: ${unresolved.map(rotulo).join(', ')}. ` +
            'A variação correspondente não foi encontrada — os componentes seguem pendentes, ' +
            'confira a aba Variações e salve de novo.',
        });
      }
    };
    return () => {
      flushRef.current = null;
    };
  }, [db, staged, resetBaseline, rows, gerando, pendente, flushRef, resetRevisionRef]);

  const recomecar = () => {
    resetRevisionRef.current += 1;
    form?.setValue('componentesKit', null, { shouldDirty: true });
    setStaged({});
    setResetBaseline(savedKitById);
    setConfirmReset(false);
  };

  const gerar = async () => {
    const parentKit = stripKitForSave(form?.getValues('componentesKit')) ?? {};
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
    const requestRevision = resetRevisionRef.current;
    setGerando(true);
    try {
      const componentVariacoesByComponentId = await getVariationChildrenByParent(
        db,
        componentes.map((c) => c.produtoId),
      );
      if (resetRevisionRef.current !== requestRevision) return;
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
          const draft = s[row.key];
          const saved = row.id && resetBaseline === null ? savedKitById[row.id] : null;
          next[row.key] = {
            value: { ...(draft ? draft.value : saved), ...generated },
            baseline: draft?.baseline ?? resetBaseline ?? savedKitById,
          };
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
        if (resetRevisionRef.current !== requestRevision) return;
        notifications.show({
          color: 'red',
          message: `Falha ao gerar as variações: ${err.message}`,
        });
        return;
      }
      throw err;
    } finally {
      if (resetRevisionRef.current === requestRevision) setGerando(false);
    }
  };

  if (!ehKit) return null;
  const busy = disabled || saving || gerando || !recipesReady;

  return (
    <Stack gap="sm">
      {!disabled && (
        <Group justify="flex-end">
          <Button
            type="button"
            variant="default"
            disabled={busy}
            onClick={() => setConfirmReset(true)}
          >
            Recomeçar cadastro do kit
          </Button>
          {visibleRows.length > 0 && (
            <Button type="button" onClick={gerar} loading={gerando} disabled={busy} variant="light">
              Gerar Variações
            </Button>
          )}
        </Group>
      )}
      <Modal
        opened={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Recomeçar cadastro do kit"
      >
        <Stack>
          <Text size="sm">
            Isso limpa os componentes deste produto e de todas as suas variações no formulário. As
            alterações serão aplicadas ao salvar.
          </Text>
          <Group justify="flex-end">
            <Button type="button" variant="default" onClick={() => setConfirmReset(false)}>
              Cancelar
            </Button>
            <Button type="button" color="red" disabled={busy} onClick={recomecar}>
              Limpar componentes
            </Button>
          </Group>
        </Stack>
      </Modal>
      {visibleRows.length > 0 && <Divider label="Componentes por variação" labelPosition="left" />}

      {visibleRows.map((row, index) => {
        const draft = staged[row.key];
        const saved = row.id && resetBaseline === null ? savedKitById[row.id] : null;
        return (
          <Paper
            key={row.key}
            withBorder
            p="sm"
            radius="sm"
            bg={index % 2 === 1 ? 'var(--mantine-color-default-hover)' : undefined}
          >
            <Text fw={500} size="sm" mb="xs">
              {(row.sku || 'Sem SKU') + ' - ' + (row.nome || 'Sem nome')}
            </Text>
            <KitManager
              produtoId={row.id}
              db={db}
              ehKit
              syncCustoToForm={false}
              syncPesoToForm={false}
              excludeIds={familyExcludeIds}
              value={draft ? draft.value : (saved ?? null)}
              onChange={(value) =>
                setStaged((previous) => ({
                  ...previous,
                  [row.key]: {
                    value,
                    baseline: previous[row.key]?.baseline ?? resetBaseline ?? savedKitById,
                  },
                }))
              }
              disabled={busy}
              resetRevisionRef={resetRevisionRef}
            />
          </Paper>
        );
      })}
    </Stack>
  );
}
