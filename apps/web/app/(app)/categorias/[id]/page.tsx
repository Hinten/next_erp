'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { z } from 'zod';
import { PERM } from '@delfrance/auth';
import { categoriaSchema, type ImpostoCategoria } from '@delfrance/schemas';
import { type FieldConfig, ObjectView } from '@delfrance/ui';
import { categoriaCollection } from '@/lib/data/categoriaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import { buildCategoriaImpostoTransactionWrites } from '@/lib/categorias/clientPort';
import { CategoriaImpostoManager } from '../_components/CategoriaImpostoManager';

// Wider page schema: the categoria doc + a transient `impostos` host field
// (per-operação impostocategoria docs, persisted via transactionWrites, never
// written to the categoria doc). categoriaSchema has no refine, so `.extend` is safe.
const categoriaPageSchema = categoriaSchema.extend({
  impostos: z.unknown().nullable().default(null),
});

const CATEGORIA_SECTIONS = ['Dados gerais', 'Impostos'];
const CATEGORIA_EXCLUDED = ['timestamp', 'categoriaPaiOuterRef', 'ultimaModificacao'];
const CATEGORIA_TRANSIENT = ['impostos'];

export default function CategoriaPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.categoria.write);
  const db = getFirebaseFirestore();

  async function handleDelete(id: string) {
    await deleteDoc(categoriaCollection.docRef(db, {}, id));
    router.replace('/categorias');
  }

  const fields = useMemo<Record<string, FieldConfig>>(
    () => ({
      impostos: {
        section: 'Impostos',
        label: 'Impostos',
        renderInput: (p) => (
          <CategoriaImpostoManager
            categoriaId={params.id}
            db={db}
            value={(p.value as ImpostoCategoria[] | null) ?? null}
            onChange={p.onChange}
            errorTree={p.errorTree}
            disabled={p.disabled}
          />
        ),
      },
    }),
    [params.id, db],
  );

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Categoria</Title>
        <Anchor component={Link} href="/categorias" size="sm">
          ← Voltar à lista
        </Anchor>
      </Group>

      <ObjectView
        schema={categoriaPageSchema}
        collection={categoriaCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        sections={CATEGORIA_SECTIONS}
        fields={fields}
        excludedFields={CATEGORIA_EXCLUDED}
        transientFields={CATEGORIA_TRANSIENT}
        transactionWrites={(id, values) => buildCategoriaImpostoTransactionWrites(db, id, values)}
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        canDelete={canWrite}
        onDelete={handleDelete}
        onSaved={() => router.replace('/categorias')}
      />
    </Stack>
  );
}
