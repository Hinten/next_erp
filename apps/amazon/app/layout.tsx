import type { ReactNode } from 'react';

export const metadata = {
  title: 'Delfrance Amazon',
  description: 'API-only Next.js app for the Amazon (SP-API) marketplace integration.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
