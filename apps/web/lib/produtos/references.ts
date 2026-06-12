import { type Firestore, getDocs } from 'firebase/firestore';
import { buildQuery, limit, whereArrayContains } from '@delfrance/data';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { PRODUTO_MARKETPLACE_SUBCOLLECTIONS } from '@/lib/data/produtoMarketplaceSubcollections';

/** Inbound references that make a produto unsafe to delete. */
export interface ProdutoReferences {
  /** Kits (other produtos) whose `componentesKit` contains this doc id. */
  kits: Array<{ id: string; nome: string }>;
  /** Channel labels with at least one marketplace-link doc (deduped). */
  marketplaces: string[];
}

/**
 * Look up everything that still points at a produto (variation child or
 * parent) before allowing its deletion — deleting a referenced doc breaks the
 * kit that contains it and the marketplace listing variation synced to it
 * (issues #117/#135; the old Flutter app deletes blindly).
 *
 * - Kit membership: `componentesKitKeys` is the denormalized id array Flutter
 *   maintains on every kit save — an `array-contains` probe finds referencing
 *   kits (capped at 5; the guard message only needs a few names).
 * - Marketplace links: every channel stores its listing/variation doc in a
 *   subcollection of the produto itself, so a limit-1 existence read per
 *   known subcollection covers parents and children alike.
 */
export async function findProdutoReferences(
  db: Firestore,
  produtoId: string,
): Promise<ProdutoReferences> {
  const kitsQuery = getDocs(
    buildQuery(produtoCollection.ref(db, {}), [
      whereArrayContains('componentesKitKeys', produtoId),
      limit(5),
    ]),
  );
  const marketplaceProbes = PRODUTO_MARKETPLACE_SUBCOLLECTIONS.map(
    async (sub): Promise<string | null> => {
      const snap = await getDocs(buildQuery(sub.handle.ref(db, { produtoId }), [limit(1)]));
      return snap.empty ? null : sub.label;
    },
  );

  const [kitsSnap, ...labels] = await Promise.all([kitsQuery, ...marketplaceProbes]);
  return {
    kits: kitsSnap.docs.map((d) => ({ id: d.id, nome: d.data().nome ?? d.id })),
    marketplaces: [...new Set(labels.filter((l): l is string => l !== null))],
  };
}

/** True when any reference exists (the produto must not be deleted). */
export function hasReferences(refs: ProdutoReferences): boolean {
  return refs.kits.length > 0 || refs.marketplaces.length > 0;
}

/** Guard message for notifications/alerts, e.g. on a blocked variation row. */
export function describeReferences(refs: ProdutoReferences): string {
  const parts: string[] = [];
  if (refs.marketplaces.length > 0) {
    parts.push(`vinculado(a) a anúncio(s): ${refs.marketplaces.join(', ')}`);
  }
  if (refs.kits.length > 0) {
    parts.push(`usado(a) no(s) kit(s): ${refs.kits.map((k) => k.nome).join(', ')}`);
  }
  return parts.join('; ');
}
