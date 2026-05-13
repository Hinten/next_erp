'use client';

import type { ReactNode } from 'react';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';

/**
 * All routes under /clientes require the cliente.read permission. Writes
 * are still gated separately by Firestore rules; this layout protects the
 * UI from rendering for users who can't even see the data.
 */
export default function ClientesLayout({ children }: { children: ReactNode }) {
  return (
    <RequirePerm bit={PERM.cliente.read} redirectTo="/inicio">
      {children}
    </RequirePerm>
  );
}
