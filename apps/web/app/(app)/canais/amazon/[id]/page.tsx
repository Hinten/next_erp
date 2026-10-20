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
import { validarIntermediador } from '../../_components/integracaoFieldOverrides';
import { amazonExcludedFields, amazonFields } from '../_components/amazonFieldOverrides';
import { ContaAmazonPanel } from '../_components/ContaAmazonPanel';

export default function ContaAmazonPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.integracao.write);
  const { allowed: canDelete } = usePermission(PERM.integracao.delete);
  const db = getFirebaseFirestore();

  async function handleDelete(id: string) {
    await deleteDoc(integracaoCollection.docRef(db, {}, id));
    router.replace('/canais/amazon');
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Conta Amazon</Title>
        <Group gap="sm">
          {/* Channel-agnostic: it recalculates produto prices for whichever
              integração this page is showing. */}
          <RecalcularPrecosCanalAction integracaoId={params.id} />
          <Anchor component={Link} href="/canais/amazon" size="sm">
            ← Voltar à lista
          </Anchor>
        </Group>
      </Group>

      {/* The connection panel sits above the form and is always visible, so the
          reconnection and reauthorization avisos' deep link lands on it.
          `key={params.id}`: a param-only A->B navigation must remount its
          per-conta state, and Next reuses the component across a param change. */}
      <ContaAmazonPanel key={params.id} integracaoId={params.id} />

      <ObjectView
        schema={integracaoSchema}
        collection={integracaoCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        excludedFields={amazonExcludedFields}
        fields={amazonFields}
        validate={validarIntermediador}
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        canDelete={canDelete}
        onDelete={handleDelete}
        onSaved={() => router.replace('/canais/amazon')}
      />
    </Stack>
  );
}
