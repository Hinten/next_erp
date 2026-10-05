'use client';
import { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Alert, Anchor, Button, Group, Skeleton, Stack, Title } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import type { Cargo, Usuario } from '@delfrance/schemas';
import { useAuth, useIsSuperUser, usePermission, useTenant } from '@/lib/auth';
import { readCargo, readUsuario, saveCargo, saveUsuario } from '@/lib/admin/access';
import { AdminClientHttpError, AdminClientNetworkError } from '@/lib/admin/users';
import { CargoForm } from '@/app/(app)/configuracoes/cargos/_components/CargoForm';
import { UsuarioForm } from '@/app/(app)/configuracoes/usuarios/_components/UsuarioForm';
import { AccessOperationPanel, useAccessOperationMemory } from './AccessOperationPanel';

export function AccessEditor({ id, cargo }: { id: string; cargo: boolean }) {
  const { user } = useAuth();
  const { claims } = useTenant();
  const su = useIsSuperUser();
  const { allowed: canWrite } = usePermission(PERM.configuracoes.write);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commandId = useRef<string | null>(null);
  const { operationId, remember } = useAccessOperationMemory(
    `${cargo ? 'cargos' : 'usuarios'}/${id}`,
  );
  const cargoQuery = useQuery({
    queryKey: ['cargo-editor', id, user?.uid],
    enabled: cargo && !!user,
    queryFn: async () => readCargo(id, await user!.getIdToken()),
    refetchOnWindowFocus: false,
  });
  const userQuery = useQuery({
    queryKey: ['usuario-editor', id, user?.uid],
    enabled: !cargo && !!user,
    queryFn: async () => readUsuario(id, await user!.getIdToken()),
    refetchOnWindowFocus: false,
  });
  const currentQuery = cargo ? cargoQuery : userQuery;
  const refetch = currentQuery.refetch;
  const onFinished = useCallback(
    (success: boolean) => {
      setPending(false);
      commandId.current = null;
      if (success) void refetch();
    },
    [refetch],
  );
  let bits = 0n;
  try {
    bits = BigInt(claims?.permissions ?? '0');
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
  }
  async function submit(value: Cargo | Usuario | null) {
    if (!user || !currentQuery.data) return;
    setError(null);
    const operation = commandId.current ?? crypto.randomUUID();
    commandId.current = operation;
    try {
      const result = cargo
        ? await saveCargo(
            id,
            value as Cargo | null,
            currentQuery.data.version,
            operation,
            await user.getIdToken(),
          )
        : await saveUsuario(
            id,
            value as Usuario,
            currentQuery.data.version,
            operation,
            await user.getIdToken(),
          );
      remember(result.operationId);
      setPending(true);
    } catch (err) {
      if (err instanceof AdminClientHttpError || err instanceof AdminClientNetworkError) {
        setError(err.message);
        if (err instanceof AdminClientHttpError) {
          commandId.current = null;
          if (err.operationId) remember(err.operationId);
        }
      } else throw err;
    }
  }
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>{cargo ? 'Cargo' : 'Usuário'}</Title>
        <Anchor component={Link} href={`/configuracoes/${cargo ? 'cargos' : 'usuarios'}`}>
          Voltar à lista
        </Anchor>
      </Group>
      {operationId && (
        <AccessOperationPanel key={operationId} id={operationId} onFinished={onFinished} />
      )}
      {(error || currentQuery.error) && (
        <Alert color="red">{error ?? currentQuery.error?.message}</Alert>
      )}
      {currentQuery.isPending && <Skeleton height={300} />}
      {cargo && cargoQuery.data && (
        <CargoForm
          key={cargoQuery.data.version}
          defaultValues={cargoQuery.data.value}
          callerBits={bits}
          readOnly={!canWrite || pending}
          submitLabel="Salvar alterações"
          onSubmit={submit}
        />
      )}
      {!cargo && userQuery.data && (
        <UsuarioForm
          key={userQuery.data.version}
          defaultValues={userQuery.data.value}
          callerIsSuperUser={su}
          readOnly={!canWrite || pending}
          submitLabel="Salvar alterações"
          onSubmit={submit}
        />
      )}
      {cargo && cargoQuery.data && canWrite && (
        <Button
          color="red"
          variant="light"
          disabled={pending}
          onClick={() => {
            if (confirm('Excluir este cargo e atualizar as permissões dos usuários atribuídos?'))
              void submit(null);
          }}
        >
          Excluir
        </Button>
      )}
    </Stack>
  );
}
