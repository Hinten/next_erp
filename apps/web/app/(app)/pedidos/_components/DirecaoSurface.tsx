'use client';

import type { ReactNode } from 'react';
import { Box } from '@mantine/core';
import type { Direcao } from './direcao';

/**
 * Entrada-only tinted work-area wrapper. Saída renders children bare so the
 * default surface stays byte-identical; entrada bleeds a tinted background
 * over the AppShell.Main padding (negative margin) and re-applies the same
 * padding inside, so children keep their exact position and the existing
 * `mih: calc(100dvh - header - padding*2)` sticky-footer layouts still fill
 * the surface's content box. The tint color comes exclusively from the theme
 * variable `--erp-entrada-surface` (packages/ui) — no hardcoded color here.
 */
export function DirecaoSurface({ direcao, children }: { direcao: Direcao; children: ReactNode }) {
  if (direcao !== 'entrada') return <>{children}</>;
  return (
    <Box
      data-direcao="entrada"
      style={{
        backgroundColor: 'var(--erp-entrada-surface)',
        margin: 'calc(var(--app-shell-padding, 1rem) * -1)',
        padding: 'var(--app-shell-padding, 1rem)',
        // Full work area below the AppShell header (padding is inside the box).
        minHeight: 'calc(100dvh - var(--app-shell-header-height, 56px))',
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
      }}
    >
      {children}
    </Box>
  );
}
