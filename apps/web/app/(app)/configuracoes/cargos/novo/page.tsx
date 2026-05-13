'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { addDoc } from 'firebase/firestore';
import { Alert, Anchor, Group, Skeleton, Stack, Title } from '@mantine/core';
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
    } catch {
      return 0n;
    }
  }, [claims?.permissions]);

  async function handleSubmit(values: Cargo) {
    if (!claims?.grupoEconomico) {
      throw new Error('Grupo econômico não identificado.');
    }
    const ref = await addDoc(cargoCollection.ref(getFirebaseFirestore(), {}), {
      ...values,
      grupoEconomico: claims.grupoEconomico,
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
      {!loading && !claims?.grupoEconomico && (
        <Alert color="yellow">
          Grupo econômico não vinculado à sua conta.
        </Alert>
      )}
      {!loading && claims?.grupoEconomico && (
        <CargoForm
          submitLabel="Criar"
          onSubmit={handleSubmit}
          callerBits={callerBits}
        />
      )}
    </Stack>
  );
}
