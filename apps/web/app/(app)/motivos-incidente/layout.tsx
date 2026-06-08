'use client';

import type { ReactNode } from 'react';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';

/**
 * Motivos de incidente pertencem ao domínio de pedidos — reaproveitamos os
 * bits de permissão de pedido. Writes seguem protegidos pelas Firestore rules.
 */
export default function MotivosIncidenteLayout({ children }: { children: ReactNode }) {
  return (
    <RequirePerm bit={PERM.pedido.read} redirectTo="/inicio">
      {children}
    </RequirePerm>
  );
}
