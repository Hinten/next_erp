import {
  getDoc,
  getDocs,
  runTransaction,
  writeBatch,
  type DocumentReference,
  type Firestore,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { nowMicros } from '@delfrance/core/datetime';
import { buildQuery, limit, whereEqual } from '@delfrance/data';
import type { PedidoDevolucaoDataPort, PedidoDocData, PedidoWriteOp } from '@delfrance/data/pedido';
import { ESTADO_NFE, TIPO_NFE, type EstadoPedido } from '@delfrance/schemas';
import { getFirebaseFunctions } from '@/lib/firebase/client';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { counterCollection } from '@/lib/data/counterCollection';
import { incidenteCollection } from '@/lib/data/incidenteCollection';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { nfeCollection } from '@/lib/data/nfeCollection';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
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
  if (parts.length === 2) {
    const [col, id] = parts as [string, string];
    if (col === 'pedidos') {
      return pedidoCollection.docRef(db, {}, id) as DocumentReference;
    }
    if (col === 'counters') {
      return counterCollection.docRef(db, {}, id) as DocumentReference;
    }
  }
  if (parts.length === 4 && parts[0] === 'pedidos') {
    const [, pedidoId, sub, id] = parts as [string, string, string, string];
    // NOTE: `historicoEstadoPedido` is deliberately absent. That subcollection is
    // written exclusively by the `onPedidoChanged` Cloud Function and the
    // rules deny every client write (`meta.serverOwned`), so there is no write op
    // to resolve — the Estado/Histórico tab only READS it, via its own handle.
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
 * Invoke the server-owned `reconciliarPagamentoPedido` callable (apps/functions)
 * to re-derive a pedido's `estado` from its pagamentos (#308). The client SDK
 * cannot read a query inside `runTransaction`, so the payment sum had to be taken
 * BEFORE the transaction and was never one atomic snapshot with the pedido total
 * — concurrent reconciles (two tabs, two sessions) settled on a stale `estado`.
 * The callable's Admin-SDK transaction reads the pedido AND every pagamento
 * together. No explicit timeout: the 70s callable default absorbs a gen2 cold
 * start. Failures arrive as a `FirebaseError` (FunctionsError) the callers narrow
 * on.
 */
export function callReconciliarPagamentoPedido(
  pedidoId: string,
): Promise<{ transition: EstadoPedido | null }> {
  const fn = httpsCallable<{ pedidoId: string }, { transition: EstadoPedido | null }>(
    getFirebaseFunctions(),
    'reconciliarPagamentoPedido',
  );
  return fn({ pedidoId }).then((res) => res.data);
}

/**
 * The client-SDK adapter for the pedido {@link PedidoDevolucaoDataPort}
 * (`@delfrance/data/pedido`). All partial-save + concurrency-guard + devolução
 * logic lives in the framework-agnostic use-cases; this only bridges them to the
 * Firebase JS SDK through the converter-bound collection handles. Mirrors
 * `lib/produtos/clientPort.ts`.
 */
export function createClientPedidoPort(db: Firestore): PedidoDevolucaoDataPort {
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
        // An empty patch means `apply` decided there's nothing to write — skip the
        // no-op update. Unreachable via today's only caller (`savePedido` throws
        // `PedidoNothingChangedError` first), kept because the port contract allows it.
        if (Object.keys(patch).length === 0) return;
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

    async transact({ reads, apply }) {
      await runTransaction(db, async (tx) => {
        // Every tx.get must precede the first write (Firestore JS SDK rule), so
        // all reads happen up front — concurrently, building the path-keyed map.
        const paths = [...new Set(reads)];
        const snaps = await Promise.all(paths.map((path) => tx.get(refForPath(db, path))));
        const docs = new Map<string, PedidoDocData>();
        paths.forEach((path, i) => {
          const snap = snaps[i]!;
          docs.set(path, snap.exists() ? (snap.data() as Record<string, unknown>) : null);
        });
        for (const op of apply(docs)) {
          const ref = refForPath(db, op.path);
          // tx.set goes through the converter (validates + fills defaults);
          // tx.update bypasses it — the patch is already resolved wire shape.
          if (op.type === 'set') tx.set(ref, op.data as never);
          else if (op.type === 'update') tx.update(ref, op.data as never);
          else tx.delete(ref);
        }
      });
    },

    async getPedido(pedidoId) {
      const snap = await getDoc(pedidoCollection.docRef(db, {}, pedidoId));
      return snap.exists() ? (snap.data() as Record<string, unknown>) : null;
    },

    async getIntegracao(integracaoId) {
      const snap = await getDoc(integracaoCollection.docRef(db, {}, integracaoId));
      return snap.exists() ? (snap.data() as Record<string, unknown>) : null;
    },

    async getOperacao(operacaoId) {
      const snap = await getDoc(operacaoCollection.docRef(db, {}, operacaoId));
      return snap.exists() ? (snap.data() as Record<string, unknown>) : null;
    },

    async findOperacaoEntradaPadrao() {
      const snap = await getDocs(
        buildQuery(operacaoCollection.ref(db, {}), [
          whereEqual('tipo', TIPO_NFE.entrada),
          whereEqual('ativo', true),
        ]),
      );
      const rows = snap.docs.map((d) => ({
        id: d.id,
        data: d.data() as unknown as Record<string, unknown>,
      }));
      return rows.find((r) => r.data.padrao === true) ?? rows[0] ?? null;
    },

    async listNFesAprovadas(pedidoId) {
      const snap = await getDocs(
        buildQuery(nfeCollection.ref(db, { pedidoId }), [
          whereEqual('estado', ESTADO_NFE.aprovada),
        ]),
      );
      return snap.docs.map((d) => d.data() as unknown as Record<string, unknown>);
    },

    async hasNFe(pedidoId) {
      const snap = await getDocs(buildQuery(nfeCollection.ref(db, { pedidoId }), [limit(1)]));
      return !snap.empty;
    },
  };
}
