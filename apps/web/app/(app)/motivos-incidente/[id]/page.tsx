'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { motivoIncidenteSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { motivoIncidenteCollection } from '@/lib/data/motivoIncidenteCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';

export default function MotivoIncidentePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.pedido.write);
  const db = getFirebaseFirestore();

  async function handleDelete(id: string) {
    await deleteDoc(motivoIncidenteCollection.docRef(db, {}, id));
    router.replace('/motivos-incidente');
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Motivo de incidente</Title>
        <Anchor component={Link} href="/motivos-incidente" size="sm">
          ← Voltar à lista
        </Anchor>
      </Group>

      <ObjectView
        schema={motivoIncidenteSchema}
        collection={motivoIncidenteCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        canDelete={canWrite}
        onDelete={handleDelete}
        onSaved={() => router.replace('/motivos-incidente')}
      />
    </Stack>
  );
}
