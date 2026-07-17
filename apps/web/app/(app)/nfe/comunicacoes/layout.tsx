'use client';

import type { ReactNode } from 'react';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';

/**
 * /nfe/comunicacoes lists the `filiais/{filialId}/enviNfe` audit log, which is
 * fiscal data — so this segment is gated by fiscal.read, unlike the sibling
 * `(nfe)` group (nfe.read). Writes are gated separately by Firestore rules and
 * the apps/nfe verify route (fiscal.write).
 */
export default function ComunicacoesNfeLayout({ children }: { children: ReactNode }) {
  return (
    <RequirePerm bit={PERM.fiscal.read} redirectTo="/inicio">
      {children}
    </RequirePerm>
  );
}
