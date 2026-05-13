'use client';

import type { ReactNode } from 'react';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';

export default function PagamentosLayout({ children }: { children: ReactNode }) {
  return (
    <RequirePerm bit={PERM.pagamento.read} redirectTo="/inicio">
      {children}
    </RequirePerm>
  );
}
