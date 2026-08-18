'use client';

import { useQuery } from '@tanstack/react-query';
import { getDocFromServer, type Firestore } from 'firebase/firestore';
import { FirebaseError } from 'firebase/app';
import { produtoCollection } from '@/lib/data/produtoCollection';
import type { ProdutoPesoInfo } from './pesoPedido';

async function fetchProdutoPeso(db: Firestore, id: string): Promise<ProdutoPesoInfo | null> {
  try {
    const snap = await getDocFromServer(produtoCollection.docRef(db, {}, id));
    const data = snap.data();
    if (!data) return null;
    return { pesoBrutoKg: data.pesoBrutoKg, pesoLiquidoKg: data.pesoLiquidoKg, paiId: data.paiId };
  } catch (err) {
    // A per-produto read failure must not sink the whole batch — treat it as
    // "unresolvable" so `pesoPedido` falls back to its 1kg-per-unit default.
    if (!(err instanceof FirebaseError)) throw err;
    return null;
  }
}

/**
 * Batched, one-shot produto weight lookup for the Frete tab's auto-weight
 * seed (`pesoPedido`, issue #371). Fetches every distinct produto id, then —
 * for any produto whose own weights are BOTH null/0 and carries a `paiId` —
 * also fetches the parent, so `pesoPedido`'s variation→parent fallback can
 * resolve from the same map without a second round-trip from the caller.
 *
 * Not realtime: the seed only needs the weight once, at the moment it fires.
 * Returns `undefined` while the batch is in flight (including the initial
 * "0 ids" case, which resolves to `{}` immediately) so callers can gate on
 * "still loading" vs. "resolved, nothing found".
 */
export function useProdutoPesoMap(
  db: Firestore,
  produtoUids: readonly string[],
): Record<string, ProdutoPesoInfo | null> | undefined {
  const ids = [...new Set(produtoUids)].sort();
  const { data } = useQuery({
    queryKey: ['pedido-frete-peso', ids],
    queryFn: async () => {
      const byId: Record<string, ProdutoPesoInfo | null> = {};
      await Promise.all(
        ids.map(async (id) => {
          byId[id] = await fetchProdutoPeso(db, id);
        }),
      );
      const paiIds = [
        ...new Set(
          Object.values(byId)
            .filter((p): p is ProdutoPesoInfo => p != null)
            .filter(
              (p) => (p.pesoBrutoKg ?? 0) === 0 && (p.pesoLiquidoKg ?? 0) === 0 && p.paiId != null,
            )
            .map((p) => p.paiId as string),
        ),
      ].filter((id) => !(id in byId));
      await Promise.all(
        paiIds.map(async (id) => {
          byId[id] = await fetchProdutoPeso(db, id);
        }),
      );
      return byId;
    },
  });
  return data;
}
