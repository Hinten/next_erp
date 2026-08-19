'use client';

import type { QueryClient } from '@tanstack/react-query';
import type { Firestore } from 'firebase/firestore';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { getDocsByIds } from '@/lib/data/getDocsByIds';
import { normalizeProdutoId, type ProdutoPesoInfo } from './pesoPedido';

export type ProdutoPesoMap = Record<string, ProdutoPesoInfo | null>;

/**
 * Project the produto fields the weight math needs. Absent from the fetched
 * map = "read succeeded, the produto doesn't exist" → `null`, the only case
 * `pesoPedido` treats as unresolvable. A real read failure (offline,
 * `permission-denied`, backend unavailable, …) rejects out of `getDocsByIds`
 * rather than becoming `null`, so a transient error can never masquerade as
 * "produto missing" and lock in a wrong 1kg-per-unit default (flagged in
 * review on #1093).
 */
function toPesoInfo(
  produtos: Map<
    string,
    { pesoBrutoKg: number | null; pesoLiquidoKg: number | null; paiId: string | null }
  >,
  id: string,
): ProdutoPesoInfo | null {
  const p = produtos.get(id);
  if (!p) return null;
  return { pesoBrutoKg: p.pesoBrutoKg, pesoLiquidoKg: p.pesoLiquidoKg, paiId: p.paiId };
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

  // Wave 1: the pedido's own produtos. Same batched loader the checkout screen
  // uses (`loadPedidoCheckout`): chunked 30-id `in` queries instead of one
  // `getDoc` per produto, which on a large pedido is ~34 queries rather than
  // ~1000 reads — and it reads through the local cache.
  const wave1 = await getDocsByIds(db, produtoCollection, ids);
  for (const id of ids) byId[id] = toPesoInfo(wave1, id);

  // Wave 2: the parents of zero-weight variations, so `pesoPedido`'s
  // variation→parent fallback resolves from this same map.
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
  if (paiIds.length > 0) {
    const wave2 = await getDocsByIds(db, produtoCollection, paiIds);
    for (const id of paiIds) byId[id] = toPesoInfo(wave2, id);
  }

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
