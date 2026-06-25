'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Stack } from '@mantine/core';
import { type FieldConfig, ObjectView, PageHeader, stripMarkedForDeletion } from '@delfrance/ui';
import {
  type Anexo,
  type ComponentesKit,
  type Foto,
  type ImpostoProduto,
  type PrecosMap,
  type ProdutoExtraData,
  type Video,
  deriveFotosArquivosIds,
  produtoPageBaseSchema,
  produtoPageIssues,
} from '@delfrance/schemas';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import { applyPrecosChange, recordCustoHistory } from '@delfrance/data/produto';
import { useSnapshot } from '@delfrance/data/hooks';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import { buildProdutoTransactionWrites, createClientProdutoPort } from '@/lib/produtos/clientPort';
import { getFirebaseFirestore, getFirebaseStorage } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';
import { AnexoManager } from '../_components/AnexoManager';
import { PhotoManager } from '../_components/PhotoManager';
import { CustoField } from '../_components/CustoField';
import { EstoqueManager } from '../_components/EstoqueManager';
import { ExtraDataManager } from '../_components/ExtraDataManager';
import { ImpostoManager } from '../_components/ImpostoManager';
import { KitManager, stripKitForSave } from '../_components/KitManager';
import { PrecoCustoManager, stripPrecosForSave } from '../_components/PrecoCustoManager';
import { VideoManager } from '../_components/VideoManager';
import { VariationManager } from '../_components/VariationManager';
import {
  PRODUTO_CREATE_DEFAULTS,
  PRODUTO_EXCLUDED_FIELDS,
  PRODUTO_SECTIONS,
  PRODUTO_TRANSIENT_FIELDS,
  produtoFieldOverrides,
} from '../_components/produtoFields';

export default function NovoProdutoPage() {
  const router = useRouter();
  const { user } = useAuth();
  const db = getFirebaseFirestore();
  const storage = getFirebaseStorage();
  const port = useMemo(() => createClientProdutoPort(db), [db]);

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
      anexos: {
        label: 'Anexos',
        section: 'Anexos',
        prepareForSave: stripMarkedForDeletion,
        renderInput: (p) => (
          <AnexoManager
            produtoId={null}
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
      custo: {
        ...produtoFieldOverrides.custo,
        renderInput: (p) => (
          <CustoField
            produtoId={null}
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
            produtoId={null}
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
            produtoId={null}
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
        // Self-contained tab (decoupled from the parent save): in create mode it
        // shows "Salve o produto antes de editar o estoque".
        renderInput: (p) => <EstoqueManager produtoId={null} db={db} disabled={p.disabled} />,
      },
      impostos: {
        label: 'Impostos',
        section: 'Impostos',
        renderInput: (p) => (
          <ImpostoManager
            produtoId={null}
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
          <KitManager
            produtoId={null}
            db={db}
            value={(p.value as ComponentesKit | null) ?? null}
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
        schema={produtoPageBaseSchema}
        collection={produtoCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        defaultValues={PRODUTO_CREATE_DEFAULTS}
        sections={PRODUTO_SECTIONS}
        fields={fields}
        excludedFields={PRODUTO_EXCLUDED_FIELDS}
        transientFields={PRODUTO_TRANSIENT_FIELDS}
        transactionWrites={(id, values) => buildProdutoTransactionWrites(db, id, values)}
        saveLabel="Criar"
        showSaveAndContinue={false}
        deriveOnSave={(values) => {
          // Kit denormalization: `componentesKitKeys` mirrors the component ids
          // (the delete-guard queries it); a non-kit clears both.
          const ehKit = values.ehKit === true;
          const componentesKit = ehKit
            ? ((values.componentesKit as ComponentesKit | null) ?? null)
            : null;
          // Coexistence denorm for the legacy Flutter deletion guard — the bare
          // arquivo ids of the produto's photos (`models.dart:2022-2026`). `null`
          // (the schema default) when there are no fotos. (Create starts with no
          // fotos — uploads need a saved produtoId — so this is null at create.)
          const fotoIds = deriveFotosArquivosIds(values.fotos as Foto[] | null);
          return {
            componentesKit,
            // Sorted so the denorm is order-stable — the keys feed an
            // `array-contains` query (order-insensitive), and Firestore arrays
            // are order-sensitive, so an unsorted list churns dirty detection.
            componentesKitKeys: componentesKit ? Object.keys(componentesKit).sort() : null,
            fotosArquivosIds: fotoIds.length > 0 ? fotoIds : null,
          };
        }}
        validate={(values) =>
          produtoPageIssues({
            ehKit: values.ehKit as boolean | null,
            componentesKit: values.componentesKit as Record<string, { quantidade: number }> | null,
            impostos: (values.impostos as ImpostoProduto[] | null) ?? null,
          })
        }
        onAfterSave={async (id, values) => {
          // First save of a produto born with prices/cost → initial history
          // records (Flutter's oldPrecos-null branch). New produtos have no
          // variation children yet, so the propagation inside applyPrecosChange
          // is a no-op.
          await applyPrecosChange(port, {
            produtoId: id,
            oldPrecos: null,
            newPrecos: (values.precos as PrecosMap) ?? null,
          });
          const custo = typeof values.custo === 'number' ? values.custo : null;
          if (custo !== null) await recordCustoHistory(port, id, custo);

          // (The extraData singleton is written atomically with the produto doc
          // via `transactionWrites` — not here.)
        }}
        onSaved={(id) => router.replace(`/produtos/${id}/editar`)}
      />
    </Stack>
  );
}
