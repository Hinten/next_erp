'use client';

import { useQuery } from '@tanstack/react-query';
import { getDocFromServer, type Firestore } from 'firebase/firestore';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { normalizeProdutoId, type ProdutoPesoInfo } from './pesoPedido';

/**
 * `null` means "read succeeded, the produto doesn't exist" — the only case
 * `pesoPedido` should treat as unresolvable. A real read failure (offline,
 * `permission-denied`, backend unavailable, …) is NOT converted to `null`
 * here: it propagates and fails the batch, so a transient/permission error
 * can never masquerade as "produto missing" and lock in a wrong 1kg-per-unit
 * default (the earlier version of this hook swallowed every `FirebaseError`
 * into `null` — flagged in review on #1093 as conflating those two cases).
 */
async function fetchProdutoPeso(db: Firestore, id: string): Promise<ProdutoPesoInfo | null> {
  const snap = await getDocFromServer(produtoCollection.docRef(db, {}, id));
  const data = snap.data();
  if (!data) return null;
  return { pesoBrutoKg: data.pesoBrutoKg, pesoLiquidoKg: data.pesoLiquidoKg, paiId: data.paiId };
}

/**
 * Batched, one-shot produto weight lookup backing the Frete tab's "+ Novo
 * volume" smart default (`pesoPedido`, issue #371). Fetches every distinct,
 * **normalized** produto id (see {@link normalizeProdutoId} — legacy
 * `produtoUid` values can be a full path), then — for any produto whose own
 * weights are BOTH null/0 and carries a `paiId` — also fetches the parent, so
 * `pesoPedido`'s variation→parent fallback can resolve from the same map
 * without a second round-trip from the caller.
 *
 * Not realtime: the default only needs the weight once, right before a
 * volume is added. Returns `undefined` while the batch is in flight
 * (including the initial "0 ids" case, which resolves to `{}` immediately)
 * so callers can gate on "still loading" vs. "resolved, nothing found".
 */
export function useProdutoPesoMap(
  db: Firestore,
  produtoUids: readonly string[],
): Record<string, ProdutoPesoInfo | null> | undefined {
  const ids = [
    ...new Set(produtoUids.map(normalizeProdutoId).filter((id): id is string => id != null)),
  ].sort();
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
