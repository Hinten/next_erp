'use client';

import type { ReactNode } from 'react';
import { MantineProvider } from '@mantine/core';
import { cssVariablesResolver, theme } from '@delfrance/ui';

/**
 * Client-side MantineProvider wrapper: `cssVariablesResolver` is a function and
 * cannot cross the RSC serialization boundary from the server root layout.
 */
export function MantineAppProvider({ children }: { children: ReactNode }) {
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="light"
    >
      {children}
    </MantineProvider>
  );
}
