import type { ReactNode } from 'react';

export const metadata = {
  title: 'Delfrance NF-e',
  description: 'API-only Next.js app — NF-e issuance against SEFAZ.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
