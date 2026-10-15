'use client';
import { useRef, useState } from 'react';
import { Stack, Title } from '@mantine/core';
import { decodePermissoes, type Cargo } from '@delfrance/schemas';
import { useAuth, useIsSuperUser, useTenant } from '@/lib/auth';
import { AdminClientHttpError, createUser } from '@/lib/admin/users';
import { saveCargo } from '@/lib/admin/access';
import { CargoForm } from '@/app/(app)/configuracoes/cargos/_components/CargoForm';
import {
  UsuarioCreateForm,
  type CreateUserValues,
} from '@/app/(app)/configuracoes/usuarios/_components/UsuarioCreateForm';
import { AccessOperationPanel, useAccessOperationMemory } from './AccessOperationPanel';
export function AccessCreate({ cargo }: { cargo: boolean }) {
  const { user } = useAuth();
  const { claims } = useTenant();
  const su = useIsSuperUser();
  const [pending, setPending] = useState(false);
  const requestId = useRef<string | null>(null);
  const { operationId, remember } = useAccessOperationMemory(
    cargo ? 'cargos/novo' : 'usuarios/novo',
  );
  async function submit(values: Cargo | CreateUserValues) {
    if (!user) return;
    const id = requestId.current ?? crypto.randomUUID();
    requestId.current = id;
    const token = await user.getIdToken();
    try {
      const result = cargo
        ? await saveCargo(null, values as Cargo, null, id, token)
        : await createUser({ ...(values as CreateUserValues), operationId: id }, token);
      remember(result.operationId);
      setPending(true);
    } catch (err) {
      if (err instanceof AdminClientHttpError) {
        requestId.current = null;
        if (err.operationId) remember(err.operationId);
      }
      throw err;
    }
  }
  return (
    <Stack>
      <Title order={2}>{cargo ? 'Novo cargo' : 'Novo usuário'}</Title>
      {operationId && (
        <AccessOperationPanel
          key={operationId}
          id={operationId}
          onFinished={() => {
            setPending(false);
            requestId.current = null;
          }}
        />
      )}
      <fieldset disabled={pending || !user} style={{ border: 0, padding: 0, margin: 0 }}>
        {cargo ? (
          <CargoForm
            submitLabel="Criar"
            callerBits={decodePermissoes({ permissoes: claims?.permissions ?? '0' })}
            onSubmit={submit}
          />
        ) : (
          <UsuarioCreateForm callerIsSuperUser={su} onSubmit={submit} />
        )}
      </fieldset>
    </Stack>
  );
}
