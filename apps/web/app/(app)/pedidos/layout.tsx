'use client';

import type { ReactNode } from 'react';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';

export default function PedidosLayout({ children }: { children: ReactNode }) {
  return (
    <RequirePerm bit={PERM.pedido.read} redirectTo="/inicio">
      {children}
    </RequirePerm>
  );
}
