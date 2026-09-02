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

import { toOuterRef } from '@delfrance/schemas';

import { parsePmlOuterRef, refMatchesIntegracao } from '../core/linkRefs';

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

/** One member link a family holds, reduced to what a per-member ML call needs. */
export interface MembroDaFamilia {
  itemId: string;
  memberDocId: string;
  memberProdutoId: string;
  pmlOuterRef: string;
}

/**
 * The family's member links, or `[]` when this listing has none.
 *
 * ⚠️ Only members carrying an `itemId` count, and that filter is what keeps a
 * LEGACY `variations[]` listing on the single-item path where it belongs. Legacy
 * variations are rows in one ML item, not listings — `importCore.ts` leaves
 * their `itemId` null — so addressing them as items would ask ML about ids that
 * do not exist. Only `publishUserProduct` and `importVariations` write `itemId`,
 * and only under User Products.
 *
 * The `pmlOuterRef` is rebuilt rather than read off a member, so the fold reads
 * by the same key regardless of which member answered. Safe as an exact `==`:
 * every writer stores it through `variacaoMercadoLivreLinkCollection.parse()`,
 * and `toOuterRef` normalises to the canonical `documents/…` form. Rides the
 * declared `produtoMercadoLivreOuterRef` COLLECTION_GROUP index.
 *
 * ⚠️ Every ML surface that acts on a listing by its PARENT link must call this
 * FIRST. The parent link's `id` is `familyId ?? itemIds[0]` (`publish.ts`), so
 * under User Products it addresses either nothing (`GET`/`PUT /items/{familyId}`
 * → 404) or exactly ONE member — and acting on member 0 while reporting the
 * family is how #1142 silently cancelled live variations. Two callers today:
 * `reverificarAnuncio` and `anuncioStatus`. The parameter is structural rather
 * than `LinkStatusTarget` so this module stays free of an `itemsStatusSync`
 * import, which imports THIS one.
 */
export async function membrosDaFamilia(
  db: Firestore,
  target: { produtoId: string; linkDocId: string },
): Promise<MembroDaFamilia[]> {
  const pmlOuterRef = toOuterRef(
    `produtos/${target.produtoId}/produtoMercadoLivre/${target.linkDocId}`,
  );
  const snap = await familyMemberQuery(db, pmlOuterRef).get();
  const membros: MembroDaFamilia[] = [];
  for (const d of snap.docs) {
    const raw = d.data() as Record<string, unknown>;
    if (typeof raw.itemId !== 'string' || raw.itemId === '') continue;
    membros.push({
      itemId: raw.itemId,
      memberDocId: d.id,
      memberProdutoId: d.ref.parent?.parent?.id ?? '',
      pmlOuterRef,
    });
  }
  return membros;
}
