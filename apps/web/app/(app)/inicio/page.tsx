'use client';

import { Paper, Skeleton, Stack, Title } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { useAuth } from '@/lib/auth/useAuth';
import { usePermission } from '@/lib/auth/usePermission';
import { InicioDashboard } from './_components/InicioDashboard';
import { useAvisos } from '@/lib/avisos/useAvisos';
import { AvisosPanel } from '../_components/AvisosPanel';

export default function InicioPage() {
  const { user, loading: authLoading } = useAuth();
  const permission = usePermission(PERM.pedido.read);
  const { rows, naoLidos, loading, marcarComoLido, marcarTodosLidos } = useAvisos();

  return (
    <Stack>
      <Title order={2}>Início</Title>
      {authLoading || permission.loading ? (
        <Skeleton height={150} />
      ) : user && permission.allowed ? (
        <InicioDashboard key={user.uid} uid={user.uid} />
      ) : null}

      <Stack gap="xs">
        <Title order={4}>Avisos</Title>
        <Paper withBorder radius="md">
          {/* Same component as the bell popover, so the two views cannot drift
              about what an aviso says or which actions it offers. */}
          <AvisosPanel
            completo
            rows={rows}
            loading={loading}
            naoLidos={naoLidos}
            onMarcarLido={marcarComoLido}
            onMarcarTodosLidos={marcarTodosLidos}
          />
        </Paper>
      </Stack>
    </Stack>
  );
}
