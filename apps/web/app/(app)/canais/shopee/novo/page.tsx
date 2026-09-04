'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { INTEGRACAO_TIPO, integracaoSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';
import { shopeeExcludedFields, shopeeFields } from '../_components/shopeeFieldOverrides';

export default function NovaContaShopeePage() {
  const router = useRouter();
  const { user } = useAuth();

  // After creating, land on the edit page — that's where the "Conectar conta"
  // panel lives, the natural next step for a fresh account.
  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Nova conta Shopee</Title>
        <Anchor component={Link} href="/canais/shopee" size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={integracaoSchema}
        collection={integracaoCollection}
        db={getFirebaseFirestore()}
        currentUserUid={user?.uid ?? ''}
        defaultValues={{
          tipo: INTEGRACAO_TIPO.shopee,
          padrao: false,
          ativo: true,
        }}
        excludedFields={shopeeExcludedFields}
        fields={shopeeFields}
        saveLabel="Criar"
        showSaveAndContinue={false}
        onSaved={(id) => router.replace(`/canais/shopee/${id}`)}
      />
    </Stack>
  );
}
