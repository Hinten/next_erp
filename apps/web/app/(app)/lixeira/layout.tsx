'use client';

import type { ReactNode } from 'react';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';

/**
 * The recovery view requires the lixeira.read permission. Restoring a record
 * writes back to its original collection — that write is still gated by
 * Firestore rules; this layout only keeps the UI from rendering for users who
 * can't see deleted items at all.
 */
export default function LixeiraLayout({ children }: { children: ReactNode }) {
  return (
    <RequirePerm bit={PERM.lixeira.read} redirectTo="/inicio">
      {children}
    </RequirePerm>
  );
}
