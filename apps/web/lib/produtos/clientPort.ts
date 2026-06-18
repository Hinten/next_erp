import {
  type DocumentReference,
  type Firestore,
  getDocsFromServer,
  writeBatch,
} from 'firebase/firestore';
import { buildQuery, limit, whereArrayContains, whereEqual } from '@delfrance/data';
import type { ProdutoDataPort, ProdutoSnapshot, ProdutoWriteOp } from '@delfrance/data/produto';
import { produtoCollection } from '@/lib/data/produtoCollection';
import {
  historicoCustoCollection,
  historicoPrecoCollection,
} from '@/lib/data/historicoCollections';
import { produtoExtraDataCollection } from '@/lib/data/produtoExtraDataCollection';
import { PRODUTO_MARKETPLACE_SUBCOLLECTIONS } from '@/lib/data/produtoMarketplaceSubcollections';
import { newDocId } from './docId';

// A writeBatch caps at 500 operations.
const BATCH_LIMIT = 499;

const subcollectionHandles = new Map(
  PRODUTO_MARKETPLACE_SUBCOLLECTIONS.map((s) => [s.name, s.handle] as const),
);

/**
 * Resolve a domain `ProdutoWriteOp.path` to a converter-bound `defineCollection`
 * handle ref — apps/web bans raw `doc()`/`collection()` (they skip the Zod
 * converter), so the dumb adapter maps the finite produto path patterns to
 * their handles. New produto subcollections (extraData, estoques, imposto) add
 * a case here when their tab lands.
 */
function refForPath(db: Firestore, path: string): DocumentReference {
  const parts = path.split('/');
  if (parts.length === 2 && parts[0] === 'produtos') {
    return produtoCollection.docRef(db, {}, parts[1]!) as DocumentReference;
  }
  if (parts.length === 4 && parts[0] === 'produtos') {
    const [, produtoId, sub, id] = parts as [string, string, string, string];
    if (sub === 'historicoDePrecos') {
      return historicoPrecoCollection.docRef(db, { produtoId }, id) as DocumentReference;
    }
    if (sub === 'historicoDeCusto') {
      return historicoCustoCollection.docRef(db, { produtoId }, id) as DocumentReference;
    }
    if (sub === 'extraData') {
      return produtoExtraDataCollection.docRef(db, { produtoId }, id) as DocumentReference;
    }
  }
  throw new Error(`clientProdutoPort: unmapped write path "${path}"`);
}

const toSnapshot = (
  id: string,
  data: { nome?: string | null; precos?: unknown },
): ProdutoSnapshot => ({
  id,
  nome: data.nome ?? null,
  precos: (data.precos ?? null) as ProdutoSnapshot['precos'],
});

/**
 * The client-SDK adapter for the produto domain {@link ProdutoDataPort}
 * (`@delfrance/data/produto`). All save/guard/cascade logic lives in the
 * framework-agnostic use-cases; this only bridges them to the Firebase JS SDK
 * through the app's collection handles.
 */
export function createClientProdutoPort(db: Firestore): ProdutoDataPort {
  return {
    newId: () => newDocId(),
    now: () => Date.now(),

    async getChildren(parentId) {
      // Forced to the server: a freshly navigated editor's local cache for this
      // query can be cold, and a cache-served read would return zero children —
      // silently skipping precos propagation / cascade delete.
      const snap = await getDocsFromServer(
        buildQuery(produtoCollection.ref(db, {}), [whereEqual('paiId', parentId)]),
      );
      return snap.docs.map((d) => toSnapshot(d.id, d.data()));
    },

    async getKitReferences(produtoId, max) {
      // Forced to the server: this read is part of the delete guard, which must
      // be fail-closed — a cache-served empty result would wrongly permit
      // deleting a produto still used in a kit.
      const snap = await getDocsFromServer(
        buildQuery(produtoCollection.ref(db, {}), [
          whereArrayContains('componentesKitKeys', produtoId),
          limit(max),
        ]),
      );
      return snap.docs.map((d) => toSnapshot(d.id, d.data()));
    },

    async subcollectionHasDocs(produtoId, subcollection) {
      const handle = subcollectionHandles.get(subcollection);
      if (!handle) throw new Error(`clientProdutoPort: unknown subcollection "${subcollection}"`);
      // Server read for the same fail-closed reason: a stale/cold cache must not
      // hide a marketplace link and permit an unsafe delete.
      const snap = await getDocsFromServer(buildQuery(handle.ref(db, { produtoId }), [limit(1)]));
      return !snap.empty;
    },

    async commit(ops: ProdutoWriteOp[]) {
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
