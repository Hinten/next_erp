'use client';

import type { ReactNode } from 'react';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';

/**
 * Categorias compõem o catálogo de produtos — reaproveitamos os bits de
 * permissão de produto. Quando o time decidir tratar permissão por domínio
 * separadamente, basta criar `PERM.categoria.*` em `packages/auth` e trocar.
 */
export default function CategoriasLayout({ children }: { children: ReactNode }) {
  return (
    <RequirePerm bit={PERM.produto.read} redirectTo="/inicio">
      {children}
    </RequirePerm>
  );
}
