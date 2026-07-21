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
import { RecalcularPrecosCanalAction } from '../../_components/RecalcularPrecosCanalAction';
import { ContaMercadoLivrePanel } from '../_components/ContaMercadoLivrePanel';
import {
  mercadoLivreExcludedFields,
  mercadoLivreFields,
} from '../_components/mercadoLivreFieldOverrides';

export default function ContaMercadoLivrePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.integracao.write);
  const db = getFirebaseFirestore();

  async function handleDelete(id: string) {
    await deleteDoc(integracaoCollection.docRef(db, {}, id));
    router.replace('/canais/mercado-livre');
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Conta Mercado Livre</Title>
        <Group gap="sm">
          <RecalcularPrecosCanalAction integracaoId={params.id} />
          <Anchor component={Link} href="/canais/mercado-livre" size="sm">
            ← Voltar à lista
          </Anchor>
        </Group>
      </Group>

      <ContaMercadoLivrePanel integracaoId={params.id} />

      <ObjectView
        schema={integracaoSchema}
        collection={integracaoCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        excludedFields={mercadoLivreExcludedFields}
        fields={mercadoLivreFields}
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        canDelete={canWrite}
        onDelete={handleDelete}
        onSaved={() => router.replace('/canais/mercado-livre')}
      />
    </Stack>
  );
}
