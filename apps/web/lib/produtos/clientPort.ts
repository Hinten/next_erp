import {
  type DocumentReference,
  type Firestore,
  getDocFromServer,
  getDocsFromServer,
  writeBatch,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { buildQuery, limit, whereArrayContains, whereEqual } from '@delfrance/data';
import {
  buildExtraDataWriteOps,
  buildImpostoWriteOps,
  type EstoqueComando,
  type MovimentacaoInput,
  type ProdutoDataPort,
  type ProdutoSnapshot,
  type ProdutoWriteOp,
} from '@delfrance/data/produto';
import type { TransactionWrite } from '@delfrance/ui';
import {
  type ComponentesKit,
  type ImpostoProduto,
  type ProdutoExtraData,
} from '@delfrance/schemas';
import { getFirebaseFunctions } from '@/lib/firebase/client';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { produtoExtraDataCollection } from '@/lib/data/produtoExtraDataCollection';
import { estoqueProdutoCollection } from '@/lib/data/estoqueProdutoCollection';
import { impostoProdutoCollection } from '@/lib/data/impostoProdutoCollection';
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
 * a case here when their tab lands. (`historicoDePrecos`/`historicoDeCusto`
 * are NOT mapped here — nothing on the web side writes them anymore; produto
 * modification history is unified server-side in `historicoDeModificacoes`,
 * owned by the `onProdutoChanged` Cloud Function trigger.)
 */
function refForPath(db: Firestore, path: string): DocumentReference {
  const parts = path.split('/');
  if (parts.length === 2 && parts[0] === 'produtos') {
    return produtoCollection.docRef(db, {}, parts[1]!) as DocumentReference;
  }
  if (parts.length === 4 && parts[0] === 'produtos') {
    const [, produtoId, sub, id] = parts as [string, string, string, string];
    if (sub === 'extraData') {
      return produtoExtraDataCollection.docRef(db, { produtoId }, id) as DocumentReference;
    }
    if (sub === 'estoques') {
      return estoqueProdutoCollection.docRef(db, { produtoId }, id) as DocumentReference;
    }
    if (sub === 'imposto') {
      return impostoProdutoCollection.docRef(db, { produtoId }, id) as DocumentReference;
    }
  }
  throw new Error(`clientProdutoPort: unmapped write path "${path}"`);
}

/**
 * Derive `itensNoKit` from the kit composition when it's left blank. Calculates
 * the sum of all component quantities in a kit. For a kit with multiple items,
 * this represents the total count of individual items that make up the multipack.
 * If the produto is not a kit or has no components, returns the original value.
 */
export function deriveItensNoKit(
  itensNoKit: number | null | undefined,
  ehKit: boolean,
  componentesKit: ComponentesKit | null,
): number | null {
  // Keep user-provided values — only derive when explicitly null/undefined
  if (itensNoKit != null) return itensNoKit;
  if (!ehKit || !componentesKit || Object.keys(componentesKit).length === 0) return null;
  // Sum the quantities of all components
  const total = Object.values(componentesKit).reduce((sum, kit) => sum + (kit.quantidade ?? 1), 0);
  return total;
}

/**
 * The produto's transient subdocuments to write ATOMICALLY with the produto doc
 * (ObjectView `transactionWrites`): the `extraData` singleton and the per-operação
 * `imposto` docs (Flutter saves imposto in the produto's batch). Reuses the
 * framework-agnostic `build*WriteOps` use-cases for the wire shapes and maps each
 * domain path to a converter-bound ref so they ride `saveRecord`'s transaction —
 * one commit, all-or-nothing (no orphan produto on a flaky link). (Estoque is NOT
 * here — it spans the parent + each variation child, each its own produto doc, and
 * is edited directly in the Estoque tab, not on the parent save.)
 */
export function buildProdutoTransactionWrites(
  db: Firestore,
  produtoId: string,
  values: Record<string, unknown>,
): TransactionWrite[] {
  const writes: TransactionWrite[] = [];
  const pushOp = (op: ProdutoWriteOp) => {
    const ref = refForPath(db, op.path) as DocumentReference<unknown>;
    if (op.type === 'delete') writes.push({ type: 'delete', ref });
    else if (op.type === 'update') writes.push({ type: 'update', ref, data: op.data });
    else writes.push({ type: 'set', ref, data: op.data });
  };

  let extra = (values.extraData as ProdutoExtraData | null) ?? null;
  if (extra) {
    // Derive itensNoKit when it's blank on a kit
    const ehKit = (values.ehKit as boolean) ?? false;
    const componentesKit = (values.componentesKit as ComponentesKit | null) ?? null;
    extra = {
      ...extra,
      itensNoKit: deriveItensNoKit(extra.itensNoKit, ehKit, componentesKit),
    };
    for (const op of buildExtraDataWriteOps(produtoId, extra)) pushOp(op);
  }

  const impostos = (values.impostos as ImpostoProduto[] | null) ?? null;
  if (impostos && impostos.length > 0) {
    for (const op of buildImpostoWriteOps(produtoId, impostos, Date.now())) pushOp(op);
  }

  return writes;
}

/**
 * Invoke the server-owned `aplicarEstoque` callable (apps/functions). The Cloud
 * Function performs getOrCreate + the movement/localização + the audit record in
 * ONE Firestore transaction — the first-movement create race and the clamping
 * policy live there, not in each client (issue #226). Failures arrive as a
 * `FirebaseError` (FunctionsError) the callers narrow on.
 */
function callAplicarEstoque(comando: EstoqueComando): Promise<void> {
  const fn = httpsCallable<EstoqueComando, { estoqueId: string }>(
    getFirebaseFunctions(),
    'aplicarEstoque',
  );
  return fn(comando).then(() => undefined);
}

/**
 * Set a depósito's `localizacao` for a produto — an immediate write decoupled
 * from the parent form save (estoque spans the parent + each variation child).
 * The server getOrCreates the estoque (`quantidade: 0` on first touch) and sets
 * `localizacao` only; quantities (movement-owned) are never touched here.
 */
export async function setEstoqueLocalizacao(args: {
  produtoId: string;
  depositoId: string;
  localizacao: string | null;
}): Promise<void> {
  await callAplicarEstoque({ op: 'localizacao', ...args });
}

/**
 * Apply a stock movement (entrada / saída / balanço) for one (produto, depósito).
 * The server resolves it conflict-safely inside a transaction (delta for
 * entrada/saída, absolute set for balanço), getOrCreates the estoque doc on first
 * touch, and appends the `HistoricoEstoque` audit record — all atomically.
 */
export async function movimentarEstoque(args: {
  produtoId: string;
  depositoId: string;
  input: MovimentacaoInput;
}): Promise<void> {
  await callAplicarEstoque({ op: 'movimento', ...args });
}

/**
 * Read each parent produto's variation children (`paiId == parent`) as
 * `{ id, variacoesUid }` — the input the "Gerar Variações" matcher needs for
 * every kit component. Forced to the server (a cold cache would silently drop
 * children and mis-generate). One `paiId ==` query per component, in parallel
 * (component counts are small); returns a map keyed by parent id.
 */
export async function getVariationChildrenByParent(
  db: Firestore,
  parentIds: string[],
): Promise<Record<string, Array<{ id: string; variacoesUid: string[] }>>> {
  const unique = [...new Set(parentIds)];
  const entries = await Promise.all(
    unique.map(async (parentId) => {
      const snap = await getDocsFromServer(
        buildQuery(produtoCollection.ref(db, {}), [whereEqual('paiId', parentId)]),
      );
      const children = snap.docs.map((d) => ({
        id: d.id,
        variacoesUid: (d.data().variacoesUid as string[] | null) ?? [],
      }));
      return [parentId, children] as const;
    }),
  );
  return Object.fromEntries(entries);
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
      // silently skipping kit-status propagation / cascade delete.
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

    async getKitFlags(ids) {
      // One deterministic doc read per id, in parallel (component/parent counts
      // are small). Forced to the server for the same fail-closed reason as the
      // guard reads: this feeds the kit-of-kit / child-of-kit validators, so a
      // stale cache must not misclassify a kit as a non-kit. Missing docs are
      // dropped (treated as non-kit by the resolver). Empty ids are filtered
      // out too — `docRef(db, {}, '')` is an invalid reference that throws.
      const unique = [...new Set(ids)].filter((id) => id !== '');
      const snaps = await Promise.all(
        unique.map((id) =>
          getDocFromServer(produtoCollection.docRef(db, {}, id) as DocumentReference),
        ),
      );
      return snaps
        .filter((s) => s.exists())
        .map((s) => ({
          id: s.id,
          ehKit: (s.data() as { ehKit?: boolean } | undefined)?.ehKit === true,
        }));
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
