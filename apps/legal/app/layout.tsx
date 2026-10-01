import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Governança | Delfrance', template: '%s | Delfrance' },
  description: 'Termos de Uso e Política de Privacidade do Delfrance ERP e CRM.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <a className="skip-link" href="#conteudo">
          Ir para o conteúdo
        </a>
        <header className="site-header">
          <Link className="brand" href="/" prefetch={false} aria-label="Delfrance — Governança">
            Delfrance
          </Link>
          <nav aria-label="Governança">
            <Link href="/termos-de-uso" prefetch={false}>
              Termos de Uso
            </Link>
            <Link href="/politica-privacidade" prefetch={false}>
              Privacidade
            </Link>
          </nav>
        </header>
        <main id="conteudo" tabIndex={-1}>
          {children}
        </main>
        <footer className="site-footer">Delfrance ERP e CRM</footer>
      </body>
    </html>
  );
}
