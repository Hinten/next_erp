'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Stack } from '@mantine/core';
import { type FieldConfig, ObjectView, PageHeader } from '@delfrance/ui';
import { PERM } from '@delfrance/auth';
import { type Foto, produtoSchema } from '@delfrance/schemas';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { getFirebaseFirestore, getFirebaseStorage } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import { PhotoManager } from '../../_components/PhotoManager';
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

  // The product exists here (edit mode), so the Fotos tab is available and the
  // `fotos` field gets a PhotoManager renderer scoped to this product.
  const sections = useMemo(() => [...PRODUTO_SECTIONS, 'Fotos'], []);
  const excludedFields = useMemo(() => PRODUTO_EXCLUDED_FIELDS.filter((f) => f !== 'fotos'), []);
  const fields = useMemo<Record<string, FieldConfig>>(
    () => ({
      ...produtoFieldOverrides,
      fotos: {
        label: 'Fotos',
        section: 'Fotos',
        renderInput: (p) => (
          <PhotoManager
            produtoId={params.id}
            db={db}
            storage={storage}
            value={(p.value as Foto[] | null) ?? null}
            onChange={p.onChange}
            disabled={p.disabled}
          />
        ),
      },
    }),
    [params.id, db, storage],
  );

  return (
    <Stack>
      <PageHeader
        title="Editar produto"
        actions={
          <Anchor component={Link} href={`/produtos/${params.id}`} size="sm">
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
        sections={sections}
        fields={fields}
        excludedFields={excludedFields}
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        onSaved={() => router.replace(`/produtos/${params.id}`)}
      />
    </Stack>
  );
}
