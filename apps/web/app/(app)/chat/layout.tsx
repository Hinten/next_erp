'use client';

import type { ReactNode } from 'react';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';

export default function ChatLayout({ children }: { children: ReactNode }) {
  return (
    <RequirePerm bit={PERM.chat.read} redirectTo="/inicio">
      {children}
    </RequirePerm>
  );
}
