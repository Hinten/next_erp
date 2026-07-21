'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { deleteDoc } from 'firebase/firestore';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { ObjectView } from '@delfrance/ui';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import {
  LISTA_DE_PRECOS_EXCLUDED_FIELDS,
  LISTA_DE_PRECOS_SECTIONS,
  listaDePrecosFields,
} from '../../_components/listaDePrecosFields';
import { listaDePrecosFormSchema } from '../../_components/listaDePrecosFormSchema';

export default function EditarListaDePrecosPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.produto.write);
  const { allowed: canDelete } = usePermission(PERM.produto.delete);
  const db = getFirebaseFirestore();

  async function handleDelete(id: string) {
    await deleteDoc(listaDePrecosCollection.docRef(db, {}, id));
    router.replace('/listas-de-precos');
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Lista de preços</Title>
        <Anchor component={Link} href="/listas-de-precos" size="sm">
          ← Voltar à lista
        </Anchor>
      </Group>

      <ObjectView
        schema={listaDePrecosFormSchema}
        collection={listaDePrecosCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        excludedFields={LISTA_DE_PRECOS_EXCLUDED_FIELDS}
        fields={listaDePrecosFields}
        sections={LISTA_DE_PRECOS_SECTIONS}
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        canDelete={canDelete}
        onDelete={handleDelete}
        deleteConfirmMessage="A lista de preços será excluída permanentemente. Esta ação não pode ser desfeita."
        onSaved={() => router.replace('/listas-de-precos')}
      />
    </Stack>
  );
}
