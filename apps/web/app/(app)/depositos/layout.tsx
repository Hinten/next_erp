'use client';

import type { ReactNode } from 'react';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';

/**
 * All routes under /depositos require the estoque.read permission. Writes
 * are gated separately by Firestore rules; this layout keeps the UI from
 * rendering for users who can't even see the data.
 */
export default function DepositosLayout({ children }: { children: ReactNode }) {
  return (
    <RequirePerm bit={PERM.estoque.read} redirectTo="/inicio">
      {children}
    </RequirePerm>
  );
}
