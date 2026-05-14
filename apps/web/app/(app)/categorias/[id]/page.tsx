'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { categoriaSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { categoriaCollection } from '@/lib/data/categoriaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';

export default function CategoriaPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.produto.write);
  const db = getFirebaseFirestore();

  async function handleDelete(id: string) {
    await deleteDoc(categoriaCollection.docRef(db, {}, id));
    router.replace('/categorias');
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Categoria</Title>
        <Anchor component={Link} href="/categorias" size="sm">
          ← Voltar à lista
        </Anchor>
      </Group>

      <ObjectView
        schema={categoriaSchema}
        collection={categoriaCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        excludedFields={['timestamp', 'categoriaPaiOuterRef']}
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
