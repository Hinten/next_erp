'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { type FieldConfig, ObjectView, PageHeader, stripMarkedForDeletion } from '@delfrance/ui';
import { PERM } from '@delfrance/auth';
import {
  type Anexo,
  type ComponentesKit,
  type Foto,
  type ImpostoProduto,
  type PrecosMap,
  type ProdutoExtraData,
  type Video,
  deriveFotosArquivosIds,
  normalizeVariacoesUid,
  parseFakePath,
  produtoPageBaseSchema,
  produtoPageIssues,
  sortGrupoUids,
} from '@delfrance/schemas';
import { buildQuery, limit, orderByField, whereEqual } from '@delfrance/data';
import {
  ProdutoReferencedError,
  applyPrecosChange,
  deleteProdutoCascade,
  recordCustoHistory,
} from '@delfrance/data/produto';
import { useDocSnapshot, useSnapshot } from '@delfrance/data/hooks';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { grupoDeVariacoesCollection } from '@/lib/data/grupoDeVariacoesCollection';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import { buildProdutoTransactionWrites, createClientProdutoPort } from '@/lib/produtos/clientPort';
import { getFirebaseFirestore, getFirebaseStorage } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import { AnexoManager } from '../../_components/AnexoManager';
import { PhotoManager } from '../../_components/PhotoManager';
import { CustoField } from '../../_components/CustoField';
import { EstoqueManager } from '../../_components/EstoqueManager';
import { ExtraDataManager } from '../../_components/ExtraDataManager';
import { ImpostoManager } from '../../_components/ImpostoManager';
import { KitManager, stripKitForSave } from '../../_components/KitManager';
import { KitVariacoesManager, type KitVariacoesFlush } from '../../_components/KitVariacoesManager';
import { PrecoCustoManager, stripPrecosForSave } from '../../_components/PrecoCustoManager';
import { VideoManager } from '../../_components/VideoManager';
import { VariationManager, type VariationRow } from '../../_components/VariationManager';
import {
  PRODUTO_EXCLUDED_FIELDS,
  PRODUTO_SECTIONS,
  PRODUTO_TRANSIENT_FIELDS,
  produtoFieldOverrides,
} from '../../_components/produtoFields';

