'use client';

/**
 * Show an error toast with a copy button next to the message and
 * hover-to-pause dismissal. Pause is implemented via
 * `notifications.update({ id, autoClose })` — Mantine's timer reads
 * the latest value, so toggling `false` on `mouseenter` and back to
 * the original on `mouseleave` is enough.
 *
 * `message` is a string so the copy button can write it to clipboard.
 * Callers needing rich JSX should call `notifications.show()` directly.
 */
import type { ReactNode } from 'react';
import { ActionIcon, CopyButton, Group, Text, Tooltip } from '@mantine/core';
import type { MantineColor } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconCopy } from '@tabler/icons-react';

const DEFAULT_AUTO_CLOSE = 8000;

export interface ErrorNotificationConfig {
  readonly title: string;
  readonly message: string;
  readonly color?: MantineColor;
  readonly autoClose?: number;
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `err-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// Let the title wrap onto multiple lines instead of Mantine's default
// single-line ellipsis (`white-space: nowrap`), so cert-path-class titles stay
// fully readable. Re-passed on every show/update so it survives hover-pause.
const ERROR_NOTIFICATION_STYLES = {
  title: { whiteSpace: 'normal' as const, wordBreak: 'break-word' as const },
};

// ~12 lines before the message body starts to scroll; keeps very long
// diagnostics inside the toast bounds instead of overflowing it.
const MESSAGE_MAX_HEIGHT = 240;

export function showErrorNotification(config: ErrorNotificationConfig): void {
  const id = makeId();
  const autoClose = config.autoClose ?? DEFAULT_AUTO_CLOSE;
  const color = config.color ?? 'red';
  const { title, message } = config;

  // Shared props re-passed on every show/update so the title-wrap style and
  // close button persist while the user hovers to read a long message —
  // regardless of whether Mantine's `update` merges or replaces.
  const base = { id, title, color, withCloseButton: true, styles: ERROR_NOTIFICATION_STYLES };

  // `let` so the inner hover handlers can reference the node after it's
  // built — Mantine's `notifications.update` requires `message` on every
  // call, so we re-pass the same JSX on each pause/resume toggle.
  let messageNode: ReactNode;
  const pause = () => notifications.update({ ...base, autoClose: false, message: messageNode });
  const resume = () => notifications.update({ ...base, autoClose, message: messageNode });

  messageNode = (
    <Group
      justify="space-between"
      wrap="nowrap"
      align="flex-start"
      gap="xs"
      onMouseEnter={pause}
      onMouseLeave={resume}
    >
      {/* `minWidth: 0` lets this flex item shrink so the text wraps instead of
          overflowing; the body scrolls past MESSAGE_MAX_HEIGHT while the copy
          button (a sibling) stays pinned top-right and never scrolls away. */}
      <div style={{ flex: 1, minWidth: 0, maxHeight: MESSAGE_MAX_HEIGHT, overflowY: 'auto' }}>
        <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {message}
        </Text>
      </div>
      <CopyButton value={message} timeout={1500}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? 'Copiado!' : 'Copiar'} withArrow position="left">
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              onClick={copy}
              aria-label="Copiar mensagem de erro"
            >
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  );

  notifications.show({ ...base, autoClose, message: messageNode });
}
