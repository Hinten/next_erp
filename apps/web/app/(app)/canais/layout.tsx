'use client';

import type { ReactNode } from 'react';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';

export default function CanaisLayout({ children }: { children: ReactNode }) {
  return (
    <RequirePerm bit={PERM.configuracoes.read} redirectTo="/inicio">
      {children}
    </RequirePerm>
  );
}
