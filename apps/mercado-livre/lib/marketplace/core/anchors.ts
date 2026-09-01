/**
 * Resolve a hand-picked selection of produtos to their family ANCHORS.
 *
 * Every produto-scoped bulk operation on this channel starts here: the operator
 * checks rows in the produtos table, and what those rows name may be a family
 * anchor or a variation CHILD, while the link documents the operation acts on
 * hang off the anchor. Three callers today — the manual stock push
 * (`estoque/estoqueManual.ts`), the manual price push (`preco/precoManual.ts`)
 * and the listing status action (`anuncios/anuncioStatus.ts`) — so it lives in
 * `core/` rather than in whichever one happened to need it first.
 *
 * Operation-neutral by construction: no depósito, no quantity, no listing.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { produtoCollection } from '@delfrance/data/admin/collections';

export interface AnchorsResolvidos {
  /** Anchor ids, deduped, in first-seen request order. */
  anchorIds: string[];
  /** Requested produto id → the anchor it resolved to (outcome attribution). */
  anchorPorProdutoId: Map<string, string>;
  /** Anchor id → the best `nome` we saw for it (report labels). */
  nomePorProdutoId: Map<string, string>;
  /** Requested ids with no produto document. */
  naoEncontrados: string[];
}

/**
 * Resolve each selected produto to its family ANCHOR, one masked point read each.
 *
 * Not folded into a pipeline, for a decisive reason: `documents([...])`
 * **silently omits a missing document**, so a pipeline alone cannot tell
 * "produto does not exist" from "produto exists but is not an anchor" — and the
 * per-listing report needs both. It is also emulator-runnable, so half of each
 * caller's tests need no pipeline mock.
 *
 * Exactly ONE hop. A 2-deep `paiId` chain is pathological; it simply comes back
 * with no family row and the caller reports it.
 */
export async function resolverAnchors(
  db: Firestore,
  produtoIds: readonly string[],
): Promise<AnchorsResolvidos> {
  const pedidos = [...new Set(produtoIds)];
  const snaps = await db.getAll(...pedidos.map((id) => produtoCollection.docRef(db, {}, id)), {
    fieldMask: ['paiId', 'nome'],
  });

  const anchorIds: string[] = [];
  const vistos = new Set<string>();
  const anchorPorProdutoId = new Map<string, string>();
  const nomePorProdutoId = new Map<string, string>();
  const naoEncontrados: string[] = [];

  snaps.forEach((snap, i) => {
    const produtoId = pedidos[i]!;
    if (!snap.exists) {
      naoEncontrados.push(produtoId);
      return;
    }
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    if (typeof data.nome === 'string' && data.nome !== '') {
      nomePorProdutoId.set(produtoId, data.nome);
    }
    const paiId = typeof data.paiId === 'string' && data.paiId !== '' ? data.paiId : null;
    const anchorId = paiId ?? produtoId;
    anchorPorProdutoId.set(produtoId, anchorId);
    if (!vistos.has(anchorId)) {
      vistos.add(anchorId);
      anchorIds.push(anchorId);
    }
  });

  return { anchorIds, anchorPorProdutoId, nomePorProdutoId, naoEncontrados };
}
