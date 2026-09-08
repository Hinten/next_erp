'use client';

import { useEffect } from 'react';
import { ActionIcon, Indicator, Popover, ScrollArea, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useAuth } from '@/lib/auth';
import { useAvisos } from '@/lib/avisos/useAvisos';
// Reused, not re-implemented: a second copy of "hidden at zero, 9+ above nine"
// is exactly the kind of duplicate that drifts toward plausible while both
// copies look right in review.
import { formatBadgeCount } from '@/lib/chat/badges';
import { AvisosPanel } from './AvisosPanel';

/**
 * The notification bell in the app shell.
 *
 * The `document.title` mutation is not decoration: the dominant real case for an
 * ERP the operator keeps open all day is the tab sitting in the BACKGROUND, where
 * a badge nobody is looking at conveys nothing. Prefixing the title costs
 * nothing, needs no permission prompt, no service worker and no VAPID key, and it
 * is visible in the tab strip — which is the whole benefit web push was going to
 * buy for an operator who is already in the app.
 */
export function AvisosBell() {
  const { user } = useAuth();
  const [opened, { toggle, close }] = useDisclosure(false);
  const { rows, naoLidos, loading, marcarComoLido, marcarTodosLidos } = useAvisos();

  useEffect(() => {
    const base = 'Delfrance';
    document.title = naoLidos > 0 ? `(${String(naoLidos)}) ${base}` : base;
    return () => {
      document.title = base;
    };
  }, [naoLidos]);

  if (!user) return null;

  const badge = formatBadgeCount(naoLidos);

  return (
    <Popover
      opened={opened}
      onChange={close}
      position="bottom-end"
      width={380}
      shadow="md"
      trapFocus
    >
      <Popover.Target>
        <Indicator label={badge ?? undefined} size={16} disabled={badge === null} color="red">
          <ActionIcon
            variant="subtle"
            color="gray"
            size="lg"
            aria-label={naoLidos > 0 ? `Avisos (${String(naoLidos)} não lidos)` : 'Avisos'}
            onClick={toggle}
          >
            {/* Inline glyph rather than an icon dependency — the shell has none. */}
            <Text component="span" size="lg" aria-hidden>
              🔔
            </Text>
          </ActionIcon>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown p={0}>
        <ScrollArea.Autosize mah={420}>
          <Stack gap={0} p="xs">
            <AvisosPanel
              rows={rows}
              loading={loading}
              naoLidos={naoLidos}
              onMarcarLido={marcarComoLido}
              onMarcarTodosLidos={marcarTodosLidos}
              onNavegar={close}
            />
          </Stack>
        </ScrollArea.Autosize>
      </Popover.Dropdown>
    </Popover>
  );
}
