import {
  type DocumentReference,
  type Firestore,
  getDocsFromServer,
  increment,
  writeBatch,
} from 'firebase/firestore';
import { buildQuery, limit, whereArrayContains, whereEqual } from '@delfrance/data';
import {
  buildExtraDataWriteOps,
  buildLocalizacaoOp,
  planMovimentacao,
  type MovimentacaoInput,
  type ProdutoDataPort,
  type ProdutoSnapshot,
  type ProdutoWriteOp,
} from '@delfrance/data/produto';
import type { TransactionWrite } from '@delfrance/ui';
import {
  estoqueProdutoSchema,
  historicoEstoqueSchema,
  makeEstoqueUid,
  type ProdutoExtraData,
} from '@delfrance/schemas';
import { produtoCollection } from '@/lib/data/produtoCollection';
import {
  historicoCustoCollection,
  historicoPrecoCollection,
} from '@/lib/data/historicoCollections';
import { produtoExtraDataCollection } from '@/lib/data/produtoExtraDataCollection';
import { estoqueProdutoCollection } from '@/lib/data/estoqueProdutoCollection';
import { historicoEstoqueCollection } from '@/lib/data/historicoEstoqueCollection';
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
    if (sub === 'estoques') {
      return estoqueProdutoCollection.docRef(db, { produtoId }, id) as DocumentReference;
    }
  }
  throw new Error(`clientProdutoPort: unmapped write path "${path}"`);
}

/**
 * The produto's transient subdocuments to write ATOMICALLY with the produto doc
 * (ObjectView `transactionWrites`): the `extraData` singleton. Reuses the
 * framework-agnostic `buildExtraDataWriteOps` use-case for the wire shape and maps
 * the domain path to a converter-bound ref so it rides `saveRecord`'s transaction
 * — one commit, all-or-nothing (no orphan produto on a flaky link). (Estoque is
 * NOT here — it spans the parent + each variation child, each its own produto doc,
 * and is edited directly in the Estoque tab via `setEstoqueLocalizacao` /
 * `movimentarEstoque`, not on the parent save.)
 */
export function buildProdutoTransactionWrites(
  db: Firestore,
  produtoId: string,
  values: Record<string, unknown>,
): TransactionWrite[] {
  const writes: TransactionWrite[] = [];
  const pushOp = (op: ProdutoWriteOp) => {
    if (op.type === 'delete') return;
    writes.push({
      type: op.type,
      ref: refForPath(db, op.path) as DocumentReference<unknown>,
      data: op.data,
    });
  };

  const extra = (values.extraData as ProdutoExtraData | null) ?? null;
  if (extra) {
    for (const op of buildExtraDataWriteOps(produtoId, extra)) pushOp(op);
  }

  return writes;
}

/**
 * Set a depósito's `localizacao` for a produto — an immediate write decoupled
 * from the parent form save (estoque spans the parent + each variation child).
 * On an existing estoque it is a `localizacao`-only `update`; otherwise it
 * creates a fresh estoque (`quantidade: 0`). Mirrors the Flutter
 * `editarLocalizacao` — quantities are never touched here.
 */
export async function setEstoqueLocalizacao(
  db: Firestore,
  args: { produtoId: string; depositoId: string; localizacao: string | null; hasExisting: boolean },
): Promise<void> {
  const op = buildLocalizacaoOp(
    args.produtoId,
    args.depositoId,
    args.localizacao,
    args.hasExisting,
    Date.now(),
  );
  const ref = refForPath(db, op.path);
  const batch = writeBatch(db);
  if (op.type === 'update') batch.update(ref, op.data as never);
  else if (op.type === 'set') batch.set(ref, op.data as never);
  await batch.commit();
}

/**
 * Apply a stock movement (entrada / saída / balanço) for one (produto, depósito),
 * conflict-safe: entrada/saída use an atomic `increment` on the estoque doc — it
 * NEVER overwrites the server count — while balanço sets the absolute counted
 * value; a `HistoricoEstoque` audit record is appended in the SAME `writeBatch`.
 * When no estoque doc exists yet it is created with the movement's resulting
 * quantities (increment-from-zero == the delta). Mirrors Flutter `movimentar`.
 */
export async function movimentarEstoque(
  db: Firestore,
  args: { produtoId: string; depositoId: string; hasExisting: boolean; input: MovimentacaoInput },
): Promise<void> {
  const now = Date.now();
  const plan = planMovimentacao(args.input, now);
  const estoqueId = makeEstoqueUid(args.produtoId, args.depositoId);
  const estoqueRef = estoqueProdutoCollection.docRef(db, { produtoId: args.produtoId }, estoqueId);
  const historicoRef = historicoEstoqueCollection.docRef(
    db,
    { produtoId: args.produtoId, estoqueId },
    newDocId(),
  );

  const batch = writeBatch(db);
  if (!args.hasExisting) {
    // First movement on this (produto, depósito): create the doc with the
    // resulting quantities (reservada floored at 0 to satisfy the schema).
    batch.set(
      estoqueRef,
      estoqueProdutoSchema.parse({
        parentId: args.produtoId,
        depositoOuterRef: `documents/depositos/${args.depositoId}`,
        quantidade: plan.quantidade,
        quantidadeReservada: Math.max(0, plan.quantidadeReservada),
        dataCriacao: now,
        ultimaModificacao: now,
      }) as never,
    );
  } else if (plan.ehBalanco) {
    // Balanço — set the absolute counted value (a deliberate override).
    batch.update(estoqueRef, {
      quantidade: plan.quantidade,
      quantidadeReservada: plan.quantidadeReservada,
      ultimaModificacao: now,
    } as never);
  } else {
    // Entrada/saída — atomic increment, never clobbering a concurrent movement.
    batch.update(estoqueRef, {
      quantidade: increment(plan.quantidade),
      quantidadeReservada: increment(plan.quantidadeReservada),
      ultimaModificacao: now,
    } as never);
  }
  batch.set(historicoRef, historicoEstoqueSchema.parse(plan.historico) as never);
  await batch.commit();
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
