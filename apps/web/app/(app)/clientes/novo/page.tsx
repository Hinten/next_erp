'use client';

import { useRouter } from 'next/navigation';
import { addDoc } from 'firebase/firestore';
import { Button, Group, Stack, Title } from '@mantine/core';
import Link from 'next/link';
import type { Cliente } from '@delfrance/schemas';
import { ClienteForm } from '../_components/ClienteForm';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function NovoClientePage() {
  const router = useRouter();

  async function handleSubmit(values: Cliente) {
    const ref = await addDoc(clienteCollection.ref(getFirebaseFirestore(), {}), {
      ...values,
      timestamp: new Date().toISOString(),
    });
    router.replace(`/clientes/${ref.id}`);
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Novo cliente</Title>
        <Button component={Link} href="/clientes" variant="subtle">
          Voltar
        </Button>
      </Group>
      <ClienteForm submitLabel="Criar" onSubmit={handleSubmit} />
    </Stack>
  );
}
