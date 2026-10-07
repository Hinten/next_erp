import type { ReactNode } from 'react';

export const metadata = {
  title: 'Delfrance Loja Integrada',
  description: 'API-only Next.js app for the Loja Integrada marketplace integration.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
