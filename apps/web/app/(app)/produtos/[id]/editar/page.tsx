'use client';

import { useMemo, useRef } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { getDocs, writeBatch } from 'firebase/firestore';
import { type FieldConfig, ObjectView, PageHeader, stripMarkedForDeletion } from '@delfrance/ui';
import { PERM } from '@delfrance/auth';
import {
  type Foto,
  type Video,
  normalizeVariacoesUid,
  parseFakePath,
  produtoSchema,
  sortGrupoUids,
} from '@delfrance/schemas';
import { buildQuery, limit, orderByField, whereEqual } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { grupoDeVariacoesCollection } from '@/lib/data/grupoDeVariacoesCollection';
import {
  describeReferences,
  findProdutoReferences,
  hasReferences,
} from '@/lib/produtos/references';
import { getFirebaseFirestore, getFirebaseStorage } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import { PhotoManager } from '../../_components/PhotoManager';
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

  // Lifted from the VariationManager: the user's group selection (null until
  // touched) and the staged-children flush, committed after the parent saves.
  const groupsRef = useRef<string[] | null>(null);
  const flushChildrenRef = useRef<((parentId: string) => Promise<void>) | null>(null);

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
    }),
    [params.id, db, storage, grupos, gruposSnap.error?.message],
  );

  // The editor is the product screen now (the intermediate detail view was
  // removed) — it owns deletion too, behind ObjectView's typed-confirm modal.
  // Deleting a parent cascades its variation children in the same batch, but
  // only after every target passes the inbound-reference guard — a produto
  // still in a kit or linked to a marketplace listing blocks the whole
  // operation (#117/#135). Subcollection orphans are server-side (#136).
  async function handleDelete(id: string) {
    const childrenSnap = await getDocs(
      buildQuery(produtoCollection.ref(db, {}), [whereEqual('paiId', id)]),
    );
    const targets = [
      { id, nome: 'o produto' },
      ...childrenSnap.docs.map((d) => ({ id: d.id, nome: `a variação "${d.data().nome}"` })),
    ];
    const referenced = (
      await Promise.all(
        targets.map(async (t) => ({ ...t, refs: await findProdutoReferences(db, t.id) })),
      )
    ).filter((t) => hasReferences(t.refs));
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
    const batch = writeBatch(db);
    for (const child of childrenSnap.docs) batch.delete(child.ref);
    batch.delete(produtoCollection.docRef(db, {}, id));
    await batch.commit();
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
