import type { ReactNode } from 'react';

export const metadata = {
  title: 'Delfrance Integrations',
  description: 'API-only Next.js app for webhooks and OAuth callbacks.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
