'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Alert, Anchor, Group, Stack, Title } from '@mantine/core';
import { useAuth, useIsSuperUser } from '@/lib/auth';
import { UsuarioCreateForm, type CreateUserValues } from '../_components/UsuarioCreateForm';
import { createUser } from '@/lib/admin/users';

export default function NovoUsuarioPage() {
  const router = useRouter();
  const { user } = useAuth();
  const callerIsSuperUser = useIsSuperUser();

  async function handleSubmit(values: CreateUserValues) {
    if (!user) throw new Error('Sessão não autenticada.');
    const idToken = await user.getIdToken();
    const { uid } = await createUser(values, idToken);
    router.replace(`/configuracoes/usuarios/${uid}`);
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Novo usuário</Title>
        <Anchor component={Link} href="/configuracoes/usuarios" size="sm">
          Voltar
        </Anchor>
      </Group>
      {!user && <Alert color="yellow">Aguardando sessão de autenticação…</Alert>}
      {user && <UsuarioCreateForm onSubmit={handleSubmit} callerIsSuperUser={callerIsSuperUser} />}
    </Stack>
  );
}
