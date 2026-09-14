'use client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Alert, Anchor, Button, Group, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { ACCESS_ACTION as A, ACCESS_PHASE as P } from '@delfrance/schemas';
import { useAuth } from '@/lib/auth';
import { readAccessOperation, retryAccessOperation } from '@/lib/admin/access';
import { AdminClientHttpError, AdminClientNetworkError } from '@/lib/admin/users';

const labels = {
  [P.provisioning]: 'Preparando conta',
  [P.validating]: 'Validando permissões — o registro ainda não mudou',
  [P.applying]: 'Atualizando usuários',
  [P.completed]: 'Atualização concluída',
  [P.rejected]: 'Alteração rejeitada — o registro não foi alterado',
  [P.failed]: 'Atualização interrompida — há usuários pendentes',
};
export function AccessOperationPanel({
  id,
  onFinished,
}: {
  id: string;
  onFinished?: (success: boolean) => void;
}) {
  const { user } = useAuth();
  const reported = useRef<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['access-operation', id, user?.uid],
    queryFn: async () => readAccessOperation(id, await user!.getIdToken()),
    enabled: !!user,
    refetchInterval: (query) => {
      const phase = query.state.data?.phase;
      return phase === P.completed || phase === P.rejected || phase === P.failed ? false : 2000;
    },
  });
  const op = query.data;
  useEffect(() => {
    if (
      op &&
      (op.phase === P.completed || op.phase === P.rejected || op.phase === P.failed) &&
      reported.current !== op.id
    ) {
      reported.current = op.id;
      onFinished?.(op.phase === P.completed);
    }
  }, [op, onFinished]);
  async function retry() {
    if (!user) return;
    setRetryError(null);
    try {
      await retryAccessOperation(id, await user.getIdToken());
      reported.current = null;
      await query.refetch();
    } catch (err) {
      if (err instanceof AdminClientHttpError || err instanceof AdminClientNetworkError)
        setRetryError(err.message);
      else throw err;
    }
  }
  return (
    <Stack gap="xs">
      {query.error && <Alert color="red">{query.error.message}</Alert>}
      {op && (
        <Alert
          color={
            op.phase === P.completed
              ? 'green'
              : op.phase === P.rejected || op.phase === P.failed
                ? 'red'
                : 'blue'
          }
          title={labels[op.phase]}
        >
          <Stack gap="xs">
            <Text size="sm">
              Validados: {op.validated} · Processados: {op.processed} · Atualizados: {op.updated} ·
              Já corretos: {op.unchanged}
            </Text>
            <Text size="sm">
              Contatos externos: {op.external} · Contas ausentes: {op.missing}
            </Text>
            {op.errorMessage && (
              <Text>
                {op.errorMessage} ({op.errorCode})
              </Text>
            )}
            <Text size="sm">
              As permissões da sessão mudam quando o token de acesso é renovado.
            </Text>
            <Group>
              <Anchor component={Link} href={`/configuracoes/operacoes-acesso/${id}`}>
                Acompanhar operação
              </Anchor>
              {op.phase === P.failed && (
                <Button size="xs" onClick={retry}>
                  Retomar atualização
                </Button>
              )}
              {op.phase === P.completed && op.command.action !== A.deleteCargo && (
                <Anchor
                  component={Link}
                  href={`/configuracoes/${op.command.action.endsWith('Cargo') ? 'cargos' : 'usuarios'}/${op.command.targetId}`}
                >
                  Abrir registro
                </Anchor>
              )}
            </Group>
          </Stack>
        </Alert>
      )}
      {retryError && <Alert color="red">{retryError}</Alert>}
    </Stack>
  );
}
function subscribeMemory(notify: () => void) {
  window.addEventListener('storage', notify);
  window.addEventListener('access-operation-memory', notify);
  return () => {
    window.removeEventListener('storage', notify);
    window.removeEventListener('access-operation-memory', notify);
  };
}
/** Store only the operation ID, scoped to the signed-in user and editor. */
export function useAccessOperationMemory(scope: string) {
  const { user } = useAuth();
  const key = user ? `access-operation:${user.uid}:${scope}` : null;
  const id = useSyncExternalStore(
    subscribeMemory,
    () => (key ? localStorage.getItem(key) : null),
    () => null,
  );
  function remember(next: string) {
    if (key) localStorage.setItem(key, next);
    window.dispatchEvent(new Event('access-operation-memory'));
  }
  return { operationId: id, remember };
}
