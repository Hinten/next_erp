'use client';

import type { QueryClient } from '@tanstack/react-query';
import { getDocFromServer, type Firestore } from 'firebase/firestore';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { normalizeProdutoId, type ProdutoPesoInfo } from './pesoPedido';

export type ProdutoPesoMap = Record<string, ProdutoPesoInfo | null>;

/**
 * `null` means "read succeeded, the produto doesn't exist" — the only case
 * `pesoPedido` should treat as unresolvable. A real read failure (offline,
 * `permission-denied`, backend unavailable, …) is NOT converted to `null`
 * here: it propagates and fails the batch, so a transient/permission error
 * can never masquerade as "produto missing" and lock in a wrong 1kg-per-unit
 * default (the earlier version swallowed every `FirebaseError` into `null` —
 * flagged in review on #1093).
 */
async function fetchProdutoPeso(db: Firestore, id: string): Promise<ProdutoPesoInfo | null> {
  const snap = await getDocFromServer(produtoCollection.docRef(db, {}, id));
  const data = snap.data();
  if (!data) return null;
  return { pesoBrutoKg: data.pesoBrutoKg, pesoLiquidoKg: data.pesoLiquidoKg, paiId: data.paiId };
}

/**
 * The distinct, **normalized**, sorted produto ids behind a pedido's items —
 * the weight query's identity. Legacy `produtoUid` values can be a full path
 * (see {@link normalizeProdutoId}), so normalizing here keeps two spellings of
 * the same produto on one cache entry instead of two.
 */
export function produtoPesoIds(produtoUids: readonly (string | null | undefined)[]): string[] {
  return [
    ...new Set(produtoUids.map(normalizeProdutoId).filter((id): id is string => id != null)),
  ].sort();
}

/**
 * Two-wave batched weight lookup: every produto, then — for any whose own
 * weights are BOTH null/0 and which carries a `paiId` — its parent too, so
 * `pesoPedido`'s variation→parent fallback resolves from the same map without
 * a second round-trip from the caller.
 */
export async function fetchProdutoPesoMap(
  db: Firestore,
  ids: readonly string[],
): Promise<ProdutoPesoMap> {
  const byId: ProdutoPesoMap = {};
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
}

/**
 * The pedido's produto weights as ONE shared cache entry, fetched on demand by
 * whichever caller needs it first — the activation seed
 * (`seedVolumePadrao`) or `VolumesEditor`'s "+ Novo volume" button — and
 * reused by the other within the client's `staleTime`.
 *
 * Deliberately **not** a hook: nothing is fetched speculatively on mount. The
 * previous shape ran a read per produto every time the Frete tab opened, even
 * when volumes already existed and the weight was never used — wasted reads on
 * an Enterprise database that bills data scanned.
 *
 * Not realtime: the weight is only needed once, at the moment a volume is
 * built. Read failures reject — callers decide whether to warn or fall back.
 */
export function loadProdutoPesoMap(
  queryClient: QueryClient,
  db: Firestore,
  produtoUids: readonly (string | null | undefined)[],
): Promise<ProdutoPesoMap> {
  const ids = produtoPesoIds(produtoUids);
  return queryClient.fetchQuery({
    queryKey: ['pedido-frete-peso', ids],
    queryFn: () => fetchProdutoPesoMap(db, ids),
  });
}
