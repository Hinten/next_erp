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
import { ContaLojaIntegradaPanel } from '../_components/ContaLojaIntegradaPanel';
import {
  lojaIntegradaExcludedFields,
  lojaIntegradaFields,
} from '../_components/lojaIntegradaFieldOverrides';

export default function ContaLojaIntegradaPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.integracao.write);
  const { allowed: canDelete } = usePermission(PERM.integracao.delete);
  const db = getFirebaseFirestore();

  async function handleDelete(id: string) {
    await deleteDoc(integracaoCollection.docRef(db, {}, id));
    router.replace('/canais/loja-integrada');
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Conta Loja Integrada</Title>
        <Group gap="sm">
          {/* Channel-agnostic: it recalculates produto prices for whichever
              integração this page is showing. */}
          <RecalcularPrecosCanalAction integracaoId={params.id} />
          <Anchor component={Link} href="/canais/loja-integrada" size="sm">
            ← Voltar à lista
          </Anchor>
        </Group>
      </Group>

      {/* The credential panel sits ABOVE the form and is always visible, so the
          expiry and "token recusado" avisos' deep link lands on it. key: a
          param-only A->B navigation must remount it — its state is per-conta (a
          typed token, a picked date, the last write's message), and Next reuses
          the component across a param change. */}
      <ContaLojaIntegradaPanel key={params.id} integracaoId={params.id} />

      <ObjectView
        schema={integracaoSchema}
        collection={integracaoCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        excludedFields={lojaIntegradaExcludedFields}
        fields={lojaIntegradaFields}
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        canDelete={canDelete}
        onDelete={handleDelete}
        onSaved={() => router.replace('/canais/loja-integrada')}
      />
    </Stack>
  );
}
