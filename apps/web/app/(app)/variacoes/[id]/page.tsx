'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { grupoDeVariacoesSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { grupoDeVariacoesCollection } from '@/lib/data/grupoDeVariacoesCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import {
  GRUPO_EXCLUDED_FIELDS,
  GRUPO_SECTIONS,
  deriveVariacoesIds,
  grupoFields,
} from '../_components/grupoFields';

export default function GrupoVariacaoPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.produto.write);
  const db = getFirebaseFirestore();

  async function handleDelete(id: string) {
    await deleteDoc(grupoDeVariacoesCollection.docRef(db, {}, id));
    router.replace('/variacoes');
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Grupo de variação</Title>
        <Anchor component={Link} href="/variacoes" size="sm">
          ← Voltar à lista
        </Anchor>
      </Group>

      <ObjectView
        schema={grupoDeVariacoesSchema}
        collection={grupoDeVariacoesCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        sections={GRUPO_SECTIONS}
        fields={grupoFields}
        excludedFields={GRUPO_EXCLUDED_FIELDS}
        deriveOnSave={deriveVariacoesIds}
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        canDelete={canWrite}
        onDelete={handleDelete}
        onSaved={() => router.replace('/variacoes')}
      />
    </Stack>
  );
}
