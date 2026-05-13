'use client';

import { Stack, Text, Title } from '@mantine/core';

export default function InicioPage() {
  return (
    <Stack>
      <Title order={2}>Início</Title>
      <Text c="dimmed">
        Painel inicial. Métricas e atalhos virão aqui nas próximas fases.
      </Text>
    </Stack>
  );
}
