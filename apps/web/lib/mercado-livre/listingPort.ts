'use client';

import { runTransaction, type Firestore } from 'firebase/firestore';
import type { ProdutoMercadoLivreLink } from '@delfrance/schemas';

import { produtoMercadoLivreLinkCollection } from '@/lib/data/produtoMercadoLivreLinkCollection';
import type { ListingSavePort } from './saveListing';

/**
 * The Firestore half of {@link ListingSavePort} — the only place in the listing
 * editor that touches the SDK, so every save decision stays unit-testable.
 *
 * A transaction, not a `merge()`, because the conflict guard has to compare
 * against a doc read in the same atomic step: six writers touch these documents
 * (this editor, publish, the `items` webhook, the price sync, the stock sender,
 * and the live Flutter app) and the browser SDK has no `lastUpdateTime`
 * precondition to lean on (`apps/web/CLAUDE.md` rule 3).
 *
 * ⚠️ `tx.update` deliberately bypasses the collection converter — the same
 * reasoning as the pedido port. `set(..., { merge: true })` on a converted ref
 * would full-parse the patch, fill schema defaults for keys the operator never
 * touched, and the merge mask would then write those defaults over stored
 * values. `update` writes exactly the keys given.
 */
export function createClientListingPort(
  db: Firestore,
  produtoId: string,
  linkDocId: string,
): ListingSavePort {
  const ref = produtoMercadoLivreLinkCollection.docRef(db, { produtoId }, linkDocId);
  return {
    now: () => Date.now(),
    async update(patchFor) {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const current = snap.exists() ? (snap.data() as ProdutoMercadoLivreLink) : null;
        const patch = patchFor(current);
        if (Object.keys(patch).length === 0) return;
        tx.update(ref, patch as never);
      });
    },
  };
}
