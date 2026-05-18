'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { filialSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { filialCollection } from '@/lib/data/filialCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';
import { filialObjectFields } from '../_components/filialFields';

export default function NovaFilialPage() {
  const router = useRouter();
  const { user } = useAuth();

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Nova filial</Title>
        <Anchor component={Link} href="/configuracoes/filiais" size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={filialSchema}
        collection={filialCollection}
        db={getFirebaseFirestore()}
        currentUserUid={user?.uid ?? ''}
        defaultValues={{ timestamp: new Date().toISOString() }}
        excludedFields={['timestamp']}
        fields={filialObjectFields}
        saveLabel="Criar"
        showSaveAndContinue={false}
        onSaved={(id) => router.replace(`/configuracoes/filiais/${id}`)}
      />
    </Stack>
  );
}
