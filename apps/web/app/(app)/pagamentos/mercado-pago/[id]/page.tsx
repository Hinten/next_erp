'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { metodoPagamentoSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { metodoPagamentoCollection } from '@/lib/data/pagamentoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import { ContaMercadoPagoPanel } from '../_components/ContaMercadoPagoPanel';
import {
  metodoPagamentoExcludedFields,
  metodoPagamentoFields,
} from '../_components/metodoPagamentoFieldOverrides';

export default function ContaMercadoPagoPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.metodoPagamento.write);
  const { allowed: canDelete } = usePermission(PERM.metodoPagamento.delete);
  const db = getFirebaseFirestore();

  async function handleDelete(id: string) {
    await deleteDoc(metodoPagamentoCollection.docRef(db, {}, id));
    router.replace('/pagamentos/mercado-pago');
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Conta Mercado Pago</Title>
        <Anchor component={Link} href="/pagamentos/mercado-pago" size="sm">
          ← Voltar à lista
        </Anchor>
      </Group>

      <ContaMercadoPagoPanel metodoId={params.id} />

      <ObjectView
        schema={metodoPagamentoSchema}
        collection={metodoPagamentoCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        excludedFields={metodoPagamentoExcludedFields}
        fields={metodoPagamentoFields}
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        canDelete={canDelete}
        onDelete={handleDelete}
        onSaved={() => router.replace('/pagamentos/mercado-pago')}
      />
    </Stack>
  );
}
