'use client';

// Dropzone styles are global CSS; the app router wants them in a layout, not a
// leaf component. Scoped here to the product routes (used by PhotoManager).
import '@mantine/dropzone/styles.css';
import type { ReactNode } from 'react';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';

export default function ProdutosLayout({ children }: { children: ReactNode }) {
  return (
    <RequirePerm bit={PERM.produto.read} redirectTo="/inicio">
      {children}
    </RequirePerm>
  );
}
