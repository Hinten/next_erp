'use client';

import { Center, Text } from '@mantine/core';
import { ChatInboxShell } from './_components/ChatInboxShell';

export default function ChatIndexPage() {
  return (
    <ChatInboxShell>
      <Center style={{ flex: 1 }}>
        <Text c="dimmed">Selecione uma conversa para começar.</Text>
      </Center>
    </ChatInboxShell>
  );
}
