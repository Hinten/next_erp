'use client';

import type { ReactNode } from 'react';
import { Group, Stack, Text, Title } from '@mantine/core';

export interface PageHeaderProps {
  title: ReactNode;
  /**
   * Subtitle, breadcrumb-style hint, or short description rendered below
   * the title in dimmed text.
   */
  description?: ReactNode;
  /**
   * Action buttons / links (Mantine `<Button>` typically) rendered at
   * the right of the header. Each consumer wires its own routing.
   */
  actions?: ReactNode;
}

/**
 * Standardized page header used by every domain vertical (clientes,
 * produtos, pedidos…). Keeps spacing/typography consistent and gives a
 * single place to evolve the look.
 */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <Group justify="space-between" align="flex-end" wrap="nowrap">
      <Stack gap={2}>
        {typeof title === 'string' ? <Title order={2}>{title}</Title> : title}
        {description && (
          <Text c="dimmed" size="sm">
            {description}
          </Text>
        )}
      </Stack>
      {actions && <Group>{actions}</Group>}
    </Group>
  );
}
