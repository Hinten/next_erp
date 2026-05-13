'use client';

import { useMemo, useState } from 'react';
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
import type { Usuario } from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { useAuth, useIsSuperUser } from '@/lib/auth';
import { UsuarioForm } from '../../_components/UsuarioForm';
import { usuarioCollection } from '@/lib/data/usuarioCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { refreshClaims } from '@/lib/admin/users';

export default function EditarUsuarioPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const callerIsSuperUser = useIsSuperUser();
  const [claimsWarning, setClaimsWarning] = useState<string | null>(null);

  const docRef = useMemo(
    () => usuarioCollection.docRef(getFirebaseFirestore(), {}, params.id),
    [params.id],
  );
  const { data, loading, error } = useDocSnapshot(docRef);

  async function handleSubmit(values: Usuario) {
    await setDoc(docRef, values, { merge: true });
    // Recompute custom claims on the server so the next token refresh reflects
    // the new cargo set. Failure here is non-fatal — the Firestore doc is the
    // source of truth, claims will resync on next refresh.
    if (user) {
      try {
        const idToken = await user.getIdToken();
        await refreshClaims(params.id, idToken);
        setClaimsWarning(null);
      } catch (err) {
        setClaimsWarning(
          err instanceof Error
            ? `Claims não recomputados: ${err.message}`
            : 'Claims não recomputados.',
        );
      }
    }
    router.replace(`/configuracoes/usuarios/${params.id}`);
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Editar usuário</Title>
        <Anchor
          component={Link}
          href={`/configuracoes/usuarios/${params.id}`}
          size="sm"
        >
          Cancelar
        </Anchor>
      </Group>

      {claimsWarning && <Alert color="yellow">{claimsWarning}</Alert>}
      {error && <Alert color="red">{error.message}</Alert>}
      {loading && <Skeleton height={300} />}
      {!loading && !data && (
        <Alert color="yellow">Usuário não encontrado.</Alert>
      )}
      {!loading && data && (
        <UsuarioForm
          defaultValues={data.data}
          submitLabel="Salvar alterações"
          onSubmit={handleSubmit}
          callerIsSuperUser={callerIsSuperUser}
        />
      )}
      {!loading && (
        <Group>
          <Button
            component={Link}
            href="/configuracoes/usuarios"
            variant="subtle"
          >
            Voltar à lista
          </Button>
        </Group>
      )}
    </Stack>
  );
}
