'use client';

import type { QueryClient } from '@tanstack/react-query';
import type { Firestore } from 'firebase/firestore';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { getDocsByIds } from '@/lib/data/getDocsByIds';
import { normalizeProdutoId, type ProdutoMedidas } from './pesoPedido';

export type ProdutoPesoMap = Record<string, ProdutoMedidas | null>;

/**
 * Project the produto fields the freight estimators need — weight AND the
 * three dimensions. Absent from the fetched
 * map = "read succeeded, the produto doesn't exist" → `null`, the only case
 * `pesoPedido` treats as unresolvable. A real read failure (offline,
 * `permission-denied`, backend unavailable, …) rejects rather than becoming
 * `null`, so a transient error can never masquerade as "produto missing" and
 * lock in a wrong 1kg-per-unit default (flagged in review on #1093). That
 * holds only because both waves pass `{ source: 'server' }` — see the note at
 * the call sites below.
 */
function toPesoInfo(produtos: Map<string, ProdutoMedidas>, id: string): ProdutoMedidas | null {
  const p = produtos.get(id);
  if (!p) return null;
  return {
    pesoBrutoKg: p.pesoBrutoKg,
    pesoLiquidoKg: p.pesoLiquidoKg,
    alturaCm: p.alturaCm,
    larguraCm: p.larguraCm,
    profundidadeCm: p.profundidadeCm,
    paiId: p.paiId,
  };
}

/** A produto that cannot supply its own weight — `pesoPedido` needs the parent. */
const semPesoProprio = (p: ProdutoMedidas) =>
  (p.pesoBrutoKg ?? 0) === 0 && (p.pesoLiquidoKg ?? 0) === 0;

/**
 * A produto that cannot supply its own box — `dimensoesPedido` needs the
 * parent. Any missing or non-positive axis disqualifies the whole set, because
 * a box needs all three.
 */
const semCaixaPropria = (p: ProdutoMedidas) =>
  !((p.alturaCm ?? 0) > 0 && (p.larguraCm ?? 0) > 0 && (p.profundidadeCm ?? 0) > 0);

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
 * Two-wave batched lookup: every produto, then — for any variation that can
 * supply neither its own weight nor its own box — its parent too, so both
 * `pesoPedido`'s and `dimensoesPedido`'s variation→parent fallbacks resolve
 * from the same map without a second round-trip from the caller.
 */
export async function fetchProdutoPesoMap(
  db: Firestore,
  ids: readonly string[],
): Promise<ProdutoPesoMap> {
  const byId: ProdutoPesoMap = {};

  // Wave 1: the pedido's own produtos. Same batched loader the checkout screen
  // uses (`loadPedidoCheckout`): chunked 30-id `in` queries instead of one
  // `getDoc` per produto — on a large pedido ~34 queries rather than ~1000 reads.
  //
  // `source: 'server'` is load-bearing, not a default. Plain `getDocs` falls
  // back to the local cache when the server is unreachable, and an id the cache
  // has never seen then comes back missing — which `toPesoInfo` cannot tell
  // apart from a produto that truly does not exist. That would quietly hand
  // `pesoPedido` its 1kg-per-unit fallback and PERSIST it in a seeded Volume.
  // Forcing the server means an offline/transient failure rejects instead.
  const wave1 = await getDocsByIds(db, produtoCollection, ids, {}, { source: 'server' });
  for (const id of ids) byId[id] = toPesoInfo(wave1, id);

  // Wave 2: the parents of variations that can supply neither their own weight
  // NOR their own box, so both fallbacks resolve from this same map.
  //
  // ⚠️ The dimension half of the predicate is load-bearing: a variation very
  // commonly carries a weight but no dimensions, and gating this wave on the
  // weight alone would leave `dimensoesPedido` with no parent to fall back to —
  // silently costing the pedido its real box.
  const paiIds = [
    ...new Set(
      Object.values(byId)
        .filter((p): p is ProdutoMedidas => p != null)
        .filter((p) => p.paiId != null && (semPesoProprio(p) || semCaixaPropria(p)))
        .map((p) => p.paiId as string),
    ),
  ].filter((id) => !(id in byId));
  if (paiIds.length > 0) {
    const wave2 = await getDocsByIds(db, produtoCollection, paiIds, {}, { source: 'server' });
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
