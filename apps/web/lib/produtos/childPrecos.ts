import { type Firestore, getDocs, writeBatch } from 'firebase/firestore';
import { buildQuery, whereEqual } from '@delfrance/data';
import { type PrecosMap, samePrecos } from '@delfrance/schemas';
import { produtoCollection } from '@/lib/data/produtoCollection';

// A writeBatch caps at 500 operations — chunk large variation sets.
const BATCH_LIMIT = 499;

/**
 * Refresh the `precos` of every existing variation child whose map differs
 * from the parent's just-saved value — Flutter's per-child `updateOnly`
 * propagation (`produtoTableProvider.dart:556-568`, which writes NO history).
 * Pedidos resolve the price on the SOLD child doc, so a stale child would sell
 * at the old price.
 *
 * Done at the page (orchestrator) layer with a FRESH read, not the editor's
 * live `onSnapshot`: propagation must fire even when the user only touched the
 * Preço e custo tab and never opened the Variações tab (whose manager owns the
 * live children snapshot). Children created in this same save already carry the
 * parent's precos (set by the VariationManager flush), so they never differ
 * here.
 */
export async function propagateParentPrecosToChildren(
  db: Firestore,
  parentId: string,
  precos: PrecosMap,
): Promise<void> {
  const snap = await getDocs(
    buildQuery(produtoCollection.ref(db, {}), [whereEqual('paiId', parentId)]),
  );
  const stale = snap.docs.filter((d) => !samePrecos(d.data().precos ?? null, precos));
  console.warn(
    '[PROPAGATE]',
    JSON.stringify({
      parentId,
      precos,
      found: snap.docs.length,
      childPrecos: snap.docs.map((d) => d.data().precos ?? null),
      stale: stale.map((d) => d.id),
    }),
  );
  for (let i = 0; i < stale.length; i += BATCH_LIMIT) {
    const batch = writeBatch(db);
    for (const d of stale.slice(i, i + BATCH_LIMIT)) {
      batch.update(produtoCollection.docRef(db, {}, d.id), { precos: precos ?? null } as never);
    }
    await batch.commit();
  }
}
