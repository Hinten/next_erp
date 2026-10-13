'use client';

import { ActionIcon, Box, Tooltip, useMantineColorScheme } from '@mantine/core';
import { IconMoon, IconSun } from '@tabler/icons-react';

export function ColorSchemeToggle() {
  const { toggleColorScheme } = useMantineColorScheme();

  return (
    <Tooltip label="Alternar tema">
      <ActionIcon
        variant="subtle"
        color="gray"
        size="lg"
        aria-label="Alternar tema"
        onClick={toggleColorScheme}
      >
        <Box component="span" darkHidden aria-hidden>
          <IconMoon size={18} />
        </Box>
        <Box component="span" lightHidden aria-hidden>
          <IconSun size={18} />
        </Box>
      </ActionIcon>
    </Tooltip>
  );
}
