'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { TIPO_INTEGRACAO_PGTO, metodoPagamentoSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { metodoPagamentoCollection } from '@/lib/data/pagamentoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';
import {
  metodoPagamentoExcludedFields,
  metodoPagamentoFields,
} from '../_components/metodoPagamentoFieldOverrides';

export default function NovaContaMercadoPagoPage() {
  const router = useRouter();
  const { user } = useAuth();

  // After creating, land on the edit page — that's where the "Conectar
  // conta" panel lives, the natural next step for a fresh account.
  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Nova conta Mercado Pago</Title>
        <Anchor component={Link} href="/pagamentos/mercado-pago" size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={metodoPagamentoSchema}
        collection={metodoPagamentoCollection}
        db={getFirebaseFirestore()}
        currentUserUid={user?.uid ?? ''}
        defaultValues={{
          tipo: TIPO_INTEGRACAO_PGTO.mercadoPago,
          hasLinkPagamento: false,
        }}
        excludedFields={metodoPagamentoExcludedFields}
        fields={metodoPagamentoFields}
        saveLabel="Criar"
        showSaveAndContinue={false}
        onSaved={(id) => router.replace(`/pagamentos/mercado-pago/${id}`)}
      />
    </Stack>
  );
}
