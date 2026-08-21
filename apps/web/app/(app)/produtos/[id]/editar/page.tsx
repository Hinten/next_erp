'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { z } from 'zod';
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
  buildFotoRefs,
  deriveFotosArquivosIds,
  normalizeVariacoesUid,
  parseFakePath,
  produtoPageIssues,
  sortGrupoUids,
} from '@delfrance/schemas';
import { buildQuery, limit, orderByField, whereArrayContains, whereEqual } from '@delfrance/data';
import {
  ProdutoReferencedError,
  deleteProdutoCascade,
  propagateKitStatusToChildren,
} from '@delfrance/data/produto';
import { useDocSnapshot, useSnapshot } from '@delfrance/data/hooks';
import { uploadProductImage } from '@delfrance/storage';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { grupoDeVariacoesCollection } from '@/lib/data/grupoDeVariacoesCollection';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import { buildProdutoTransactionWrites, createClientProdutoPort } from '@/lib/produtos/clientPort';
import { getFirebaseFirestore, getFirebaseStorage } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import { AnexoManager } from '../../_components/AnexoManager';
import { PhotoManager } from '@/components/photo-manager/PhotoManager';
import { CustoField } from '../../_components/CustoField';
import { MercadoLivreTab } from '../../_components/mercado-livre/MercadoLivreTab';
import { EhKitField } from '../../_components/EhKitField';
import { EstoqueManager } from '../../_components/EstoqueManager';
import { ExtraDataManager } from '../../_components/ExtraDataManager';
import { ImpostoManager } from '../../_components/ImpostoManager';
import { KitManager, stripKitForSave } from '../../_components/KitManager';
import { KitVariacoesManager, type KitVariacoesFlush } from '../../_components/KitVariacoesManager';
import { ModificacoesManager } from '../../_components/ModificacoesManager';
import { PrecoCustoManager, stripPrecosForSave } from '../../_components/PrecoCustoManager';
import { VideoManager } from '../../_components/VideoManager';
import { VariationManager, type VariationRow } from '../../_components/VariationManager';
import {
  PRODUTO_EXCLUDED_FIELDS,
  PRODUTO_PERSISTENT_SECTIONS,
  PRODUTO_SECTIONS_EDITAR,
  PRODUTO_TRANSIENT_FIELDS,
  SECTION_MERCADO_LIVRE,
  SECTION_MODIFICACOES,
  produtoFieldOverrides,
  produtoObjectViewSchema,
} from '../../_components/produtoFields';

/** Max referencing kits listed in the #246 promotion warning (a capped preview). */
const REFERENCED_BY_DISPLAY = 5;

/**
 * Edit-only page schema: the shared produto page model (which already carries
 * the `mercadoLivre` tab anchor) plus one more UI-anchor key, `modificacoes`,
 * whose only job is giving its tab a field descriptor — the tab is
 * self-contained; nothing is read from or written to the form value. Edit-only
 * because a modification history needs a SAVED produto, and there is nothing
 * useful to show for one that does not exist yet.
 */
const produtoEditarSchema = produtoObjectViewSchema.extend({
  modificacoes: z.null().default(null),
});

/** The shared transient keys plus the Modificações tab anchor. */
const PRODUTO_TRANSIENT_FIELDS_EDITAR = [...PRODUTO_TRANSIENT_FIELDS, 'modificacoes'];

