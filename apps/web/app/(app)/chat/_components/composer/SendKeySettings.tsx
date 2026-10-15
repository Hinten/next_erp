'use client';

import { ActionIcon, Popover, Select, Stack, Text } from '@mantine/core';
import { IconSettings } from '@tabler/icons-react';
import type { SendKey } from '@/lib/chat/sendKey';

/**
 * Composer settings popover — the "send key" preference (legacy `enviarMsg`
 * dropdown, `.old/lib/chat/basico/chat_input.dart:435-458`). ⌘/Ctrl+Enter
 * (default) vs Enter to send.
 */
export function SendKeySettings({
  value,
  onChange,
}: {
  value: SendKey;
  onChange: (v: SendKey) => void;
}) {
  return (
    <Popover position="top-end" withArrow shadow="md">
      <Popover.Target>
        <ActionIcon variant="subtle" color="gray" aria-label="Configurações do envio">
          <IconSettings size={20} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs" w={220}>
          <Text size="sm" fw={600}>
            Tecla de envio
          </Text>
          <Select
            size="xs"
            value={value}
            onChange={(v) => v && onChange(v as SendKey)}
            data={[
              { value: 'ctrlEnter', label: '⌘/Ctrl + Enter envia' },
              { value: 'enter', label: 'Enter envia (Shift+Enter quebra linha)' },
            ]}
            comboboxProps={{ withinPortal: true }}
            allowDeselect={false}
          />
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
