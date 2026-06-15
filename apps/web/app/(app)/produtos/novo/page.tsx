'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Stack } from '@mantine/core';
import { writeBatch } from 'firebase/firestore';
import { type FieldConfig, ObjectView, PageHeader, stripMarkedForDeletion } from '@delfrance/ui';
import {
  type Foto,
  type PrecosMap,
  type Video,
  diffPrecos,
  produtoSchema,
} from '@delfrance/schemas';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import { appendPrecoHistory } from '@/lib/produtos/precoHistory';
import { getFirebaseFirestore, getFirebaseStorage } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';
import { PhotoManager } from '../_components/PhotoManager';
import { PrecoCustoManager } from '../_components/PrecoCustoManager';
import { VideoManager } from '../_components/VideoManager';
import { VariationManager } from '../_components/VariationManager';
import {
  PRODUTO_CREATE_DEFAULTS,
  PRODUTO_EXCLUDED_FIELDS,
  PRODUTO_SECTIONS,
  produtoFieldOverrides,
} from '../_components/produtoFields';

export default function NovoProdutoPage() {
  const router = useRouter();
  const { user } = useAuth();
  const db = getFirebaseFirestore();
  const storage = getFirebaseStorage();

  // Listas de preços (live, bounded) — the Preço e custo tab is editable
  // before the first save (precos is a doc field, unlike fotos).
  const listasQuery = useMemo(
    () => buildQuery(listaDePrecosCollection.ref(db, {}), [orderByField('nome'), limit(200)]),
    [db],
  );
  const listasSnap = useSnapshot(listasQuery);
  const listas = useMemo(() => listasSnap.data ?? [], [listasSnap.data]);

  // The Fotos/Vídeos tabs show even before the product is saved — the managers
  // render a "save first" message when produtoId is null (uploads need a saved
  // product).
  const fields = useMemo<Record<string, FieldConfig>>(
    () => ({
      ...produtoFieldOverrides,
      fotos: {
        label: 'Fotos',
        section: 'Fotos',
        prepareForSave: stripMarkedForDeletion,
        renderInput: (p) => (
          <PhotoManager
            produtoId={null}
            db={db}
            storage={storage}
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
            produtoId={null}
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
        // produtoId null → "save first" guard; children need a saved parent.
        renderInput: (p) => (
          <VariationManager
            produtoId={null}
            db={db}
            grupos={[]}
            value={(p.value as string[] | null) ?? null}
            onChange={p.onChange}
            onGroupsChange={() => undefined}
            flushRef={{ current: null }}
            disabled={p.disabled}
          />
        ),
      },
      precos: {
        label: 'Preços',
        section: 'Preço e custo',
        renderInput: (p) => (
          <PrecoCustoManager
            produtoId={null}
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
    [db, storage, listas, listasSnap.error?.message],
  );

  return (
    <Stack>
      <PageHeader
        title="Novo produto"
        actions={
          <Button component={Link} href="/produtos" variant="subtle">
            Voltar
          </Button>
        }
      />
      <ObjectView
        schema={produtoSchema}
        collection={produtoCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        defaultValues={PRODUTO_CREATE_DEFAULTS}
        sections={PRODUTO_SECTIONS}
        fields={fields}
        excludedFields={PRODUTO_EXCLUDED_FIELDS}
        saveLabel="Criar"
        showSaveAndContinue={false}
        onAfterSave={async (id, values) => {
          // First save of a produto born with prices → initial history records,
          // mirroring Flutter's oldPrecos-null branch. `values.precos` is what
          // was just persisted. New produtos have no variation children yet, so
          // there's nothing to propagate.
          const changes = diffPrecos(null, (values.precos as PrecosMap) ?? null);
          if (changes.length > 0) {
            const batch = writeBatch(db);
            appendPrecoHistory(batch, db, id, changes);
            await batch.commit();
          }
        }}
        onSaved={(id) => router.replace(`/produtos/${id}/editar`)}
      />
    </Stack>
  );
}
