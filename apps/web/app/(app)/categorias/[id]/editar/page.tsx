'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { categoriaSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { categoriaCollection } from '@/lib/data/categoriaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';

export default function EditarCategoriaPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Editar categoria</Title>
        <Anchor component={Link} href={`/categorias/${params.id}`} size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={categoriaSchema}
        collection={categoriaCollection}
        db={getFirebaseFirestore()}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        excludedFields={['timestamp', 'categoriaPaiOuterRef']}
        saveLabel="Salvar alterações"
        onSaved={(id) => router.replace(`/categorias/${id}`)}
      />
    </Stack>
  );
}
