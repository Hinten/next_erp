'use client';

import { Alert, Code, Stack, Text } from '@mantine/core';

export interface PlaceholderTabProps {
  name: string;
  /**
   * Optional snippet of existing data that the future tab will manage.
   * When present, rendered as a JSON preview so the user knows the
   * field is non-empty even though there's no UI for it yet.
   */
  preview?: unknown;
}

export function PlaceholderTab({ name, preview }: PlaceholderTabProps) {
  const hasPreview =
    preview !== undefined &&
    preview !== null &&
    !(Array.isArray(preview) && preview.length === 0) &&
    !(
      typeof preview === 'object' &&
      preview !== null &&
      Object.keys(preview as object).length === 0
    );

  return (
    <Stack>
      <Alert color="gray">
        <Text>
          <strong>{name}</strong> — em breve. Use o app antigo para editar este bloco.
        </Text>
      </Alert>
      {hasPreview && (
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            Dados atuais (somente leitura):
          </Text>
          <Code block>{JSON.stringify(preview, null, 2)}</Code>
        </Stack>
      )}
    </Stack>
  );
}
