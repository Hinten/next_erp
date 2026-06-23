import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import { estoqueCollection, historicoEstoqueCollection } from '@delfrance/data/admin/collections';

// A Firestore batch caps at 500 ops; stay safely under it.
const CHUNK = 400;

/** Delete a list of refs in bounded batches (no reads — `listDocuments` only). */
async function deleteRefsInChunks(db: Firestore, refs: DocumentReference[]): Promise<void> {
  for (let i = 0; i < refs.length; i += CHUNK) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + CHUNK)) batch.delete(ref);
    await batch.commit();
  }
}

/**
 * Sweep one estoque's `historicoEstoque` subcollection (Firestore never cascades
 * subcollections). Uses `listDocuments` so it also reaches records under a
 * phantom estoque parent (a doc deleted while its subcollection lingered).
 * Idempotent — returns 0 when there is nothing to sweep. Returns the count
 * deleted for logging.
 */
export async function deleteHistoricoEstoque(
  db: Firestore,
  produtoId: string,
  estoqueId: string,
): Promise<number> {
  const refs = await historicoEstoqueCollection.ref(db, { produtoId, estoqueId }).listDocuments();
  await deleteRefsInChunks(db, refs);
  return refs.length;
}

/** What {@link sweepProdutoEstoques} removed, for the trigger's summary log. */
export interface ProdutoEstoqueSweep {
  estoques: number;
  historico: number;
}

/**
 * Cascade a produto's full estoque subtree: every `estoques` doc plus each one's
 * nested `historicoEstoque`. Does the whole cascade directly (it does not rely on
 * `onEstoqueDeleted` re-firing for the estoque docs it deletes — that re-fire is
 * an idempotent no-op since the history is already gone). Idempotent and tolerant
 * of an empty/absent subtree.
 */
export async function sweepProdutoEstoques(
  db: Firestore,
  produtoId: string,
): Promise<ProdutoEstoqueSweep> {
  const estoqueRefs = await estoqueCollection.ref(db, { produtoId }).listDocuments();
  let historico = 0;
  for (const estoqueRef of estoqueRefs) {
    historico += await deleteHistoricoEstoque(db, produtoId, estoqueRef.id);
  }
  await deleteRefsInChunks(db, estoqueRefs);
  return { estoques: estoqueRefs.length, historico };
}
