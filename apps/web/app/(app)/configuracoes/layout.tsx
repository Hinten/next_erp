'use client';

import type { ReactNode } from 'react';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';

/**
 * All routes under /configuracoes require the configuracoes.read permission.
 * Writes are gated separately at button level and (eventually) by Firestore
 * rules; this layout protects the UI from rendering for users who can't see
 * settings at all.
 */
export default function ConfiguracoesLayout({ children }: { children: ReactNode }) {
  return (
    <RequirePerm bit={PERM.configuracoes.read} redirectTo="/inicio">
      {children}
    </RequirePerm>
  );
}
