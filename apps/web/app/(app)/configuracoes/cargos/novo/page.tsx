'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { addDoc } from 'firebase/firestore';
import { Anchor, Group, Skeleton, Stack, Title } from '@mantine/core';
import type { Cargo } from '@delfrance/schemas';
import { useTenant } from '@/lib/auth';
import { CargoForm } from '../_components/CargoForm';
import { cargoCollection } from '@/lib/data/cargoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function NovoCargoPage() {
  const router = useRouter();
  const { claims, loading } = useTenant();

  const callerBits = useMemo(() => {
    try {
      return claims?.permissions ? BigInt(claims.permissions) : 0n;
    } catch (err) {
      if (err instanceof SyntaxError) {
        return 0n;
      }
      throw err;
    }
  }, [claims?.permissions]);

  async function handleSubmit(values: Cargo) {
    const ref = await addDoc(cargoCollection.ref(getFirebaseFirestore(), {}), {
      ...values,
      timestamp: new Date().toISOString(),
    });
    router.replace(`/configuracoes/cargos/${ref.id}`);
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Novo cargo</Title>
        <Anchor component={Link} href="/configuracoes/cargos" size="sm">
          Voltar
        </Anchor>
      </Group>
      {loading && <Skeleton height={300} />}
      {!loading && (
        <CargoForm
          submitLabel="Criar"
          onSubmit={handleSubmit}
          callerBits={callerBits}
        />
      )}
    </Stack>
  );
}
