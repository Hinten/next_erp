'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { integracaoSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import { ContaWhatsappHealth } from '../_components/ContaWhatsappHealth';
import { ContaWhatsappPanel } from '../_components/ContaWhatsappPanel';
import {
  WHATSAPP_SECTIONS,
  whatsappExcludedFields,
  whatsappFields,
} from '../_components/whatsappFieldOverrides';

export default function ContaWhatsappPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.integracao.write);
  const db = getFirebaseFirestore();

  async function handleDelete(id: string) {
    await deleteDoc(integracaoCollection.docRef(db, {}, id));
    router.replace('/canais/whatsapp');
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Conta WhatsApp</Title>
        <Anchor component={Link} href="/canais/whatsapp" size="sm">
          ← Voltar à lista
        </Anchor>
      </Group>

      <ContaWhatsappPanel integracaoId={params.id} />

      <ContaWhatsappHealth integracaoId={params.id} />

      <ObjectView
        schema={integracaoSchema}
        collection={integracaoCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        excludedFields={whatsappExcludedFields}
        fields={whatsappFields}
        sections={WHATSAPP_SECTIONS}
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        canDelete={canWrite}
        onDelete={handleDelete}
        onSaved={() => router.replace('/canais/whatsapp')}
      />
    </Stack>
  );
}
