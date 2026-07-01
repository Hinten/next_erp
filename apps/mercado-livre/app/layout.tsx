import type { ReactNode } from 'react';

export const metadata = {
  title: 'Delfrance Mercado Livre',
  description: 'API-only Next.js app for the Mercado Livre sales-channel integration.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
