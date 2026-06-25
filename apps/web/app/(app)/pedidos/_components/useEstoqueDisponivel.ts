'use client';

import { useMemo } from 'react';
import { type Firestore } from 'firebase/firestore';
import { buildQuery } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { estoqueDisponivel } from '@delfrance/schemas';
import { estoqueProdutoCollection } from '@/lib/data/estoqueProdutoCollection';

/**
 * Total available stock (Σ `quantidade − quantidadeReservada`) across a
 * produto's depósitos, live. Returns `null` while loading or when `produtoId`
 * is null (no produto picked yet).
 */
export function useEstoqueDisponivel(db: Firestore, produtoId: string | null): number | null {
  const query = useMemo(
    () => (produtoId ? buildQuery(estoqueProdutoCollection.ref(db, { produtoId }), []) : null),
    [db, produtoId],
  );
  const { data } = useSnapshot(query);
  if (!data) return null;
  // Reads soft-parse (see `parseSoftRead`): a malformed estoque doc can return
  // raw data with a non-numeric quantidade, making `estoqueDisponivel` NaN.
  // Skip such rows so the badge never shows NaN.
  return data.reduce((sum, row) => {
    const disp = estoqueDisponivel(row.data);
    return Number.isFinite(disp) ? sum + disp : sum;
  }, 0);
}
