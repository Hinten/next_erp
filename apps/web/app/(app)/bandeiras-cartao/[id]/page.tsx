'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { bandeiraCartaoSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { bandeiraCartaoCollection } from '@/lib/data/bandeiraCartaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';

export default function BandeiraCartaoPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.pagamento.write);
  const db = getFirebaseFirestore();

  async function handleDelete(id: string) {
    await deleteDoc(bandeiraCartaoCollection.docRef(db, {}, id));
    router.replace('/bandeiras-cartao');
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Bandeira de cartão</Title>
        <Anchor component={Link} href="/bandeiras-cartao" size="sm">
          ← Voltar à lista
        </Anchor>
      </Group>

      <ObjectView
        schema={bandeiraCartaoSchema}
        collection={bandeiraCartaoCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        excludedFields={['dataCadastro', 'ultimaModificacao']}
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        canDelete={canWrite}
        onDelete={handleDelete}
        onSaved={() => router.replace('/bandeiras-cartao')}
      />
    </Stack>
  );
}
