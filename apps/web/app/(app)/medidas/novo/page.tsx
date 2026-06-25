'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { tabelaDeMedidasSchema } from '@delfrance/schemas';
import { nowMillis } from '@delfrance/core/datetime';
import { ObjectView } from '@delfrance/ui';
import { tabelaDeMedidasCollection } from '@/lib/data/tabelaDeMedidasCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';

export default function NovaTabelaDeMedidasPage() {
  const router = useRouter();
  const { user } = useAuth();

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Nova tabela de medidas</Title>
        <Anchor component={Link} href="/medidas" size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={tabelaDeMedidasSchema}
        collection={tabelaDeMedidasCollection}
        db={getFirebaseFirestore()}
        currentUserUid={user?.uid ?? ''}
        defaultValues={{ dataCadastro: nowMillis() }}
        // The marketplace size-chart maps are authored by the marketplace
        // integrations, not this form; excluding them keeps them out of the
        // editor while the dirty-field-patch save leaves them untouched.
        excludedFields={[
          'fotos',
          'fotosArquivosIds',
          'tabelasDeMedidasMercadoLivre',
          'tabelasMedidasShopee',
          'dataCadastro',
          'ultimaModificacao',
        ]}
        fields={{
          descricao: {
            hint: 'Se suportado pelo marketplace, é enviada junto à descrição do produto.',
          },
        }}
        saveLabel="Criar"
        showSaveAndContinue={false}
        onSaved={(id) => router.replace(`/medidas/${id}`)}
      />
    </Stack>
  );
}
