'use client';

import { Stack, Text, Title } from '@mantine/core';

import { InutilizarForm } from './_components/InutilizarForm';

export default function InutilizarNfePage() {
  return (
    <Stack p="md" gap="lg">
      <Stack gap={4}>
        <Title order={2}>Inutilizar numeração</Title>
        <Text c="dimmed" size="sm">
          Inutiliza uma faixa de números de NF-e que nunca serão usados (lacunas
          de numeração). A operação é síncrona e definitiva na SEFAZ.
        </Text>
      </Stack>
      <InutilizarForm />
    </Stack>
  );
}
