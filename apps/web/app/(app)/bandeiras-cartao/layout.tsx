'use client';

import type { ReactNode } from 'react';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';

/**
 * Bandeiras de cartão pertencem ao domínio de pagamentos. Writes seguem
 * protegidos separadamente pelas Firestore rules.
 */
export default function BandeirasCartaoLayout({ children }: { children: ReactNode }) {
  return (
    <RequirePerm bit={PERM.pagamento.read} redirectTo="/inicio">
      {children}
    </RequirePerm>
  );
}
