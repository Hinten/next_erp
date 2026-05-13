'use client';

import type { ReactNode } from 'react';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';

export default function ProdutosLayout({ children }: { children: ReactNode }) {
  return (
    <RequirePerm bit={PERM.produto.read} redirectTo="/inicio">
      {children}
    </RequirePerm>
  );
}
