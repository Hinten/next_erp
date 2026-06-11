'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Stack } from '@mantine/core';
import { type FieldConfig, ObjectView, PageHeader, stripMarkedForDeletion } from '@delfrance/ui';
import { type Foto, type Video, produtoSchema } from '@delfrance/schemas';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { getFirebaseFirestore, getFirebaseStorage } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';
import { PhotoManager } from '../_components/PhotoManager';
import { VideoManager } from '../_components/VideoManager';
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
    }),
    [db, storage],
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
        onSaved={(id) => router.replace(`/produtos/${id}/editar`)}
      />
    </Stack>
  );
}
