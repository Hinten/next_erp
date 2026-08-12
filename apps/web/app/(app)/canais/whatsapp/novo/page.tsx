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
  WHATSAPP_SECTIONS,
  whatsappExcludedFields,
  whatsappFields,
} from '../_components/whatsappFieldOverrides';

export default function NovoWhatsappPage() {
  const router = useRouter();
  const { user } = useAuth();

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Nova conta WhatsApp</Title>
        <Anchor component={Link} href="/canais/whatsapp" size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={integracaoSchema}
        collection={integracaoCollection}
        db={getFirebaseFirestore()}
        currentUserUid={user?.uid ?? ''}
        defaultValues={{
          tipo: INTEGRACAO_TIPO.whatsapp,
          padrao: false,
          ativo: true,
          verificado: false,
        }}
        excludedFields={whatsappExcludedFields}
        fields={whatsappFields}
        sections={WHATSAPP_SECTIONS}
        saveLabel="Criar"
        showSaveAndContinue={false}
        onSaved={(id) => router.replace(`/canais/whatsapp/${id}`)}
      />
    </Stack>
  );
}
