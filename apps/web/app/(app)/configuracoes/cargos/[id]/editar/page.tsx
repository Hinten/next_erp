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
import type { Cargo } from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { useTenant } from '@/lib/auth';
import { CargoForm } from '../../_components/CargoForm';
import { cargoCollection } from '@/lib/data/cargoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function EditarCargoPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { claims } = useTenant();

  const docRef = useMemo(
    () => cargoCollection.docRef(getFirebaseFirestore(), {}, params.id),
    [params.id],
  );

  const { data, loading, error } = useDocSnapshot(docRef);

  const callerBits = useMemo(() => {
    try {
      return claims?.permissions ? BigInt(claims.permissions) : 0n;
    } catch {
      return 0n;
    }
  }, [claims?.permissions]);

  async function handleSubmit(values: Cargo) {
    await setDoc(docRef, values, { merge: true });
    router.replace(`/configuracoes/cargos/${params.id}`);
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Editar cargo</Title>
        <Anchor
          component={Link}
          href={`/configuracoes/cargos/${params.id}`}
          size="sm"
        >
          Cancelar
        </Anchor>
      </Group>

      {error && <Alert color="red">{error.message}</Alert>}
      {loading && <Skeleton height={300} />}
      {!loading && !data && (
        <Alert color="yellow">Cargo não encontrado.</Alert>
      )}
      {!loading && data && (
        <CargoForm
          defaultValues={data.data}
          submitLabel="Salvar alterações"
          onSubmit={handleSubmit}
          callerBits={callerBits}
        />
      )}
      {!loading && (
        <Group>
          <Button
            component={Link}
            href="/configuracoes/cargos"
            variant="subtle"
          >
            Voltar à lista
          </Button>
        </Group>
      )}
    </Stack>
  );
}
