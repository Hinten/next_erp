'use client';

import { useState } from 'react';
import { Box, Center, Group, Stack, Text } from '@mantine/core';
import { PageHeader } from '@delfrance/ui';
import { WhatsAppList } from './_components/WhatsAppList';

export default function WhatsAppIndexPage() {
  const [search, setSearch] = useState('');

  return (
    <Stack h="calc(100vh - 96px)" gap="md">
      <PageHeader title="WhatsApp" description="Inbox de WhatsApp Cloud API (origem='whatsapp')" />
      <Group align="stretch" gap="md" style={{ flex: 1, minHeight: 0 }}>
        <Box
          w={320}
          style={{
            borderRight: '1px solid var(--mantine-color-gray-2)',
            paddingRight: 12,
          }}
        >
          <WhatsAppList search={search} onSearchChange={setSearch} />
        </Box>
        <Center style={{ flex: 1 }}>
          <Text c="dimmed">Selecione uma conversa para começar.</Text>
        </Center>
      </Group>
    </Stack>
  );
}
