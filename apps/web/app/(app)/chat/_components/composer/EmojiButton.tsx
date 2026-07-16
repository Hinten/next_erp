'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useComputedColorScheme } from '@mantine/core';
import { ActionIcon, Loader, Popover } from '@mantine/core';
import { IconMoodSmile } from '@tabler/icons-react';

// Lazy boundary: the emoji-mart chunk (Picker + data) loads only when the
// popover opens (ssr:false — emoji-mart needs the DOM).
const EmojiPickerInner = dynamic(() => import('./EmojiPickerInner'), {
  ssr: false,
  loading: () => <Loader size="sm" m="md" />,
});

/**
 * Smiley `ActionIcon` that opens an emoji picker popover; a picked emoji is
 * inserted at the composer's cursor via `onSelect` (legacy `add_reaction`
 * button + `EmojiPicker`, `.old/lib/chat/basico/chat_input.dart:424-430`).
 */
export function EmojiButton({
  onSelect,
  disabled,
}: {
  onSelect: (native: string) => void;
  disabled?: boolean;
}) {
  const [opened, setOpened] = useState(false);
  const scheme = useComputedColorScheme('light');

  return (
    <Popover opened={opened} onChange={setOpened} position="top-end" withArrow shadow="md">
      <Popover.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          onClick={() => setOpened((o) => !o)}
          disabled={disabled}
          aria-label="Emojis"
        >
          <IconMoodSmile size={20} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown p={0}>
        {opened && (
          <EmojiPickerInner
            theme={scheme}
            onSelect={(native) => {
              onSelect(native);
              setOpened(false);
            }}
          />
        )}
      </Popover.Dropdown>
    </Popover>
  );
}
