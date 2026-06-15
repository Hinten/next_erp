'use client';

import type { ReactNode } from 'react';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';

export default function CategoriasLayout({ children }: { children: ReactNode }) {
  return (
    <RequirePerm bit={PERM.categoria.read} redirectTo="/inicio">
      {children}
    </RequirePerm>
  );
}
