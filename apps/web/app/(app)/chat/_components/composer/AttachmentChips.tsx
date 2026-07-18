'use client';

import { ActionIcon, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconFile, IconX } from '@tabler/icons-react';

export interface PendingAttachment {
  /** Local id (not the arquivo id). */
  id: string;
  name: string;
  size: number;
  status: 'uploading' | 'done' | 'error';
  /** The arquivo outer-ref once uploaded (used to build the media write). */
  arquivoRef?: string;
  /** The arquivo filetype once uploaded. */
  filetype?: string;
  error?: string | null;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Pending-attachment chips shown above the composer input (legacy
 * `UploadFileField`, `.old/lib/chat/basico/chat_input.dart:859-1082`): name +
 * size, an indeterminate spinner while uploading, an error marker, and a remove
 * button.
 */
export function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <Stack gap={4} mb="xs">
      {attachments.map((a) => (
        <Paper key={a.id} withBorder p={6} radius="sm">
          <Group gap="xs" wrap="nowrap">
            {a.status === 'uploading' ? (
              <Loader size="xs" />
            ) : a.status === 'error' ? (
              <IconAlertTriangle size={16} color="var(--mantine-color-red-6)" />
            ) : (
              <IconFile size={16} />
            )}
            <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
              <Text size="xs" fw={500} lineClamp={1}>
                {a.name}
              </Text>
              <Text size="xs" c={a.status === 'error' ? 'red' : 'dimmed'}>
                {a.status === 'error' ? (a.error ?? 'Falha no upload') : humanSize(a.size)}
              </Text>
            </Stack>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              onClick={() => onRemove(a.id)}
              aria-label={`Remover ${a.name}`}
            >
              <IconX size={14} />
            </ActionIcon>
          </Group>
        </Paper>
      ))}
    </Stack>
  );
}
