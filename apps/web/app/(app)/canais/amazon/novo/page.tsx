'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { INTEGRACAO_TIPO, integracaoSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';
import { validarIntermediador } from '../../_components/integracaoFieldOverrides';
import { amazonExcludedFields, amazonFields } from '../_components/amazonFieldOverrides';

export default function NovaContaAmazonPage() {
  const router = useRouter();
  const { user } = useAuth();

  // After creating, land on the edit page: the natural next step for a fresh
  // conta, and where the connection panel will sit.
  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Nova conta Amazon</Title>
        <Anchor component={Link} href="/canais/amazon" size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={integracaoSchema}
        collection={integracaoCollection}
        db={getFirebaseFirestore()}
        currentUserUid={user?.uid ?? ''}
        defaultValues={{
          tipo: INTEGRACAO_TIPO.amazon,
          padrao: false,
          ativo: true,
        }}
        excludedFields={amazonExcludedFields}
        fields={amazonFields}
        validate={validarIntermediador}
        saveLabel="Criar"
        showSaveAndContinue={false}
        onSaved={(id) => router.replace(`/canais/amazon/${id}`)}
      />
    </Stack>
  );
}