export default function EditarProdutoPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.produto.write);
  const db = getFirebaseFirestore();
  const storage = getFirebaseStorage();
  // Client adapter for the framework-agnostic produto use-cases (kit-status
  // propagation, reference guard + cascade delete).
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
  // The Mercado Livre tab edits its OWN documents (the link subcollection), so
  // it is invisible to this form's `isDirty` — without both of these an operator
  // could edit an anúncio, hit "Salvar alterações", and lose the work with no
  // prompt at all. `mlDirty` arms the leave-guard through `extraDirty`; the
  // flush commits the edits as part of the produto save. Stays null while the
  // tab has never been opened (its editor chunk is not even loaded), which is
  // why the call below is optional.
  const flushMercadoLivreRef = useRef<(() => Promise<void>) | null>(null);
  const [mlDirty, setMlDirty] = useState(false);
  const handleMlDirtyChange = useCallback((dirty: boolean) => setMlDirty(dirty), []);
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

  // Live snapshot of this produto: feeds the parent-kit lookup below (`paiId`)
  // and the kit-status "old value" fallback in `onAfterSave` (precos/custo
  // history is no longer read from it — that bookkeeping is server-owned now,
  // see `lastSavedKitStatus` below).
  const produtoDocRef = useMemo(() => produtoCollection.docRef(db, {}, params.id), [db, params.id]);
  const produtoSnap = useDocSnapshot(produtoDocRef);
  // Parent kit-status (#298): when this produto is a variation child (`paiId`
  // set), read its parent once so the page model can enforce "a kit parent ⟹
  // its children are kits" on the CHILD-edit direction. Null ref (a parent
  // produto) → no read.
  const paiId = produtoSnap.data?.data.paiId ?? null;
  const paiDocRef = useMemo(
    () => (paiId ? produtoCollection.docRef(db, {}, paiId) : null),
    [db, paiId],
  );
  const paiSnap = useDocSnapshot(paiDocRef);
  const parentIsKit = paiSnap.data?.data.ehKit === true;

  // Kits that use THIS produto as a component (#246). Promoting this produto into
  // a kit while it's still a component creates a kit-of-kit (can corrupt stock),
  // so the "É kit" toggle warns + confirms when this list is non-empty. Same
  // denorm the delete guard queries (`componentesKitKeys` array-contains).
  const referencedByQuery = useMemo(
    () =>
      buildQuery(produtoCollection.ref(db, {}), [
        whereArrayContains('componentesKitKeys', params.id),
        // Fetch one past the display cap so we can flag "+ outros" without an
        // unbounded read — this is a best-effort warning, not an exhaustive list.
        limit(REFERENCED_BY_DISPLAY + 1),
      ]),
    [db, params.id],
  );
  const referencedBySnap = useSnapshot(referencedByQuery);
  const referencedByAll = useMemo(
    () =>
      (referencedBySnap.data ?? [])
        .filter((r) => r.id !== params.id)
        .map((r) => ({ id: r.id, nome: r.data.nome ?? r.id })),
    [referencedBySnap.data, params.id],
  );
  const referencedByKits = useMemo(
    () => referencedByAll.slice(0, REFERENCED_BY_DISPLAY),
    [referencedByAll],
  );
  // True when more kits reference this produto than we display (capped query).
  const referencedByMore = referencedByAll.length > REFERENCED_BY_DISPLAY;
  // Kit-status bookkeeping (Flutter parity, `produtoTableProvider.dart:556-589`):
  // when `ehKit`/`ehKitVirtual` flips, the existing variation children are
  // synced on save. `lastSavedKitStatus` pins the PERSISTED status once, from
  // the first doc emit, so it can serve as the "old" value at onAfterSave time
  // (precos/custo history had the same pinning idiom, but that bookkeeping is
  // gone now — the `onProdutoPrecoCustoChanged` trigger diffs against the
  // stored doc itself).
  const lastSavedKitStatus = useRef<{ ready: boolean; ehKit: boolean; ehKitVirtual: boolean }>({
    ready: false,
    ehKit: false,
    ehKitVirtual: false,
  });
  // Paint-then-correct, NOT gate-until-server: this ref is the "old" value
  // `propagateKitStatusToChildren` diffs against at save time, so it must be
  // populated the moment anything is loaded (a save that finds it unready would
  // diff against `false` and propagate a change that never happened). The cache
  // emission seeds it; the authoritative one corrects it, once, while it still
  // describes the LAST SAVED state — i.e. before the operator saves.
  const serverPinnedKitStatus = useRef(false);
  useEffect(() => {
    if (!produtoSnap.data) return;
    const serverTruth = produtoSnap.fromCache === false;
    if (lastSavedKitStatus.current.ready && !(serverTruth && !serverPinnedKitStatus.current)) {
      return;
    }
    lastSavedKitStatus.current = {
      ready: true,
      ehKit: produtoSnap.data.data.ehKit ?? false,
      ehKitVirtual: produtoSnap.data.data.ehKitVirtual ?? false,
    };
    if (serverTruth) serverPinnedKitStatus.current = true;
  }, [produtoSnap.data, produtoSnap.fromCache]);

  // The product exists here (edit mode), so the Fotos/Vídeos managers are scoped
  // to this product and uploads are enabled.
  const fields = useMemo<Record<string, FieldConfig>>(
    () => ({
      ...produtoFieldOverrides,
      // "É kit" with the kit-of-kit promotion warning (#246) — editar-only, since
      // it needs the referenced-by snapshot (a new produto can't be referenced).
      ehKit: {
        ...produtoFieldOverrides.ehKit,
        renderInput: (p) => (
          <EhKitField
            label={p.label}
            value={p.value === true}
            onChange={p.onChange}
            disabled={p.disabled}
            referencedByKits={referencedByKits}
            hasMore={referencedByMore}
            loading={referencedBySnap.loading}
          />
        ),
      },
      fotos: {
        label: 'Fotos',
        section: 'Fotos',
        prepareForSave: stripMarkedForDeletion,
        renderInput: (p) => (
          <PhotoManager
            db={db}
            grupos={grupos}
            uploadFoto={(file) =>
              uploadProductImage({
                storage,
                db,
                produtoId: params.id,
                bytes: file,
                contentType: file.type,
                originalFilename: file.name,
              }).then(({ id }) =>
                // Defensive: uploadProductImage returns `<produtoId>_<hash>`;
                // recover the hash, falling back to the raw id if the contract ever changes.
                buildFotoRefs(
                  params.id,
                  id.startsWith(`${params.id}_`) ? id.slice(params.id.length + 1) : id,
                ),
              )
            }
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
      mercadoLivre: {
        label: 'Mercado Livre',
        section: SECTION_MERCADO_LIVRE,
        // Self-contained tab (like Estoque): live link-doc status + the publish
        // action against the apps/mercado-livre backend, decoupled from this
        // form's save.
        //
        // Behind `MercadoLivreTab`, which defers loading the editor chunk until
        // the tab is actually opened — this panel is in
        // `PRODUTO_PERSISTENT_SECTIONS`, so it renders (effects and all) from
        // page load, and without the gate the import would start on every
        // produto edit.
        renderInput: (p) => (
          <MercadoLivreTab
            produtoId={params.id}
            db={db}
            disabled={p.disabled}
            onDirtyChange={handleMlDirtyChange}
            flushRef={flushMercadoLivreRef}
          />
        ),
      },
      modificacoes: {
        label: SECTION_MODIFICACOES,
        section: SECTION_MODIFICACOES,
        // Self-contained tab (like Estoque/Mercado Livre): a read-only feed of
        // the produto's unified `historicoDeModificacoes` entries with
        // per-field revert, decoupled from this form's save.
        renderInput: () => <ModificacoesManager produtoId={params.id} db={db} />,
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
      referencedByKits,
      referencedByMore,
      referencedBySnap.loading,
      handleMlDirtyChange,
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
        schema={produtoEditarSchema}
        collection={produtoCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        sections={PRODUTO_SECTIONS_EDITAR}
        persistentSections={PRODUTO_PERSISTENT_SECTIONS}
        fields={fields}
        excludedFields={PRODUTO_EXCLUDED_FIELDS}
        transientFields={PRODUTO_TRANSIENT_FIELDS_EDITAR}
        // Pending Mercado Livre edits live in their own documents and their own
        // form, so the leave-guard needs to be told about them explicitly.
        extraDirty={mlDirty}
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
          // ⚠️ Denorm written on EVERY save for the legacy Flutter deletion
          // guard — the bare arquivo ids of the produto's photos
          // (`models.dart:2022-2026`). That guard never runs against this
          // database (no dual run; root `CLAUDE.md` rule 8), so the reason is
          // VOID; the field is kept because the migrated corpus carries it and
          // dropping it is a real decision, not a drive-by edit. `null`
          // (the schema default) when there are no fotos, so an untouched produto
          // isn't churned from `null` to `[]` on an unrelated save.
          const fotoIds = deriveFotosArquivosIds(values.fotos as Foto[] | null);
          const gruposDerived = sortGrupoUids(groupsRef.current ?? implied, grupos);
          const variacoesDerived = normalizeVariacoesUid(uids, grupos);
          return {
            grupoDeVariacoesUid: gruposDerived.length > 0 ? gruposDerived : null,
            variacoesUid: variacoesDerived.length > 0 ? variacoesDerived : null,
            componentesKit,
            // Sorted so the denorm is order-stable — the keys feed an
            // `array-contains` query (order-insensitive), and Firestore arrays
            // are order-sensitive, so an unsorted list churns dirty detection.
            componentesKitKeys: componentesKit ? Object.keys(componentesKit).sort() : null,
            fotosArquivosIds: fotoIds.length > 0 ? fotoIds : null,
          };
        }}
        validate={(values) => {
          // Cross-document rules, concentrated in the page model
          // (`produtoPageIssues`). Estoque is edited directly in its tab (not on
          // this save), so it's not part of the form value here.
          const issues = [
            ...produtoPageIssues({
              id: params.id,
              ehKit: values.ehKit as boolean | null,
              // #298: a kit parent's variation children must also be kits.
              parentIsKit,
              componentesKit: values.componentesKit as Record<
                string,
                { quantidade: number }
              > | null,
              impostos: (values.impostos as ImpostoProduto[] | null) ?? null,
            }),
          ];
          // Guard the #298 race: a child whose parent doc hasn't loaded yet would
          // see `parentIsKit = false` and slip past the child-edit guard. Block
          // the save until the parent snapshot resolves.
          if (paiId && paiSnap.loading) {
            issues.push({
              path: 'ehKit',
              message: 'Aguarde o carregamento do produto pai para validar o kit.',
            });
          }
          return issues;
        }}
        onAfterSave={async (id, values) => {
          // Precos/custo history + child-precos propagation used to be recorded
          // here (client-side, diffed against `lastSavedPrecos`/`lastSavedCusto`).
          // Both are now server-owned: the `onProdutoPrecoCustoChanged` Cloud
          // Function trigger (since 2026-07-21) fires on the produto write this
          // save just made, diffs precos/custo against the previous doc itself,
          // records the history and propagates to the variation children — this
          // page no longer needs to (and skips entirely for a child produto,
          // `paiId != null`, and when `propagatePriceToChildren` is false).

          // Kit-status propagation (Flutter parity,
          // `produtoTableProvider.dart:556-589`): when the parent's
          // `ehKit`/`ehKitVirtual` flips, sync the EXISTING variation children —
          // a child of a non-kit can't stay a kit, so its `componentesKit` is
          // cleared. "Old" value = the ref pinned at the first emit, else the
          // live snapshot (so a save beating that emit still propagates).
          const newEhKit = values.ehKit === true;
          const newEhKitVirtual = values.ehKitVirtual === true;
          const oldKit = lastSavedKitStatus.current.ready
            ? lastSavedKitStatus.current
            : {
                ehKit: produtoSnap.data?.data.ehKit ?? false,
                ehKitVirtual: produtoSnap.data?.data.ehKitVirtual ?? false,
              };
          await propagateKitStatusToChildren(port, id, {
            ehKit: newEhKit,
            ehKitVirtual: newEhKitVirtual,
            oldEhKit: oldKit.ehKit,
            oldEhKitVirtual: oldKit.ehKitVirtual,
          });
          lastSavedKitStatus.current = {
            ready: true,
            ehKit: newEhKit,
            ehKitVirtual: newEhKitVirtual,
          };

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

          // Mercado Livre last: its link docs have six writers, so a save here
          // can lose a race and raise `AfterSaveBlockedError` (tier 3). Running
          // it after the child flushes means that pause never costs the produto
          // its own sibling writes — they are already committed.
          await flushMercadoLivreRef.current?.();
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