export default function EditarProdutoPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.produto.write);
  const db = getFirebaseFirestore();
  const storage = getFirebaseStorage();
  // Client adapter for the framework-agnostic produto use-cases (history,
  // child-precos propagation, reference guard + cascade delete).
  const port = useMemo(() => createClientProdutoPort(db), [db]);

  // Variation groups (live) — shared between the Variações tab and the
  // save-time normalization in `deriveOnSave`. Bounded query (orderBy +
  // limit), matching the /variacoes TableView shape: the staging rules are
  // Flutter-owned and may reject unbounded collection scans.
  const gruposQuery = useMemo(
    () => buildQuery(grupoDeVariacoesCollection.ref(db, {}), [orderByField('ordem'), limit(200)]),
    [db],
  );
  const gruposSnap = useSnapshot(gruposQuery);
  const grupos = useMemo(() => gruposSnap.data ?? [], [gruposSnap.data]);

  // Listas de preços (live, bounded) — feed the Preço e custo tab.
  const listasQuery = useMemo(
    () => buildQuery(listaDePrecosCollection.ref(db, {}), [orderByField('nome'), limit(200)]),
    [db],
  );
  const listasSnap = useSnapshot(listasQuery);
  const listas = useMemo(() => listasSnap.data ?? [], [listasSnap.data]);

  // Lifted from the VariationManager: the user's group selection (null until
  // touched) and the staged-children flush, committed after the parent saves.
  const groupsRef = useRef<string[] | null>(null);
  const flushChildrenRef = useRef<((parentId: string) => Promise<void>) | null>(null);
  // Staged per-variation kit maps (the "Gerar Variações" grid), flushed AFTER
  // the variation-children flush so the child docs exist.
  const flushKitVariacoesRef = useRef<KitVariacoesFlush | null>(null);
  // The variation set the Kit tab consumes (the per-variation grid + the
  // component-picker exclusion: a kit can't contain itself or its variations).
  // VariationManager publishes the LIVE set (saved + staged) once its tab has
  // mounted — but React `<Activity>` keeps an unvisited tab's effects unmounted,
  // so until something is published we fall back to a page-level snapshot of the
  // saved children (this page component is always mounted, unlike a hidden tab).
  // Only the variation children are kept live here — not every tab's effects.
  const [variationRows, setVariationRows] = useState<VariationRow[]>([]);
  const childrenQuery = useMemo(
    () => buildQuery(produtoCollection.ref(db, {}), [whereEqual('paiId', params.id)]),
    [db, params.id],
  );
  const childrenSnap = useSnapshot(childrenQuery);
  const savedVariationRows = useMemo<VariationRow[]>(
    () =>
      [...(childrenSnap.data ?? [])]
        .sort((a, b) => (a.data.ordem ?? Infinity) - (b.data.ordem ?? Infinity))
        .map((r) => ({
          key: r.id,
          id: r.id,
          nome: r.data.nome,
          sku: r.data.sku ?? '',
          variacoesUid: r.data.variacoesUid ?? [],
          deleteMark: false,
        })),
    [childrenSnap.data],
  );
  const effectiveVariationRows = useMemo(
    () => (variationRows.length > 0 ? variationRows : savedVariationRows),
    [variationRows, savedVariationRows],
  );
  const kitExcludeIds = useMemo(
    () => [
      params.id,
      ...effectiveVariationRows.map((r) => r.id).filter((id): id is string => id !== null),
    ],
    [params.id, effectiveVariationRows],
  );

  // Price-history bookkeeping (Flutter parity: `Produto.save()` records every
  // precos change). `lastSavedPrecos` pins the PERSISTED map once, from the
  // first doc emit, so it can serve as the "old" value at onAfterSave time;
  // the "new" value is read back fresh from the just-saved parent doc (the
  // live snapshot can't be trusted to have re-emitted yet).
  const produtoDocRef = useMemo(() => produtoCollection.docRef(db, {}, params.id), [db, params.id]);
  const produtoSnap = useDocSnapshot(produtoDocRef);
  const lastSavedPrecos = useRef<{ ready: boolean; value: PrecosMap }>({
    ready: false,
    value: null,
  });
  // Same bookkeeping for `custo`: a historicoDeCusto record is written on each
  // change. `ready` guards the first emit so we don't record on initial load.
  const lastSavedCusto = useRef<{ ready: boolean; value: number | null }>({
    ready: false,
    value: null,
  });
  useEffect(() => {
    if (!lastSavedPrecos.current.ready && produtoSnap.data) {
      lastSavedPrecos.current = { ready: true, value: produtoSnap.data.data.precos ?? null };
      lastSavedCusto.current = { ready: true, value: produtoSnap.data.data.custo ?? null };
    }
  }, [produtoSnap.data]);

  // The product exists here (edit mode), so the Fotos/Vídeos managers are scoped
  // to this product and uploads are enabled.
  const fields = useMemo<Record<string, FieldConfig>>(
    () => ({
      ...produtoFieldOverrides,
      fotos: {
        label: 'Fotos',
        section: 'Fotos',
        prepareForSave: stripMarkedForDeletion,
        renderInput: (p) => (
          <PhotoManager
            produtoId={params.id}
            db={db}
            storage={storage}
            grupos={grupos}
            value={(p.value as Foto[] | null) ?? null}
            onChange={p.onChange}
            disabled={p.disabled}
          />
        ),
      },
      videos: {
        label: 'Vídeos',
        section: 'Vídeos',
        prepareForSave: stripMarkedForDeletion,
        renderInput: (p) => (
          <VideoManager
            produtoId={params.id}
            db={db}
            storage={storage}
            value={(p.value as Video[] | null) ?? null}
            onChange={p.onChange}
            disabled={p.disabled}
          />
        ),
      },
      anexos: {
        label: 'Anexos',
        section: 'Anexos',
        prepareForSave: stripMarkedForDeletion,
        renderInput: (p) => (
          <AnexoManager
            produtoId={params.id}
            db={db}
            storage={storage}
            value={(p.value as Anexo[] | null) ?? null}
            onChange={p.onChange}
            disabled={p.disabled}
          />
        ),
      },
      variacoesUid: {
        label: 'Variações',
        section: 'Variações',
        renderInput: (p) => (
          <VariationManager
            produtoId={params.id}
            db={db}
            grupos={grupos}
            gruposError={gruposSnap.error?.message}
            value={(p.value as string[] | null) ?? null}
            onChange={p.onChange}
            onGroupsChange={(ids) => {
              groupsRef.current = ids;
            }}
            onRowsChange={setVariationRows}
            flushRef={flushChildrenRef}
            disabled={p.disabled}
          />
        ),
      },
      custo: {
        ...produtoFieldOverrides.custo,
        renderInput: (p) => (
          <CustoField
            produtoId={params.id}
            db={db}
            value={(p.value as number | null) ?? null}
            onChange={p.onChange}
            label={p.label}
            hint={p.hint}
            disabled={p.disabled}
            error={p.error}
          />
        ),
      },
      precos: {
        label: 'Preços',
        section: 'Preço e custo',
        prepareForSave: stripPrecosForSave,
        renderInput: (p) => (
          <PrecoCustoManager
            produtoId={params.id}
            db={db}
            listas={listas}
            listasError={listasSnap.error?.message}
            value={(p.value as PrecosMap) ?? null}
            onChange={p.onChange}
            errorTree={p.errorTree}
            disabled={p.disabled}
          />
        ),
      },
      extraData: {
        label: 'Descrição',
        section: 'Descrição',
        renderInput: (p) => (
          <ExtraDataManager
            produtoId={params.id}
            db={db}
            value={(p.value as ProdutoExtraData | null) ?? null}
            onChange={p.onChange}
            errorTree={p.errorTree}
            disabled={p.disabled}
          />
        ),
      },
      estoques: {
        label: 'Estoque',
        section: 'Estoque',
        // Self-contained tab: lists the produto + each variation child, each
        // edited directly (decoupled from this form's save).
        renderInput: (p) => <EstoqueManager produtoId={params.id} db={db} disabled={p.disabled} />,
      },
      impostos: {
        label: 'Impostos',
        section: 'Impostos',
        renderInput: (p) => (
          <ImpostoManager
            produtoId={params.id}
            db={db}
            value={(p.value as ImpostoProduto[] | null) ?? null}
            onChange={p.onChange}
            errorTree={p.errorTree}
            disabled={p.disabled}
          />
        ),
      },
      componentesKit: {
        label: 'Componentes do kit',
        section: 'Kit',
        prepareForSave: stripKitForSave,
        renderInput: (p) => (
          <Stack gap="md">
            <KitManager
              produtoId={params.id}
              db={db}
              value={(p.value as ComponentesKit | null) ?? null}
              onChange={p.onChange}
              disabled={p.disabled}
              excludeIds={kitExcludeIds}
            />
            <KitVariacoesManager
              produtoId={params.id}
              db={db}
              grupos={grupos}
              rows={effectiveVariationRows}
              disabled={p.disabled}
              flushRef={flushKitVariacoesRef}
            />
          </Stack>
        ),
      },
    }),
    [
      params.id,
      db,
      storage,
      grupos,
      gruposSnap.error?.message,
      listas,
      listasSnap.error?.message,
      effectiveVariationRows,
      kitExcludeIds,
    ],
  );

  // The editor is the product screen now (the intermediate detail view was
  // removed) — it owns deletion too, behind ObjectView's typed-confirm modal.
  // The reference guard + variation cascade live in the domain use-case
  // (`deleteProdutoCascade`); a still-referenced target throws
  // `ProdutoReferencedError`, which we surface as a notification (any other
  // error — e.g. a FirebaseError from the batch — propagates to ObjectView's
  // alert). Subcollection orphans are swept server-side (#136).
  async function handleDelete(id: string) {
    try {
      await deleteProdutoCascade(port, id);
    } catch (err) {
      if (err instanceof ProdutoReferencedError) {
        notifications.show({
          color: 'red',
          title: 'Não é possível excluir',
          message: err.message,
          autoClose: 12_000,
        });
        return;
      }
      throw err;
    }
    router.replace('/produtos');
  }

  return (
    <Stack>
      <PageHeader
        title="Editar produto"
        actions={
          <Anchor component={Link} href="/produtos" size="sm">
            Cancelar
          </Anchor>
        }
      />
      <ObjectView
        schema={produtoPageBaseSchema}
        collection={produtoCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        sections={PRODUTO_SECTIONS}
        fields={fields}
        excludedFields={PRODUTO_EXCLUDED_FIELDS}
        transientFields={PRODUTO_TRANSIENT_FIELDS}
        transactionWrites={(id, values) => buildProdutoTransactionWrites(db, id, values)}
        deriveOnSave={(values) => {
          // Keep the Flutter wire shapes on every save: bare group ids sorted
          // by ordem, canonical group-major fake paths for the variants. The
          // group selection falls back to what the doc + variants imply when
          // the user never touched the selector.
          const uids = (values.variacoesUid as string[] | null) ?? [];
          const implied = [
            ...new Set([
              ...((values.grupoDeVariacoesUid as string[] | null) ?? []).map(
                (u) => u.split('/').pop()!,
              ),
              ...uids
                .map((u) => parseFakePath(u)?.grupoId)
                .filter((g): g is string => g !== undefined),
            ]),
          ];
          // Kit denormalization: `componentesKitKeys` mirrors the component ids
          // (the delete-guard queries it); a non-kit clears both.
          const ehKit = values.ehKit === true;
          const componentesKit = ehKit
            ? ((values.componentesKit as ComponentesKit | null) ?? null)
            : null;
          // Coexistence denorm for the legacy Flutter deletion guard — the bare
          // arquivo ids of the produto's photos (`models.dart:2022-2026`). `null`
          // (the schema default) when there are no fotos, so an untouched produto
          // isn't churned from `null` to `[]` on an unrelated save.
          const fotoIds = deriveFotosArquivosIds(values.fotos as Foto[] | null);
          return {
            grupoDeVariacoesUid: sortGrupoUids(groupsRef.current ?? implied, grupos),
            variacoesUid: normalizeVariacoesUid(uids, grupos),
            componentesKit,
            // Sorted so the denorm is order-stable — the keys feed an
            // `array-contains` query (order-insensitive), and Firestore arrays
            // are order-sensitive, so an unsorted list churns dirty detection.
            componentesKitKeys: componentesKit ? Object.keys(componentesKit).sort() : null,
            fotosArquivosIds: fotoIds.length > 0 ? fotoIds : null,
          };
        }}
        validate={(values) =>
          // Cross-document rules, concentrated in the page model
          // (`produtoPageIssues`). Estoque is edited directly in its tab (not on
          // this save), so it's not part of the form value here.
          produtoPageIssues({
            id: params.id,
            ehKit: values.ehKit as boolean | null,
            componentesKit: values.componentesKit as Record<string, { quantidade: number }> | null,
            impostos: (values.impostos as ImpostoProduto[] | null) ?? null,
          })
        }
        onAfterSave={async (id, values) => {
          // `values.precos`/`values.custo` are exactly what this save persisted
          // (ObjectView hands us the transformed values) — no captured-state
          // staleness, no re-read race. The domain use-cases record the history
          // and (on a real change) propagate the precos to every variation child
          // — which must fire even when only the Preço e custo tab was touched,
          // so it can't depend on the Variações tab's live snapshot.
          //
          // "Old" value = the ref pinned at the first doc emit, or — if a save
          // beat that emit — the live snapshot, so a fast first save still
          // records history and only propagates on a real change.
          const newPrecos = (values.precos as PrecosMap) ?? null;
          const oldPrecos = lastSavedPrecos.current.ready
            ? lastSavedPrecos.current.value
            : (produtoSnap.data?.data.precos ?? null);
          await applyPrecosChange(port, { produtoId: id, oldPrecos, newPrecos });
          lastSavedPrecos.current = { ready: true, value: newPrecos };

          // Cost history (historicoDeCusto): one record per change. Only a
          // numeric custo that actually differs from the last persisted value
          // is recorded (a cleared/null custo can't be represented as a record).
          const newCusto = typeof values.custo === 'number' ? values.custo : null;
          const oldCusto = lastSavedCusto.current.ready
            ? lastSavedCusto.current.value
            : (produtoSnap.data?.data.custo ?? null);
          if (newCusto !== null && newCusto !== oldCusto) {
            await recordCustoHistory(port, id, newCusto);
          }
          lastSavedCusto.current = { ready: true, value: newCusto };

          // (The extraData singleton is now written atomically with the produto
          // doc via `transactionWrites`, not here — so a flaky connection can't
          // leave the produto saved without its Descrição.)

          // The children flush runs before the kit-variation flush: it creates
          // any new children already carrying the parent's precos (plus their
          // initial history records).
          await flushChildrenRef.current?.(id);

          // Then persist each kit-variation child's generated `componentesKit`
          // (from "Gerar Variações") — the child docs exist by now.
          await flushKitVariacoesRef.current?.(id);
        }}
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        canDelete={canWrite}
        onDelete={handleDelete}
        deleteConfirmMessage="O produto e suas variações serão excluídos permanentemente. Esta ação não pode ser desfeita."
        onSaved={() => router.replace('/produtos')}
      />
    </Stack>
  );
}
