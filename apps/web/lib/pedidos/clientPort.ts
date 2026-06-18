import { type Firestore, runTransaction } from 'firebase/firestore';
import { nowMicros } from '@delfrance/core/datetime';
import type { PedidoDataPort } from '@delfrance/data/pedido';
import { pedidoCollection } from '@/lib/data/pedidoCollection';

/**
 * The client-SDK adapter for the pedido {@link PedidoDataPort}
 * (`@delfrance/data/pedido`). All partial-save + concurrency-guard logic lives
 * in the framework-agnostic use-cases; this only bridges the transactional
 * read-modify-write to the Firebase JS SDK through the converter-bound pedido
 * collection handle. Mirrors `lib/produtos/clientPort.ts`.
 */
export function createClientPedidoPort(db: Firestore): PedidoDataPort {
  return {
    // `ultimaModificacao` is a `microsSinceEpoch()` field — stamp in µs.
    now: () => nowMicros(),

    async updatePedido(pedidoId, apply) {
      const ref = pedidoCollection.docRef(db, {}, pedidoId);
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const current = snap.exists() ? (snap.data() as Record<string, unknown>) : null;
        const patch = apply(current);
        // tx.update bypasses the converter (only set/add invoke it); the patch
        // already passed the per-field resolver client-side.
        tx.update(ref, patch as never);
      });
    },
  };
}
