import { type Firestore, getDocFromServer, getDocsFromServer } from 'firebase/firestore';
import { buildQuery, whereEqual } from '@delfrance/data';
import { buildDuplicarProdutoWriteOps, type FilhoParaDuplicar } from '@delfrance/data/produto';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { createClientProdutoPort } from './clientPort';
import { newDocId } from './docId';

/** The selected row no longer exists — the read raced a delete. */
export class ProdutoNaoEncontradoError extends Error {}

/**
 * "Duplicar" produto (#556) — clone a PARENT produto's own fields into a
 * brand-new document, re-creating each of its variation children under the
 * clone. Never a `copyHref` pre-fill: a produto owns children, kit
 * composition and marketplace links a plain create-form seed can't touch (see
 * the issue's own opening line). All the field-level decisions — what gets
 * renamed, cleared or mirrored — live in `buildDuplicarProdutoWriteOps`
 * (`@delfrance/data/produto`); this only supplies it fresh reads and fresh
 * ids and commits the result.
 *
 * Reads are forced to the server: a stale cache silently missing a variation
 * child would drop it from the clone rather than reporting anything.
 *
 * Returns the new PARENT's id, for the caller to navigate to its editor.
 */
export async function duplicarProduto(db: Firestore, produtoId: string): Promise<string> {
  const parentSnap = await getDocFromServer(produtoCollection.docRef(db, {}, produtoId));
  if (!parentSnap.exists()) {
    throw new ProdutoNaoEncontradoError(`produto ${produtoId} não encontrado`);
  }

  const childrenSnap = await getDocsFromServer(
    buildQuery(produtoCollection.ref(db, {}), [whereEqual('paiId', produtoId)]),
  );
  const filhos: FilhoParaDuplicar[] = childrenSnap.docs.map((d) => ({
    id: d.id,
    dados: d.data(),
  }));

  const novoParentId = newDocId();
  const novosFilhoIds = filhos.map(() => newDocId());

  const ops = buildDuplicarProdutoWriteOps(
    novoParentId,
    parentSnap.data(),
    filhos,
    novosFilhoIds,
    Date.now(),
  );
  await createClientProdutoPort(db).commit(ops);

  return novoParentId;
}
