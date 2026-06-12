'use client';

import { useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { getDocs, writeBatch } from 'firebase/firestore';
import { type FieldConfig, ObjectView, PageHeader, stripMarkedForDeletion } from '@delfrance/ui';
import { PERM } from '@delfrance/auth';
import {
  type Foto,
  type PrecosMap,
  type Video,
  diffPrecos,
  normalizeVariacoesUid,
  parseFakePath,
  produtoSchema,
  sortGrupoUids,
} from '@delfrance/schemas';
import { buildQuery, limit, orderByField, whereEqual } from '@delfrance/data';
import { useDocSnapshot, useSnapshot } from '@delfrance/data/hooks';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { grupoDeVariacoesCollection } from '@/lib/data/grupoDeVariacoesCollection';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import { appendPrecoHistory } from '@/lib/produtos/precoHistory';
import {
  describeReferences,
  findManyProdutoReferences,
  hasReferences,
} from '@/lib/produtos/references';
import { getFirebaseFirestore, getFirebaseStorage } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import { PhotoManager } from '../../_components/PhotoManager';
import { PrecoCustoManager } from '../../_components/PrecoCustoManager';
import { VideoManager } from '../../_components/VideoManager';
import { VariationManager } from '../../_components/VariationManager';
import {
  PRODUTO_EXCLUDED_FIELDS,
  PRODUTO_SECTIONS,
  produtoFieldOverrides,
} from '../../_components/produtoFields';

export default function EditarProdutoPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.produto.write);
  const db = getFirebaseFirestore();
  const storage = getFirebaseStorage();

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

  // Price-history bookkeeping (Flutter parity: `Produto.save()` records every
  // precos change). `lastSavedPrecos` pins the PERSISTED map once, from the
  // first doc emit — the live snapshot re-emits the NEW value during a save,
  // so it can't serve as "old" at onAfterSave time. `pendingPrecos` is
  // captured by the field's prepareForSave on every save attempt.
  const produtoDocRef = useMemo(() => produtoCollection.docRef(db, {}, params.id), [db, params.id]);
  const produtoSnap = useDocSnapshot(produtoDocRef);
  const lastSavedPrecos = useRef<{ ready: boolean; value: PrecosMap }>({
    ready: false,
    value: null,
  });
  useEffect(() => {
    if (!lastSavedPrecos.current.ready && produtoSnap.data) {
      lastSavedPrecos.current = { ready: true, value: produtoSnap.data.data.precos ?? null };
    }
  }, [produtoSnap.data]);
  // Stable mutable box rather than a ref: it's written inside ObjectView's
  // save handler (prepareForSave) — an event-time context the
  // react-hooks/refs rule would misread as a render-time ref access.
  const pendingPrecos = useMemo(() => ({ current: null as PrecosMap }), []);

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
            flushRef={flushChildrenRef}
            disabled={p.disabled}
          />
        ),
      },
      precos: {
        label: 'Preços',
        section: 'Preço e custo',
        // Capture the map heading into this save — onAfterSave diffs it
        // against the last persisted value for the history records.
        prepareForSave: (value) => {
          pendingPrecos.current = (value as PrecosMap) ?? null;
          return value;
        },
        renderInput: (p) => (
          <PrecoCustoManager
            produtoId={params.id}
            db={db}
            listas={listas}
            listasError={listasSnap.error?.message}
            value={(p.value as PrecosMap) ?? null}
            onChange={p.onChange}
            disabled={p.disabled}
          />
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
      pendingPrecos,
    ],
  );

  // The editor is the product screen now (the intermediate detail view was
  // removed) — it owns deletion too, behind ObjectView's typed-confirm modal.
  // Deleting a parent cascades its variation children, but only after every
  // target passes the inbound-reference guard — a produto still in a kit or
  // linked to a marketplace listing blocks the whole operation (#117/#135).
  // Subcollection orphans are server-side (#136).
  async function handleDelete(id: string) {
    const childrenSnap = await getDocs(
      buildQuery(produtoCollection.ref(db, {}), [whereEqual('paiId', id)]),
    );
    const targets = [
      { id, nome: 'o produto' },
      ...childrenSnap.docs.map((d) => ({ id: d.id, nome: `a variação "${d.data().nome}"` })),
    ];
    const refsById = await findManyProdutoReferences(
      db,
      targets.map((t) => t.id),
    );
    const referenced = targets
      .map((t) => ({ ...t, refs: refsById.get(t.id)! }))
      .filter((t) => hasReferences(t.refs));
    if (referenced.length > 0) {
      notifications.show({
        color: 'red',
        title: 'Não é possível excluir',
        message: `${referenced
          .map((t) => `${t.nome} está ${describeReferences(t.refs)}`)
          .join('; ')}. Remova os vínculos antes de excluir.`,
        autoClose: 12_000,
      });
      return;
    }
    // A writeBatch caps at 500 operations — chunk large variation sets. The
    // parent goes in the LAST batch so a partial failure leaves it (and the
    // delete affordance) in place; retrying resumes over the remaining docs.
    const docRefs = [...childrenSnap.docs.map((d) => d.ref), produtoCollection.docRef(db, {}, id)];
    const BATCH_LIMIT = 499;
    for (let i = 0; i < docRefs.length; i += BATCH_LIMIT) {
      const batch = writeBatch(db);
      for (const ref of docRefs.slice(i, i + BATCH_LIMIT)) batch.delete(ref);
      await batch.commit();
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
        schema={produtoSchema}
        collection={produtoCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        sections={PRODUTO_SECTIONS}
        fields={fields}
        excludedFields={PRODUTO_EXCLUDED_FIELDS}
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
          return {
            grupoDeVariacoesUid: sortGrupoUids(groupsRef.current ?? implied, grupos),
            variacoesUid: normalizeVariacoesUid(uids, grupos),
          };
        }}
        onAfterSave={async (id) => {
          // Price history first (Flutter parity), then the children flush —
          // which propagates the new precos to every variation child and
          // writes the initial records for children created with prices.
          if (lastSavedPrecos.current.ready) {
            const changes = diffPrecos(lastSavedPrecos.current.value, pendingPrecos.current);
            if (changes.length > 0) {
              const batch = writeBatch(db);
              appendPrecoHistory(batch, db, id, changes);
              await batch.commit();
            }
            lastSavedPrecos.current = { ready: true, value: pendingPrecos.current };
          }
          await flushChildrenRef.current?.(id);
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
