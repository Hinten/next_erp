'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { webchatSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { webchatCollection } from '@/lib/data/webchatCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import {
  WEBCHAT_SECTIONS,
  webchatExcludedFields,
  webchatFields,
} from '../_components/webchatFieldOverrides';

export default function WebchatPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.webchat.write);
  const db = getFirebaseFirestore();

  async function handleDelete(id: string) {
    await deleteDoc(webchatCollection.docRef(db, {}, id));
    router.replace('/canais/webchat');
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Webchat</Title>
        <Anchor component={Link} href="/canais/webchat" size="sm">
          ← Voltar à lista
        </Anchor>
      </Group>

      <ObjectView
        schema={webchatSchema}
        collection={webchatCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        sections={WEBCHAT_SECTIONS}
        excludedFields={webchatExcludedFields}
        fields={webchatFields}
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        canDelete={canWrite}
        onDelete={handleDelete}
        onSaved={() => router.replace('/canais/webchat')}
      />
    </Stack>
  );
}
