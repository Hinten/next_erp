'use client';

import type { ReactNode } from 'react';
import { Alert, type AlertProps, Button, Group, Stack, Text } from '@mantine/core';

/**
 * A failed load the operator can act on, instead of one they can only read.
 *
 * The shape is lifted from `chat/_components/MensagemThread.tsx`, which was the
 * only place in the app that already did this. Everywhere else — every Mercado
 * Livre read, in particular — rendered a text-only `Alert` and left closing the
 * screen as the sole way out.
 *
 * Deliberately query-agnostic: it takes copy, not an `Error`, and knows nothing
 * about TanStack. Narrow the error with `describeMercadoLivreFailure` (or the
 * equivalent for another channel) and hand the result in. That keeps this
 * component's own test a bare Mantine render, and keeps channel vocabulary out
 * of a shared component.
 */
export interface RetryAlertProps {
  /** Heading. Omit for the one-line `compact` form. */
  readonly title?: string;
  /** Already-mapped operator copy. */
  readonly message: string;
  /**
   * Omit when the failure is NOT retryable (a disconnected account, a blocked
   * publish): a button that cannot help is worse than no button.
   */
  readonly onRetry?: () => void;
  readonly retrying?: boolean;
  readonly color?: AlertProps['color'];
  /** `compact` is the dense inline form for cards and form fields. */
  readonly variant?: 'default' | 'compact';
  /** Extra detail under the message — a list of validation issues, say. */
  readonly children?: ReactNode;
}

export function RetryAlert({
  title,
  message,
  onRetry,
  retrying = false,
  color = 'red',
  variant = 'default',
  children,
}: RetryAlertProps) {
  const compact = variant === 'compact';
  const button = onRetry && (
    <Button size="compact-xs" variant="subtle" color={color} loading={retrying} onClick={onRetry}>
      Tentar novamente
    </Button>
  );

  return (
    <Alert
      color={color}
      variant="light"
      title={compact ? undefined : title}
      py={compact ? 6 : undefined}
      p={compact ? 'xs' : undefined}
      ta="left"
    >
      <Stack gap={4}>
        <Group justify="space-between" gap="xs" wrap="nowrap">
          <Text size={compact ? 'xs' : 'sm'}>{message}</Text>
          {button}
        </Group>
        {children}
      </Stack>
    </Alert>
  );
}
