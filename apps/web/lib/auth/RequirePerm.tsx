'use client';

import type { ReactNode } from 'react';
import { Center, Stack, Text } from '@mantine/core';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { usePermission } from './usePermission';

export interface RequirePermProps {
  bit: bigint;
  children: ReactNode;
  /**
   * What to show while resolving claims (default: nothing).
   */
  fallback?: ReactNode;
  /**
   * What to show on denial. Defaults to a "Sem permissão" panel; pass
   * `null` to render nothing (use this when gating individual UI bits
   * inside a larger page that has its own gating).
   */
  denied?: ReactNode | null;
  /**
   * If set, redirects to this path when the permission is denied. Use
   * for full pages where rendering nothing would leave the user
   * stranded.
   */
  redirectTo?: string;
}

const DEFAULT_DENIED = (
  <Center mih={200}>
    <Stack align="center" gap="xs">
      <Text fw={600}>Sem permissão</Text>
      <Text c="dimmed" size="sm">
        Sua conta não tem permissão para ver este conteúdo.
      </Text>
    </Stack>
  </Center>
);

/**
 * Renders `children` only when the current user's permission claim
 * includes `bit`. Use anywhere in the auth-gated part of the app.
 *
 * Security boundary: this is a UX gate. Firestore rules are the actual
 * security. Never rely on hiding a button to prevent unauthorized
 * writes — the rules must reject the write too.
 */
export function RequirePerm({
  bit,
  children,
  fallback = null,
  denied = DEFAULT_DENIED,
  redirectTo,
}: RequirePermProps) {
  const { allowed, loading } = usePermission(bit);
  const router = useRouter();

  useEffect(() => {
    if (!loading && !allowed && redirectTo) {
      router.replace(redirectTo);
    }
  }, [loading, allowed, redirectTo, router]);

  if (loading) return <>{fallback}</>;
  if (!allowed) {
    if (redirectTo) return <>{fallback}</>;
    return <>{denied}</>;
  }
  return <>{children}</>;
}
