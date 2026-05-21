'use client';

import { useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { setDoc } from 'firebase/firestore';
import { Alert, Anchor, Skeleton, Stack } from '@mantine/core';
import { PageHeader } from '@delfrance/ui';
import { useDocSnapshot } from '@delfrance/data/hooks';
import type { Pedido } from '@delfrance/schemas';
import { PedidoForm } from '../../_components/PedidoForm';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function EditarPedidoPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const docRef = useMemo(
    () => pedidoCollection.docRef(getFirebaseFirestore(), {}, params.id),
    [params.id],
  );

  const { data, loading, error } = useDocSnapshot(docRef);

  async function handleSubmit(values: Pedido) {
    await setDoc(docRef, values, { merge: true });
    router.replace(`/pedidos/${params.id}`);
  }

  if (loading) {
    return (
      <Stack>
        <Skeleton height={32} width={240} />
        <Skeleton height={400} />
      </Stack>
    );
  }
  if (error) return <Alert color="red">{error.message}</Alert>;
  if (!data) return <Alert color="yellow">Pedido não encontrado.</Alert>;

  return (
    <Stack>
      <PageHeader
        title="Editar pedido"
        actions={
          <Anchor component={Link} href={`/pedidos/${params.id}`} size="sm">
            Cancelar
          </Anchor>
        }
      />
      <PedidoForm
        defaultValues={data.data}
        submitLabel="Salvar alterações"
        onSubmit={handleSubmit}
      />
    </Stack>
  );
}
