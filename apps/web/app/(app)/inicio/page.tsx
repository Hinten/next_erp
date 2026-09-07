'use client';

import { Paper, Stack, Text, Title } from '@mantine/core';
import { useAvisos } from '@/lib/avisos/useAvisos';
import { AvisosPanel } from '../_components/AvisosPanel';

export default function InicioPage() {
  const { rows, naoLidos, loading, marcarComoLido, marcarTodosLidos } = useAvisos();

  return (
    <Stack>
      <Title order={2}>Início</Title>
      <Text c="dimmed">Painel inicial. Métricas e atalhos virão aqui nas próximas fases.</Text>

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
