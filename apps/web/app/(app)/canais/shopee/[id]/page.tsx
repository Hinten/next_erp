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
import { ContaShopeePanel } from '../_components/ContaShopeePanel';
import { shopeeExcludedFields, shopeeFields } from '../_components/shopeeFieldOverrides';

export default function ContaShopeePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.integracao.write);
  const db = getFirebaseFirestore();

  async function handleDelete(id: string) {
    await deleteDoc(integracaoCollection.docRef(db, {}, id));
    router.replace('/canais/shopee');
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Conta Shopee</Title>
        <Group gap="sm">
          {/* Channel-agnostic: it recalculates produto prices for whichever
              integração this page is showing. */}
          <RecalcularPrecosCanalAction integracaoId={params.id} />
          <Anchor component={Link} href="/canais/shopee" size="sm">
            ← Voltar à lista
          </Anchor>
        </Group>
      </Group>

      {/* key: a param-only A->B navigation must remount the panel — its local
          state is per-conta (an in-flight `connecting`, and the one-shot
          ?shopee=connected toast effect), and Next reuses the component across
          a param change. */}
      <ContaShopeePanel key={params.id} integracaoId={params.id} />

      <ObjectView
        schema={integracaoSchema}
        collection={integracaoCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        excludedFields={shopeeExcludedFields}
        fields={shopeeFields}
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        canDelete={canWrite}
        onDelete={handleDelete}
        onSaved={() => router.replace('/canais/shopee')}
      />
    </Stack>
  );
}
