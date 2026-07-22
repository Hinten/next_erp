'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { depositoSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { depositoCollection } from '@/lib/data/depositoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';

export default function NovoDepositoPage() {
  const router = useRouter();
  const { user } = useAuth();

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Novo depósito</Title>
        <Anchor component={Link} href="/depositos" size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={depositoSchema}
        collection={depositoCollection}
        db={getFirebaseFirestore()}
        currentUserUid={user?.uid ?? ''}
        defaultValues={{ ativo: true }}
        excludedFields={['timestamp', 'ultimaModificacao']}
        saveLabel="Criar"
        showSaveAndContinue={false}
        onSaved={(id) => router.replace(`/depositos/${id}`)}
      />
    </Stack>
  );
}
