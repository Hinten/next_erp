'use client';

/**
 * Per-NF-e Carta de Correção screen. Reached from the per-pedido NF-e screen
 * ("Cartas de correção" action on an aprovada NF-e), mirroring the old Flutter
 * dedicated `CartaCorrecaoTableView(pedidoUid, nfeUid)`. The NF-e is fixed by
 * the route params, so the form has no NF-e selector. A "Nova Carta de
 * Correção" form sits above the history of every CC-e issued for this NF-e.
 */
import { useMemo } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Anchor, Group, Stack, Text, Title } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { useDocSnapshot } from '@delfrance/data/hooks';

import { RequirePerm } from '@/lib/auth';
import { nfeCollection } from '@/lib/data/nfeCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

import { CartaCorrecaoForm } from './_components/CartaCorrecaoForm';
import { CartaCorrecaoHistory } from './_components/CartaCorrecaoHistory';

function CartaCorrecaoContent() {
  const params = useParams<{ id: string; nfeId: string }>();
  const pedidoId = params.id;
  const nfeId = params.nfeId;
  const db = getFirebaseFirestore();

  const ref = useMemo(
    () => nfeCollection.docRef(db, { pedidoId }, nfeId),
    [db, pedidoId, nfeId],
  );
  const { data: nfeDoc } = useDocSnapshot(ref);
  const nfe = nfeDoc?.data;

  return (
    <Stack p="md" gap="lg">
      <Group justify="space-between" align="flex-start">
        <Stack gap={4}>
          <Title order={2}>
            Carta de correção{nfe ? ` — NF-e nº ${nfe.numeracao} · série ${nfe.serie}` : ''}
          </Title>
          {nfe?.chave && (
            <Text size="xs" ff="monospace" c="dimmed">
              {nfe.chave}
            </Text>
          )}
          <Text c="dimmed" size="sm">
            Corrige uma NF-e autorizada sem cancelá-la. A operação é síncrona e
            registrada na SEFAZ; cada correção recebe um novo número de sequência.
          </Text>
        </Stack>
        <Anchor component={Link} href={`/pedidos/${pedidoId}/nfe`} size="sm">
          ← Voltar às notas
        </Anchor>
      </Group>

      <CartaCorrecaoForm pedidoId={pedidoId} nfeId={nfeId} />
      <CartaCorrecaoHistory pedidoId={pedidoId} nfeId={nfeId} />
    </Stack>
  );
}

export default function CartaCorrecaoPage() {
  return (
    <RequirePerm bit={PERM.fiscal.read} redirectTo="/inicio">
      <CartaCorrecaoContent />
    </RequirePerm>
  );
}
