import '@mantine/core/styles.css';
import '@mantine/dates/styles.css';
import '@mantine/notifications/styles.css';
import '@mantine/charts/styles.css';

import type { ReactNode } from 'react';
import { ColorSchemeScript, mantineHtmlProps } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { AuthProvider } from '@/lib/auth';
import { QueryProvider } from '@/lib/query/QueryProvider';
import { MantineAppProvider } from './MantineAppProvider';

export const metadata = {
  title: 'Delfrance',
  description: 'ERP — Delfrance',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" {...mantineHtmlProps}>
      <head>
        <ColorSchemeScript defaultColorScheme="light" />
      </head>
      <body>
        <MantineAppProvider>
          <Notifications position="top-right" containerWidth={480} />
          <QueryProvider>
            <AuthProvider>{children}</AuthProvider>
          </QueryProvider>
        </MantineAppProvider>
      </body>
    </html>
  );
}
