'use client';

import type { ReactNode } from 'react';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';

/**
 * All routes under /operacoes require the fiscal.read permission. Writes are
 * gated separately by Firestore rules; this layout keeps the UI from rendering
 * for users who can't see the fiscal data.
 */
export default function OperacoesLayout({ children }: { children: ReactNode }) {
  return (
    <RequirePerm bit={PERM.fiscal.read} redirectTo="/inicio">
      {children}
    </RequirePerm>
  );
}
