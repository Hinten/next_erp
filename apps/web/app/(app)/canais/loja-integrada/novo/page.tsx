'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { INTEGRACAO_TIPO, integracaoSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';
import {
  lojaIntegradaExcludedFields,
  lojaIntegradaFields,
} from '../_components/lojaIntegradaFieldOverrides';

export default function NovaContaLojaIntegradaPage() {
  const router = useRouter();
  const { user } = useAuth();

  // After creating, land on the edit page: the natural next step for a fresh
  // conta, and where the credential panel will sit.
  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Nova conta Loja Integrada</Title>
        <Anchor component={Link} href="/canais/loja-integrada" size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={integracaoSchema}
        collection={integracaoCollection}
        db={getFirebaseFirestore()}
        currentUserUid={user?.uid ?? ''}
        defaultValues={{
          tipo: INTEGRACAO_TIPO.lojaIntegrada,
          padrao: false,
          ativo: true,
        }}
        excludedFields={lojaIntegradaExcludedFields}
        fields={lojaIntegradaFields}
        saveLabel="Criar"
        showSaveAndContinue={false}
        onSaved={(id) => router.replace(`/canais/loja-integrada/${id}`)}
      />
    </Stack>
  );
}
