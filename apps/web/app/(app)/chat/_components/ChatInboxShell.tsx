'use client';

import { Suspense, type ReactNode } from 'react';
import Link from 'next/link';
import { Box, Button, Group, Skeleton, Stack } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import { PageHeader } from '@delfrance/ui';
import { WhatsappVinculosButton } from './WhatsappVinculosButton';
import { ConversaListPane } from './ConversaListPane';

/** Fixed width of the list pane (px). */
const LIST_PANE_WIDTH = 340;

/**
 * Three-pane inbox shell shared by `/chat` (empty state) and `/chat/[id]`
 * (thread): a fixed-width list pane, the main area (`children` — thread or
 * empty state), and an optional right-hand column (`rightPane` — the conversa
 * side panel, `/chat/[id]` only; it owns its own width/border/collapse). The
 * list pane consumes `useSearchParams`, so it sits behind a Suspense boundary
 * (Next 16 requirement).
 */
export function ChatInboxShell({
  activeId,
  children,
  rightPane,
  mobileRightPane,
}: {
  activeId?: string;
  children: ReactNode;
  rightPane?: ReactNode;
  mobileRightPane?: ReactNode;
}) {
  return (
    <Stack h="calc(100vh - 96px)" gap="md">
      <Group justify="space-between">
        <PageHeader title="Chat" description="Atendimentos em tempo real" />
        <Group gap="xs">
          <WhatsappVinculosButton />
          {mobileRightPane && <Box hiddenFrom="lg">{mobileRightPane}</Box>}
        </Group>
      </Group>
      {activeId && (
        <Button
          component={Link}
          href="/chat?tab=todas"
          variant="subtle"
          leftSection={<IconArrowLeft size={16} />}
          hiddenFrom="lg"
          size="xs"
          style={{ alignSelf: 'flex-start' }}
        >
          Voltar às conversas
        </Button>
      )}
      <Group align="stretch" gap="md" style={{ flex: 1, minHeight: 0 }} wrap="nowrap">
        <Box
          w={{ base: '100%', lg: LIST_PANE_WIDTH }}
          display={activeId ? { base: 'none', lg: 'block' } : undefined}
          style={{
            flex: '0 0 auto',
            borderRight: '1px solid var(--mantine-color-default-border)',
            paddingRight: 12,
            minHeight: 0,
          }}
        >
          <Suspense fallback={<ListPaneFallback />}>
            <ConversaListPane activeId={activeId} />
          </Suspense>
        </Box>
        <Box
          display={{ base: activeId ? 'flex' : 'none', lg: 'flex' }}
          style={{ flex: 1, minWidth: 0, minHeight: 0 }}
        >
          {children}
        </Box>
        {rightPane && (
          <Box visibleFrom="lg" style={{ display: 'flex', minHeight: 0 }}>
            {rightPane}
          </Box>
        )}
      </Group>
    </Stack>
  );
}

function ListPaneFallback() {
  return (
    <Stack gap={6}>
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} height={56} />
      ))}
    </Stack>
  );
}
