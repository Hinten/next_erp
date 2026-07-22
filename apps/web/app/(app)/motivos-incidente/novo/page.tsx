'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { motivoIncidenteSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { motivoIncidenteCollection } from '@/lib/data/motivoIncidenteCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';

export default function NovoMotivoIncidentePage() {
  const router = useRouter();
  const { user } = useAuth();

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Novo motivo de incidente</Title>
        <Anchor component={Link} href="/motivos-incidente" size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={motivoIncidenteSchema}
        collection={motivoIncidenteCollection}
        db={getFirebaseFirestore()}
        currentUserUid={user?.uid ?? ''}
        defaultValues={{ ativo: true }}
        excludedFields={['timestamp', 'ultimaModificacao']}
        saveLabel="Criar"
        showSaveAndContinue={false}
        onSaved={(id) => router.replace(`/motivos-incidente/${id}`)}
      />
    </Stack>
  );
}
