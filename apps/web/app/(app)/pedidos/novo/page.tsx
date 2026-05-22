'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { addDoc } from 'firebase/firestore';
import { Anchor, Button, Stack } from '@mantine/core';
import { PageHeader } from '@delfrance/ui';
import type { Pedido } from '@delfrance/schemas';
import { PedidoForm } from '../_components/PedidoForm';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function NovoPedidoPage() {
  const router = useRouter();

  async function handleSubmit(values: Pedido) {
    const ref = await addDoc(
      pedidoCollection.ref(getFirebaseFirestore(), {}),
      values,
    );
    router.replace(`/pedidos/${ref.id}/editar`);
  }

  return (
    <Stack>
      <PageHeader
        title="Novo pedido"
        actions={
          <Button component={Link} href="/pedidos" variant="subtle">
            Voltar
          </Button>
        }
      />
      <PedidoForm submitLabel="Criar" onSubmit={handleSubmit} />
      <Anchor component={Link} href="/pedidos" size="sm">
        ← Voltar ao quadro
      </Anchor>
    </Stack>
  );
}
