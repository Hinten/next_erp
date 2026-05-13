'use client';

import type { ReactNode } from 'react';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';

export default function NfeLayout({ children }: { children: ReactNode }) {
  return (
    <RequirePerm bit={PERM.nfe.read} redirectTo="/inicio">
      {children}
    </RequirePerm>
  );
}
