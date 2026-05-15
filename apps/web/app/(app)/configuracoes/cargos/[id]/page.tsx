'use client';

import { useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { deleteDoc, setDoc } from 'firebase/firestore';
import {
  Alert,
  Anchor,
  Button,
  Group,
  Skeleton,
  Stack,
  Title,
} from '@mantine/core';
import { PERM } from '@delfrance/auth';
import type { Cargo } from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { usePermission, useTenant } from '@/lib/auth';
import { CargoForm } from '../_components/CargoForm';
import { cargoCollection } from '@/lib/data/cargoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function CargoPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { claims } = useTenant();
  const { allowed: canWrite } = usePermission(PERM.configuracoes.write);

  const docRef = useMemo(
    () => cargoCollection.docRef(getFirebaseFirestore(), {}, params.id),
    [params.id],
  );

  const { data, loading, error } = useDocSnapshot(docRef);

  const callerBits = useMemo(() => {
    try {
      return claims?.permissions ? BigInt(claims.permissions) : 0n;
    } catch (err) {
      if (err instanceof SyntaxError) return 0n;
      throw err;
    }
  }, [claims?.permissions]);

  async function handleSubmit(values: Cargo) {
    await setDoc(docRef, values, { merge: true });
    router.replace('/configuracoes/cargos');
  }

  async function handleDelete() {
    if (
      !confirm(
        'Excluir este cargo? Usuários atualmente atribuídos perderão essas permissões na próxima atualização de claim.',
      )
    ) {
      return;
    }
    await deleteDoc(docRef);
    router.replace('/configuracoes/cargos');
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Cargo</Title>
        <Anchor component={Link} href="/configuracoes/cargos" size="sm">
          ← Voltar à lista
        </Anchor>
      </Group>

      {error && <Alert color="red">{error.message}</Alert>}
      {loading && <Skeleton height={300} />}
      {!loading && !data && <Alert color="yellow">Cargo não encontrado.</Alert>}
      {!loading && data && (
        <Stack>
          <CargoForm
            defaultValues={data.data}
            submitLabel="Salvar alterações"
            onSubmit={handleSubmit}
            callerBits={callerBits}
            readOnly={!canWrite}
          />
          {canWrite && (
            <Group justify="flex-start">
              <Button color="red" variant="light" onClick={handleDelete}>
                Excluir
              </Button>
            </Group>
          )}
        </Stack>
      )}
    </Stack>
  );
}
