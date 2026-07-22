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
  mercadoLivreExcludedFields,
  mercadoLivreFields,
} from '../_components/mercadoLivreFieldOverrides';

export default function NovaContaMercadoLivrePage() {
  const router = useRouter();
  const { user } = useAuth();

  // After creating, land on the edit page — that's where the "Conectar conta"
  // panel lives, the natural next step for a fresh account.
  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Nova conta Mercado Livre</Title>
        <Anchor component={Link} href="/canais/mercado-livre" size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={integracaoSchema}
        collection={integracaoCollection}
        db={getFirebaseFirestore()}
        currentUserUid={user?.uid ?? ''}
        defaultValues={{
          tipo: INTEGRACAO_TIPO.mercadoLivre,
          padrao: false,
          ativo: true,
        }}
        excludedFields={mercadoLivreExcludedFields}
        fields={mercadoLivreFields}
        saveLabel="Criar"
        showSaveAndContinue={false}
        onSaved={(id) => router.replace(`/canais/mercado-livre/${id}`)}
      />
    </Stack>
  );
}
