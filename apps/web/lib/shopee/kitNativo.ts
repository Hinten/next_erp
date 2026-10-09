'use client';

/**
 * "Does this produto have a LIVE native Shopee kit?" — the question behind the
 * produto editor's pre-save kit notice (step 19, #1527: L4(1), reconcile R-v).
 *
 * Shopee freezes a native kit's composition once it is created: a quantity
 * change sent to `update_kit_item` is acknowledged and silently ignored. So an
 * operator who edits the recipe of a kit that already lives on Shopee leaves
 * the listing computing its stock from the OLD recipe. The editor cannot block
 * that edit (L4: a recipe change NEVER blocks), only say so before the save;
 * after it, `apps/functions` opens the `shopeeKitReceitaDivergente` aviso.
 *
 * ## The link decides, never the produto's flags
 *
 * Native-ness is a fact about a LISTING (`prodshopee.kitNativo`, stamped from
 * what Shopee reported), not about the produto: `ehKitVirtual` is only the
 * operator's intent for a FIRST publish, and an imported native kit carries it
 * `false`. So this reads the root produto's `prodshopee` links and answers
 * `some(ehKitNativoAtivo)` — the ONE predicate the publish dispatcher, the
 * import and the reverify resolver share (`@delfrance/schemas`). A removed or
 * superseded native kit is not "active": it has no live recipe to diverge from
 * (reconcile §9 Q4(a)). The web holds no copy of that rule.
 *
 * ## The root produto
 *
 * Links live on the kit ROOT (`produtos/{K}/prodshopee`); a family child's
 * recipe is one kit MODEL of that listing. The caller passes `paiId ?? id`.
 *
 * ## The read
 *
 * One-shot `getDocs` over the WHOLE subcollection — no filter, so no query and
 * no index (root `CLAUDE.md` rule 1): a produto carries one link per conta and
 * listing, a handful of docs. Read through the loose converter-bound handle of
 * `PRODUTO_MARKETPLACE_SUBCOLLECTIONS` (raw `collection()` is banned here), so
 * the Flutter wire shape reaches the predicate untouched. Covered by the
 * existing `produtos/{produtoId}/prodshopee` read rule (`d_produto` read), the
 * permission the editor itself needs.
 *
 * ⚠️ Advisory only. A failed or pending read shows NO notice and never blocks
 * the save; the server-side aviso is the backstop.
 */

import { skipToken, useQuery } from '@tanstack/react-query';
import { getDocs, type Firestore } from 'firebase/firestore';
import { ehKitNativoAtivo, produtoShopee } from '@delfrance/schemas';
import { PRODUTO_MARKETPLACE_SUBCOLLECTIONS } from '@/lib/data/produtoMarketplaceSubcollections';

/** The Shopee listing-link leaf, taken from the schemas registry, never respelled. */
const LEAF_PRODSHOPEE = produtoShopee.meta.collectionPath.split('/').at(-1);

/** The loose `produtos/{produtoId}/prodshopee` handle. */
const PRODSHOPEE = (() => {
  const sub = PRODUTO_MARKETPLACE_SUBCOLLECTIONS.find((s) => s.name === LEAF_PRODSHOPEE);
  if (!sub) {
    throw new Error(`kitNativo: no marketplace subcollection handle for "${LEAF_PRODSHOPEE}"`);
  }
  return sub.handle;
})();

export interface KitNativoShopee {
  /** At least one `prodshopee` link of the root produto is an ACTIVE native kit. */
  temKitNativo: boolean;
  /** The read is in flight. `false` when there is nothing to read (`null` root). */
  carregando: boolean;
}

/**
 * Read every `prodshopee` link of `produtoRaizId` and answer whether any is an
 * active native kit ({@link ehKitNativoAtivo}). Exported for the hook's test.
 */
export async function lerTemKitNativoShopee(
  db: Firestore,
  produtoRaizId: string,
): Promise<boolean> {
  const snap = await getDocs(PRODSHOPEE.ref(db, { produtoId: produtoRaizId }));
  return snap.docs.some((d) => ehKitNativoAtivo(d.data()));
}

/**
 * The editor hook: `produtoRaizId` is the kit root (`paiId ?? id`), or `null`
 * while it is not known yet — no read, no notice.
 */
export function useKitNativoShopee(db: Firestore, produtoRaizId: string | null): KitNativoShopee {
  const query = useQuery({
    // A key of its own: no other query shares this shape (see `useIntegracoes`
    // for why a shared key with a different shape is a trap).
    queryKey: ['shopee-kit-nativo', produtoRaizId],
    queryFn: produtoRaizId === null ? skipToken : () => lerTemKitNativoShopee(db, produtoRaizId),
  });
  return { temKitNativo: query.data === true, carregando: query.isLoading };
}
