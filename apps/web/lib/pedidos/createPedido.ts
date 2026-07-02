import { runTransaction, type Firestore } from 'firebase/firestore';
import type { Pedido } from '@delfrance/schemas';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { counterCollection } from '@/lib/data/counterCollection';
import { newDocId } from '@/lib/data/newDocId';

/**
 * Fixed width of the zero-padded pedido `numero` (e.g. `42` → `"000042"`).
 * `numero` is stored as a string and is the default list sort key
 * (`pedidoMeta.defaultQuery` orders by `numero` desc, a lexical sort), so a
 * fixed width keeps newly created pedidos ordered correctly.
 */
export const PEDIDO_NUMERO_WIDTH = 6;

/** Doc id of the global pedido sequence in the `counters` collection. */
export const PEDIDO_COUNTER_DOC_ID = 'pedido';

/** Zero-pad an allocated sequence value to the fixed `numero` width. */
export function formatPedidoNumero(value: number): string {
  return String(value).padStart(PEDIDO_NUMERO_WIDTH, '0');
}

/**
 * Create a pedido with an auto-assigned, human-readable, unique `numero`.
 *
 * The pedido id is minted client-side (`newDocId`) so the counter bump and the
 * pedido write share a single `runTransaction`: read the global counter doc,
 * increment it, and write both the counter and the pedido atomically. This is
 * the browser equivalent of the NF-e numeração counter
 * (`packages/integrations/nfe/src/numeracao/`) — gap-free and unique even under
 * concurrent creates, at the minimum cost of one extra read + one extra write.
 *
 * The transaction retries automatically on contention; if it ultimately fails
 * it throws, so a pedido is never created without a `numero`.
 *
 * @returns the new pedido's Firestore doc id.
 */
export async function createPedidoWithNumero(db: Firestore, values: Pedido): Promise<string> {
  const pedidoId = newDocId();
  await runTransaction(db, async (tx) => {
    const counterRef = counterCollection.docRef(db, {}, PEDIDO_COUNTER_DOC_ID);
    // Reads must precede writes in a Firestore transaction.
    const snap = await tx.get(counterRef);
    const current = snap.exists() ? (snap.data()?.value ?? 0) : 0;
    const next = current + 1;
    tx.set(counterRef, { value: next });
    tx.set(pedidoCollection.docRef(db, {}, pedidoId), {
      ...values,
      numero: formatPedidoNumero(next),
    });
  });
  return pedidoId;
}
