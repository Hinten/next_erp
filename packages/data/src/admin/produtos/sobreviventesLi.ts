/**
 * Loja Integrada's SURVIVOR read for `produtos.integracoesComProduto`: does this produto still
 * hold a `produtolojaintegrada` link that COUNTS for this conta? It is the closure the core's
 * guarded writes (`integracoesComProduto.ts`) evaluate inside their own read set.
 *
 * ## Why one channel's survivor read lives here
 *
 * Every other channel's survivor read stays in its app (the core module's header says why). This
 * one moved here from the Loja Integrada anchor binding
 * (`apps/loja-integrada/lib/lojaIntegrada/produtos/integracoesComProdutoLi.ts`, which binds it to
 * the guarded remove) because a second caller needs the identical read and cannot import an app:
 * a `tools/migrations` script that adds a missing conta through the core's read-derived add
 * (`adicionarContaSeViva`). That add converges only while its survivor folds exactly as the
 * trigger's remove does. With two copies, a later change to one would show up as an add that the
 * next remove undoes, and no test of either copy would see it. The read is still handed to the
 * core as a caller-supplied closure: the module moved, the seam did not. `sondaSkuLi.ts` is the
 * precedent for a Loja Integrada read in this folder.
 *
 * ## The read is UNFILTERED, and that is the index decision
 *
 * `firestore.indexes.json` declares the COLLECTION_GROUP composite
 * `produtolojaintegrada (contaLojaIntegrada, id)` for the order import's lookup, and NO
 * `produtolojaintegrada` COLLECTION index. So a `where` on the conta ref here would be an
 * undeclared predicate, and on Firestore Enterprise an undeclared predicate does not throw: it
 * silently full-scans, billed by data SCANNED (root `CLAUDE.md` rule 1). A produto carries a
 * handful of link documents, one per conta it is listed under, so reading them all and filtering
 * in code needs NO index at all. That is the Shopee binding's argument for its own scan.
 *
 * ## A filter would also disagree with the plan
 *
 * The trigger decides its candidate with `contaDoLinkLi` and `vinculoLiConta`
 * (`@delfrance/schemas`). Filtering here with the SAME two readers is what keeps the survivor
 * verdict consistent with that decision. A query could not do that: `contaIdFromRef` also folds a
 * ref stored with a leading slash or an empty segment, which an `in` over the two canonical forms
 * would miss, and `vinculoLiConta` counts an `id` stored as its decimal TEXT, which a typed range
 * on `id` would miss. Either miss reads "no survivor" for a link that counts and drops the conta,
 * the silent-outage direction.
 *
 * ## The verdict is the guarded read's
 *
 * The verdict comes from the `tx.get` result and from nothing captured before the guarded write
 * opened: a retry re-runs this callback, but re-applies any outer closure verbatim (root
 * `CLAUDE.md` rule 7).
 *
 * Only Firestore TYPES are imported from `firebase-admin` (`adminBundleSafety.test.ts`). Pinned
 * by `sobreviventesLi.test.ts`.
 */
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { contaDoLinkLi, vinculoLiConta } from '@delfrance/schemas';

import { produtoLojaIntegradaLinkCollection } from '../collections';

/**
 * Does `produtos/<produtoId>` still hold a `produtolojaintegrada` link that counts for
 * `contaId`? A link survives when {@link contaDoLinkLi} reads it as `contaId` AND
 * {@link vinculoLiConta} counts it: hidden and blocked links survive, a trashed one, an id that
 * names no store product, another conta's and a malformed conta ref do not.
 *
 * Returns the closure the core's guarded write runs; it reads only through its `tx`.
 */
export function sobrevivemVinculosDoProdutoLi(
  db: Firestore,
  produtoId: string,
  contaId: string,
): (tx: Transaction) => Promise<boolean> {
  return async (tx) => {
    const snap = await tx.get(produtoLojaIntegradaLinkCollection.ref(db, { produtoId }));
    return snap.docs.some((d) => {
      const data = (d.data() ?? {}) as Record<string, unknown>;
      return contaDoLinkLi(data) === contaId && vinculoLiConta(data);
    });
  };
}
