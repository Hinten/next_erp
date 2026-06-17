import type { ReactNode } from 'react';

export const metadata = {
  title: 'Delfrance Melhor Envio',
  description: 'API-only Next.js app for the Melhor Envio freight integration.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
