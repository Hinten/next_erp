'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { filialSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { filialCollection } from '@/lib/data/filialCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import { filialObjectFields } from '../_components/filialFields';
import { FilialTabs } from '../_components/FilialTabs';

export default function FilialPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.configuracoes.write);
  const db = getFirebaseFirestore();

  async function handleDelete(id: string) {
    await deleteDoc(filialCollection.docRef(db, {}, id));
    router.replace('/configuracoes/filiais');
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Filial</Title>
        <Anchor component={Link} href="/configuracoes/filiais" size="sm">
          ← Voltar à lista
        </Anchor>
      </Group>

      <FilialTabs filialId={params.id}>
        <ObjectView
          schema={filialSchema}
          collection={filialCollection}
          db={db}
          currentUserUid={user?.uid ?? ''}
          recordId={params.id}
          excludedFields={['timestamp']}
          fields={filialObjectFields}
          saveLabel="Salvar alterações"
          canEdit={canWrite}
          readOnly={!canWrite}
          canDelete={canWrite}
          onDelete={handleDelete}
          onSaved={() => router.replace('/configuracoes/filiais')}
        />
      </FilialTabs>
    </Stack>
  );
}
