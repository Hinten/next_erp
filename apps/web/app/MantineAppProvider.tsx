'use client';

import type { ReactNode } from 'react';
import { MantineProvider, localStorageColorSchemeManager } from '@mantine/core';
import { cssVariablesResolver, theme } from '@delfrance/ui';
import { COLOR_SCHEME_STORAGE_KEY } from '@/lib/theme/colorScheme';

const colorSchemeManager = localStorageColorSchemeManager({ key: COLOR_SCHEME_STORAGE_KEY });

/**
 * Client-side MantineProvider wrapper: `cssVariablesResolver` is a function and
 * cannot cross the RSC serialization boundary from the server root layout.
 */
export function MantineAppProvider({ children }: { children: ReactNode }) {
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="auto"
      colorSchemeManager={colorSchemeManager}
    >
      {children}
    </MantineProvider>
  );
}
