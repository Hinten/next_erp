import { getDoc, type Firestore } from 'firebase/firestore';
import {
  precoDaTabela,
  precoDoFilhoNaTabela,
  propagaPrecoAosFilhos,
  type Produto,
} from '@delfrance/schemas';
import { produtoCollection } from '@/lib/data/produtoCollection';

/** Reads one produto by id; `undefined` when the document does not exist. */
export type LerProduto = (id: string) => Promise<Produto | undefined>;

/** A {@link LerProduto} over the `produtos` collection — one `getDoc` per call. */
export function lerProduto(db: Firestore): LerProduto {
  return async (id) => (await getDoc(produtoCollection.docRef(db, {}, id))).data();
}

/**
 * A {@link LerProduto} that reads each id at most ONCE for its whole life, so
 * a reprice where N lines are variations of one family reads their parent
 * once instead of N times. Scope it to one batch: it never refreshes, so a
 * long-lived one would keep pricing from a parent that has since changed. A
 * rejected read stays rejected for that batch too — every line of the family
 * lands in the caller's "no price found" branch, as it would have anyway.
 */
export function lerProdutoUmaVez(db: Firestore): LerProduto {
  const ler = lerProduto(db);
  const lidos = new Map<string, Promise<Produto | undefined>>();
  return (id) => {
    let lido = lidos.get(id);
    if (lido === undefined) {
      lido = ler(id);
      lidos.set(id, lido);
    }
    return lido;
  };
}

/**
 * The unit price of a pedido line's produto in a lista de preços — the SAME
 * rule the marketplace channels send (`precoDoFilhoNaTabela` in
 * `@delfrance/schemas`, bound by Mercado Livre's price plan and Shopee's
 * publish and price sync), so a pedido can no longer charge a price the
 * channels would not show:
 *
 * - a produto with no `paiId` (a parent, or a standalone) ⇒ its own entry;
 * - a variation child whose parent PROPAGATES (`propagatePriceToChildren`
 *   anything but a stored `false`) ⇒ the PARENT's entry, and the child's own
 *   map is never read — not even as a fallback. Under propagation the parent
 *   is the truth: `onProdutoChanged` overwrites every child's `precos` with the
 *   parent's, the bulk price screens edit parents only, and the product editor
 *   flags a diverging child and refuses a per-child edit. A child map that
 *   differs is stale, and one that exists where the parent's does not would
 *   price a family the operator left unpriced;
 * - a child whose parent does NOT propagate ⇒ the child's own entry, and the
 *   parent's is never borrowed: opting out means each variation is priced by
 *   hand, so an unpriced one is unpriced;
 * - a child whose parent document is missing ⇒ `null`, as the channels answer.
 *
 * ⚠️ This used to resolve child-first with a parent fallback, a faithful port
 * of Flutter's `getPrecoItemPedidoRow` (`cadastroPedidoProvider.dart:381-399`).
 * That order was never a rule there: Flutter copied the parent's whole map onto
 * every child on each parent save (`produtoTableProvider.dart:497, 556-566`)
 * and priced every channel from the parent (`pai.getPrecoId`), so child-first
 * and parent-first could only differ on drifted data — and its own tabela
 * switch (`:443`) read the line's produto alone, with no fallback at all. Here,
 * where propagation is opt-out-able, the two orders really do diverge; a probe
 * measured the pedido at 12 against the channels' 10.5 (propagating parent
 * 10.5, stale child 12), 12 against `null` (propagating parent unpriced), and
 * 10.5 against `null` (non-propagating parent 10.5, child unpriced).
 *
 * Every arm goes through `precoDaTabela`, so its normalisation holds: rounded
 * with `roundReais`, and a stored `0` or sub-centavo value is "no price"
 * (the caller's "Preço não encontrado" toast), never a pre-filled zero. Pure
 * and total — the caller reads the parent.
 */
export function precoDoProdutoNaLista(
  produto: Pick<Produto, 'paiId' | 'precos'>,
  pai: Pick<Produto, 'precos' | 'propagatePriceToChildren'> | undefined,
  listaId: string,
): number | null {
  if (!produto.paiId) return precoDaTabela(produto.precos, listaId);
  if (pai === undefined) return null;
  return precoDoFilhoNaTabela(
    {
      precosDoPai: pai.precos,
      propagaPreco: propagaPrecoAosFilhos(pai.propagatePriceToChildren),
      precosDoFilho: produto.precos,
    },
    listaId,
  );
}

/**
 * {@link precoDoProdutoNaLista} with the parent read. A variation child ALWAYS
 * costs one parent read — its own price can no longer short-circuit, because
 * only the parent's flag says whether that price counts. Pass
 * {@link lerProdutoUmaVez} as `lerPai` when pricing several lines at once.
 */
export async function precoFromProduto(
  db: Firestore,
  produto: Produto,
  listaId: string,
  lerPai: LerProduto = lerProduto(db),
): Promise<number | null> {
  const pai = produto.paiId ? await lerPai(produto.paiId) : undefined;
  return precoDoProdutoNaLista(produto, pai, listaId);
}
