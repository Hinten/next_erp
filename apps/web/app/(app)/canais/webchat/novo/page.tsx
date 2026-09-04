'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { webchatSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { webchatCollection } from '@/lib/data/webchatCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';
import {
  WEBCHAT_SECTIONS,
  webchatExcludedFields,
  webchatFields,
} from '../_components/webchatFieldOverrides';

export default function NovoWebchatPage() {
  const router = useRouter();
  const { user } = useAuth();

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Novo webchat</Title>
        <Anchor component={Link} href="/canais/webchat" size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={webchatSchema}
        collection={webchatCollection}
        db={getFirebaseFirestore()}
        currentUserUid={user?.uid ?? ''}
        sections={WEBCHAT_SECTIONS}
        excludedFields={webchatExcludedFields}
        fields={webchatFields}
        saveLabel="Criar"
        showSaveAndContinue={false}
        onSaved={(id) => router.replace(`/canais/webchat/${id}`)}
      />
    </Stack>
  );
}
