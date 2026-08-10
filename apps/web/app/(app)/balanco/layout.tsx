'use client';

import type { ReactNode } from 'react';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';

/**
 * All routes under /balanco require estoque.read. Write actions (lançar,
 * cancelar, finalizar) are gated separately on `estoque.write` inside the
 * screens; the real enforcement is the Firestore rules plus the
 * `finalizarBalanco` callable, which checks the bit itself because the Admin
 * SDK bypasses rules.
 */
export default function BalancoLayout({ children }: { children: ReactNode }) {
  return (
    <RequirePerm bit={PERM.estoque.read} redirectTo="/inicio">
      {children}
    </RequirePerm>
  );
}
