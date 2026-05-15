'use client';

import { Stack, Text, Title } from '@mantine/core';

// DELIBERATE CI FAILURE TEST — reverted once the report-failure comment is verified
const __DELIBERATE_CI_FAILURE_TEST__ = ;

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
