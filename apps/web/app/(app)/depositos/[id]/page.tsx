'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { depositoSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { depositoCollection } from '@/lib/data/depositoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';

export default function DepositoPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.estoque.write);
  const db = getFirebaseFirestore();

  async function handleDelete(id: string) {
    await deleteDoc(depositoCollection.docRef(db, {}, id));
    router.replace('/depositos');
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Depósito</Title>
        <Anchor component={Link} href="/depositos" size="sm">
          ← Voltar à lista
        </Anchor>
      </Group>

      <ObjectView
        schema={depositoSchema}
        collection={depositoCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        excludedFields={['timestamp', 'ultimaModificacao']}
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        canDelete={canWrite}
        onDelete={handleDelete}
        onSaved={() => router.replace('/depositos')}
      />
    </Stack>
  );
}
