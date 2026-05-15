'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { bandeiraCartaoSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { bandeiraCartaoCollection } from '@/lib/data/bandeiraCartaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';

export default function NovaBandeiraCartaoPage() {
  const router = useRouter();
  const { user } = useAuth();

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Nova bandeira de cartão</Title>
        <Anchor component={Link} href="/bandeiras-cartao" size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={bandeiraCartaoSchema}
        collection={bandeiraCartaoCollection}
        db={getFirebaseFirestore()}
        currentUserUid={user?.uid ?? ''}
        defaultValues={{
          ehCredito: false,
          tarifa: 0,
          tarifaFixa: 0,
          maxParcelas: 1,
          prazoRecebimento: 0,
        }}
        excludedFields={['dataCadastro', 'ultimaModificacao']}
        saveLabel="Criar"
        showSaveAndContinue={false}
        onSaved={(id) => router.replace(`/bandeiras-cartao/${id}`)}
      />
    </Stack>
  );
}
