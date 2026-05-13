'use client';

import type { ReactNode } from 'react';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';

/**
 * Reports require pedido.read. Finer-grained custom permissions
 * (relatorio_vendas_read, produtos_mais_vendidos_read in the Flutter
 * app) are folded into pedido.read for Phase 3 — split out later if a
 * tenant needs to expose vendas-only access without giving raw pedido
 * read.
 */
export default function RelatoriosLayout({ children }: { children: ReactNode }) {
  return (
    <RequirePerm bit={PERM.pedido.read} redirectTo="/inicio">
      {children}
    </RequirePerm>
  );
}
