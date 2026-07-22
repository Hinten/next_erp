'use client';

import { Suspense } from 'react';
import { Stack } from '@mantine/core';
import { PageHeader } from '@delfrance/ui';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';
import { RecalcularPrecosScreen } from './_components/RecalcularPrecosScreen';

/**
 * Bulk price recalculation (#544) — port of the Flutter
 * `alterarPrecoMassa2.dart` / `recalcularPrecos.dart` screens. Loads every
 * parent produto, recomputes its price from the target lista de preços'
 * fórmulas, and applies the result in one of three modes. Gated on
 * `produto.write` (this writes every parent's `precos` map) — read-only
 * catalog browsing already happens under `produto.read` at the layout level.
 *
 * `RecalcularPrecosScreen` reads `?listaId=` (deep-link preselect from the
 * "Preços em massa" menu on `/produtos`), which requires a Suspense boundary
 * around any `useSearchParams` consumer in Next 16.
 */
export default function RecalcularPrecosPage() {
  return (
    <RequirePerm bit={PERM.produto.write} redirectTo="/produtos">
      <Stack>
        <PageHeader
          title="Recalcular Preços"
          description="Recalcula os preços dos produtos a partir das fórmulas de uma lista de preços"
        />
        <Suspense fallback={null}>
          <RecalcularPrecosScreen />
        </Suspense>
      </Stack>
    </RequirePerm>
  );
}
