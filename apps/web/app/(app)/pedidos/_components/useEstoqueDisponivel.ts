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
  return data.reduce((sum, row) => sum + estoqueDisponivel(row.data), 0);
}
