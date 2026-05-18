'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { categoriaSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { categoriaCollection } from '@/lib/data/categoriaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';

export default function NovaCategoriaPage() {
  const router = useRouter();
  const { user } = useAuth();

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Nova categoria</Title>
        <Anchor component={Link} href="/categorias" size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={categoriaSchema}
        collection={categoriaCollection}
        db={getFirebaseFirestore()}
        currentUserUid={user?.uid ?? ''}
        defaultValues={{
          permiteCadastro: true,
          timestamp: new Date().toISOString(),
        }}
        excludedFields={['timestamp', 'categoriaPaiOuterRef', 'ultimaModificacao']}
        saveLabel="Criar"
        showSaveAndContinue={false}
        onSaved={(id) => router.replace(`/categorias/${id}`)}
      />
    </Stack>
  );
}
