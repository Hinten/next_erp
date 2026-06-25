import { getDoc, type Firestore } from 'firebase/firestore';
import type { Produto } from '@delfrance/schemas';
import { produtoCollection } from '@/lib/data/produtoCollection';

/**
 * The unit price of a produto in a given lista de preços. `produto.precos` is a
 * `Record<listaId, { valor: number }>` keyed by the ListaDePrecos doc id, so a
 * direct lookup is `precos[listaId].valor`. Returns `null` when the produto has
 * no `precos` map, no entry for that lista, or a non-numeric `valor`.
 */
export function directPreco(produto: Produto, listaId: string): number | null {
  const valor = produto.precos?.[listaId]?.valor;
  return typeof valor === 'number' ? valor : null;
}

/**
 * Resolve a produto's unit price for a lista de preços, falling back to the
 * variation parent (`paiId`) when the variation child has no price of its own —
 * matching the Flutter app, where variation children inherit the parent's
 * `precos` map. Reads the parent doc only when needed (the direct hit avoids any
 * Firestore read). Returns `null` when neither the produto nor its parent has a
 * price for the lista.
 */
export async function precoFromProduto(
  db: Firestore,
  produto: Produto,
  listaId: string,
): Promise<number | null> {
  const direct = directPreco(produto, listaId);
  if (direct !== null) return direct;
  if (!produto.paiId) return null;
  const parentSnap = await getDoc(produtoCollection.docRef(db, {}, produto.paiId));
  const parent = parentSnap.data();
  if (!parent) return null;
  return directPreco(parent, listaId);
}
