import {
  type DocumentReference,
  type Firestore,
  runTransaction,
  writeBatch,
} from 'firebase/firestore';
import { nowMicros } from '@delfrance/core/datetime';
import type { PedidoDataPort, PedidoWriteOp } from '@delfrance/data/pedido';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { historicoEstadoCollection } from '@/lib/data/historicoEstadoCollection';
import { incidenteCollection } from '@/lib/data/incidenteCollection';
import { pagamentoCollection } from '@/lib/data/pagamentoCollection';
import { newDocId } from '@/lib/data/newDocId';

// A writeBatch caps at 500 operations.
const BATCH_LIMIT = 499;

/**
 * Resolve a {@link PedidoWriteOp} path to a converter-bound `defineCollection`
 * handle ref — apps/web bans raw `doc()`/`collection()` (they skip the Zod
 * converter), so the adapter maps the finite pedido subcollection paths to their
 * handles. New subcollections (incidentes, pagamentos) add a case here as their
 * tab lands.
 */
function refForPath(db: Firestore, path: string): DocumentReference {
  const parts = path.split('/');
  if (parts.length === 4 && parts[0] === 'pedidos') {
    const [, pedidoId, sub, id] = parts as [string, string, string, string];
    if (sub === 'historicoEstadoPedido') {
      return historicoEstadoCollection.docRef(db, { pedidoId }, id) as DocumentReference;
    }
    if (sub === 'incidentes') {
      return incidenteCollection.docRef(db, { pedidoId }, id) as DocumentReference;
    }
    if (sub === 'pagamentos') {
      return pagamentoCollection.docRef(db, { pedidoId }, id) as DocumentReference;
    }
  }
  throw new Error(`clientPedidoPort: unmapped write path "${path}"`);
}

/**
 * The client-SDK adapter for the pedido {@link PedidoDataPort}
 * (`@delfrance/data/pedido`). All partial-save + concurrency-guard logic lives in
 * the framework-agnostic use-cases; this only bridges them to the Firebase JS SDK
 * through the converter-bound collection handles. Mirrors `lib/produtos/clientPort.ts`.
 */
export function createClientPedidoPort(db: Firestore): PedidoDataPort {
  return {
    // datetime fields (`ultimaModificacao`, history `data`) are µs epoch.
    now: () => nowMicros(),
    newId: () => newDocId(),

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

    async commit(ops: PedidoWriteOp[]) {
      for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
        const batch = writeBatch(db);
        for (const op of ops.slice(i, i + BATCH_LIMIT)) {
          const ref = refForPath(db, op.path);
          if (op.type === 'set') batch.set(ref, op.data as never);
          else if (op.type === 'update') batch.update(ref, op.data as never);
          else batch.delete(ref);
        }
        await batch.commit();
      }
    },
  };
}
