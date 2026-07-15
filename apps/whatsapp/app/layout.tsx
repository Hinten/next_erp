import type { ReactNode } from 'react';

export const metadata = {
  title: 'Delfrance WhatsApp',
  description: 'API-only Next.js app for the WhatsApp Business Cloud API integration.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
