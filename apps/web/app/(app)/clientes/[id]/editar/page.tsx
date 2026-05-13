'use client';

import { useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { setDoc } from 'firebase/firestore';
import {
  Alert,
  Anchor,
  Button,
  Group,
  Skeleton,
  Stack,
  Title,
} from '@mantine/core';
import type { Cliente } from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { ClienteForm } from '../../_components/ClienteForm';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function EditarClientePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const docRef = useMemo(
    () => clienteCollection.docRef(getFirebaseFirestore(), {}, params.id),
    [params.id],
  );

  const { data, loading, error } = useDocSnapshot(docRef);

  async function handleSubmit(values: Cliente) {
    await setDoc(docRef, values, { merge: true });
    router.replace(`/clientes/${params.id}`);
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Editar cliente</Title>
        <Anchor component={Link} href={`/clientes/${params.id}`} size="sm">
          Cancelar
        </Anchor>
      </Group>

      {error && <Alert color="red">{error.message}</Alert>}
      {loading && <Skeleton height={300} />}
      {!loading && !data && (
        <Alert color="yellow">Cliente não encontrado.</Alert>
      )}
      {!loading && data && (
        <ClienteForm
          defaultValues={data.data}
          submitLabel="Salvar alterações"
          onSubmit={handleSubmit}
        />
      )}
      {!loading && (
        <Group>
          <Button component={Link} href="/clientes" variant="subtle">
            Voltar à lista
          </Button>
        </Group>
      )}
    </Stack>
  );
}
