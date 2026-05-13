'use client';

import type { ReactNode } from 'react';
import { Tooltip } from '@mantine/core';
import { usePermission } from '@/lib/auth';

export interface PermGateProps {
  bit: bigint;
  /** UI rendered when the caller has the bit. */
  children: ReactNode;
  /**
   * UI rendered when the caller lacks the bit. Must already be visually
   * disabled (e.g. `<Button disabled>` / `<ActionIcon disabled>`); the gate
   * wraps it in a Mantine `Tooltip` so the user knows why.
   */
  fallback: ReactNode;
  /** Tooltip text shown over the fallback. */
  tooltipLabel?: string;
}

/**
 * Show one UI when the caller has `bit`, another (with explanatory tooltip)
 * when they don't. Use instead of `<RequirePerm denied={null}>` for action
 * buttons / icons so users see why a control is unavailable rather than
 * having it silently disappear.
 *
 * Security boundary: this is UX only. The actual write rejection happens in
 * Firestore rules + the admin endpoints' cascade-permission guard.
 */
export function PermGate({
  bit,
  children,
  fallback,
  tooltipLabel = 'Sem permissão para esta ação.',
}: PermGateProps) {
  const { allowed, loading } = usePermission(bit);
  if (loading) return null;
  if (!allowed) {
    return (
      <Tooltip label={tooltipLabel} withArrow position="bottom">
        <span style={{ display: 'inline-block' }}>{fallback}</span>
      </Tooltip>
    );
  }
  return <>{children}</>;
}
