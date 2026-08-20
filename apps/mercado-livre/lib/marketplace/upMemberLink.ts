/**
 * Resolve a User-Products FAMILY from one member's ML item id.
 *
 * Under User Products a produto with variations is not one listing: each member
 * is its own ML item, and the ids land in two places (`publishUserProduct.ts`) —
 * the member's `MLB…` on `variacaoMercadoLivre.itemId` under its CHILD produto,
 * and the FAMILY id on the parent `produtoMercadoLivre.id`. So an ML surface that
 * only knows a member item id cannot reach the family by matching the parent
 * link's `id`; it has to come in through the member link and hop up the
 * `produtoMercadoLivreOuterRef`.
 *
 * That hop existed three times before this module — `import.ts`'s
 * `resolveExistingUpParent`, `importMigration.ts`'s `findRegisteredMember` and
 * `orderProdutoResolve.ts`'s `resolveUpMemberChild` — byte-similar apart from
 * which half of the answer each threw away. This is the one copy; the return
 * carries BOTH ends (member and family) so no caller needs its own version.
 *
 * ⚠️ The conta check reads the PARENT link's `contaOuterRef`, never the member's
 * own. `variacaoMercadoLivre.contaOuterRef` is `.nullable()` and is null on every
 * row predating #920 until `tools/migrations/src/2026-08-ml-integracoes-com-produto`
 * backfills it — trusting it would silently resolve nothing for exactly the oldest
 * listings. `integracoesComProduto.ts` states the same rule for the same reason.
 *
 * Index: the `itemId` group query rides the declared `variacaoMercadoLivre`
 * COLLECTION_GROUP index on `itemId`, and the sibling read below rides the one on
 * `produtoMercadoLivreOuterRef`. Enterprise auto-creates neither and does not throw
 * on a missing one — it silently full-scans and bills data scanned — so neither
 * query may gain a filter that is not in `firestore.indexes.json`.
 */
import type { Firestore, Query } from 'firebase-admin/firestore';
import {
  produtoMercadoLivreLinkCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

import { parsePmlOuterRef, refMatchesIntegracao } from './linkRefs';

/** A member link plus the family parent link it hangs off. */
export interface UpMemberResolution {
  /** The variation child produto that owns the member link (null if unresolvable). */
  childProdutoId: string | null;
  /** The `variacaoMercadoLivre` doc id. */
  memberDocId: string;
  /** The member link's raw payload. */
  memberRaw: Record<string, unknown>;
  /** The FAMILY parent produto id. */
  produtoId: string;
  /** The family's `produtoMercadoLivre` doc id. */
  linkDocId: string;
  /** The family parent link's raw payload. */
  linkRaw: Record<string, unknown>;
  /** The `produtoMercadoLivreOuterRef` the member carried — the sibling key. */
  pmlOuterRef: string;
}

/**
 * The family a member `MLB…` belongs to on this account, or null when the id is
 * not a known member of any listing this integração owns.
 *
 * An ML item id is globally unique, so more than one hit can only be the SAME
 * item linked under several integração accounts — a small set. `limit(10)` bounds
 * a pathological scan without needing a second indexed filter.
 */
export async function resolveUpFamilyByMemberItemId(
  db: Firestore,
  itemId: string,
  integracaoId: string,
): Promise<UpMemberResolution | null> {
  const snap = await variacaoMercadoLivreLinkCollection
    .groupQuery(db)
    .where('itemId', '==', itemId)
    .limit(10)
    .get();

  for (const d of snap.docs) {
    const memberRaw = d.data() as Record<string, unknown>;
    const pmlOuterRef = memberRaw.produtoMercadoLivreOuterRef;
    if (typeof pmlOuterRef !== 'string') continue;
    const parsed = parsePmlOuterRef(pmlOuterRef);
    if (!parsed) continue;

    const pmlSnap = await produtoMercadoLivreLinkCollection
      .docRef(db, { produtoId: parsed.produtoId }, parsed.linkId)
      .get();
    if (!pmlSnap.exists) continue;

    const linkRaw = pmlSnap.data() as Record<string, unknown>;
    if (!refMatchesIntegracao(linkRaw.contaOuterRef, integracaoId)) continue;

    return {
      childProdutoId: d.ref.parent?.parent?.id ?? null,
      memberDocId: d.id,
      memberRaw,
      produtoId: parsed.produtoId,
      linkDocId: parsed.linkId,
      linkRaw,
      pmlOuterRef,
    };
  }
  return null;
}

/**
 * The query selecting every member link of one family.
 *
 * Returned rather than executed so a caller can hand it to `tx.get` — the family
 * fold MUST read the members inside its transaction, or a concurrent task
 * processing a different member of the same family decides against a stale view
 * and the last writer parks the family at the wrong `estado` (root `CLAUDE.md`
 * rule 7). Reading here and writing there is exactly the unguarded
 * read-modify-write that rule forbids.
 *
 * Deliberately unfiltered beyond the parent ref: a family is a handful of
 * documents and the declared `produtoMercadoLivreOuterRef` group index covers
 * exactly this shape. No conta filter is needed — the caller has already proven
 * ownership through the parent link.
 */
export function familyMemberQuery(db: Firestore, pmlOuterRef: string): Query {
  return variacaoMercadoLivreLinkCollection
    .groupQuery(db)
    .where('produtoMercadoLivreOuterRef', '==', pmlOuterRef);
}
