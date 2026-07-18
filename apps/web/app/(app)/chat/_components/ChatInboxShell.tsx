'use client';

import { Suspense, type ReactNode } from 'react';
import { Box, Group, Skeleton, Stack } from '@mantine/core';
import { PageHeader } from '@delfrance/ui';
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
}: {
  activeId?: string;
  children: ReactNode;
  rightPane?: ReactNode;
}) {
  return (
    <Stack h="calc(100vh - 96px)" gap="md">
      <PageHeader title="Chat" description="Atendimentos em tempo real" />
      <Group align="stretch" gap="md" style={{ flex: 1, minHeight: 0 }} wrap="nowrap">
        <Box
          w={LIST_PANE_WIDTH}
          style={{
            flex: `0 0 ${LIST_PANE_WIDTH}px`,
            borderRight: '1px solid var(--mantine-color-gray-2)',
            paddingRight: 12,
            minHeight: 0,
          }}
        >
          <Suspense fallback={<ListPaneFallback />}>
            <ConversaListPane activeId={activeId} />
          </Suspense>
        </Box>
        <Box style={{ flex: 1, minWidth: 0, display: 'flex', minHeight: 0 }}>{children}</Box>
        {rightPane}
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
