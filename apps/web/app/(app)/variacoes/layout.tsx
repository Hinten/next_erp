'use client';

import type { ReactNode } from 'react';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';

/**
 * Grupos de variação compõem o catálogo de produtos — reaproveitamos os bits de
 * permissão de produto (igual a `categorias`).
 */
export default function VariacoesLayout({ children }: { children: ReactNode }) {
  return (
    <RequirePerm bit={PERM.produto.read} redirectTo="/inicio">
      {children}
    </RequirePerm>
  );
}
