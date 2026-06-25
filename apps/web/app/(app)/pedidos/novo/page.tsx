'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { addDoc } from 'firebase/firestore';
import { Button, Stack } from '@mantine/core';
import { PageHeader } from '@delfrance/ui';
import type { Pedido } from '@delfrance/schemas';
import { PedidoForm } from '../_components/PedidoForm';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function NovoPedidoPage() {
  const router = useRouter();

  async function handleSubmit(values: Pedido) {
    const ref = await addDoc(pedidoCollection.ref(getFirebaseFirestore(), {}), values);
    router.replace(`/pedidos/${ref.id}/editar`);
  }

  return (
    // Fill the AppShell main area so the form's flex layout can pin the sticky
    // footer to the bottom regardless of how short a tab's content is.
    <Stack mih="calc(100dvh - var(--app-shell-header-height, 56px) - var(--app-shell-padding, 1rem) * 2)">
      <PageHeader
        title="Novo pedido"
        actions={
          <Button component={Link} href="/pedidos" variant="subtle">
            Voltar
          </Button>
        }
      />
      <PedidoForm submitLabel="Criar" onSubmit={handleSubmit} />
    </Stack>
  );
}
