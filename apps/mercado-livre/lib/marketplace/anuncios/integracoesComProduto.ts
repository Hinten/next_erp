/**
 * Mercado Livre's binding of `produtos.integracoesComProduto` (#920).
 *
 * That array is the ANCHOR PRE-FILTER both ML sweeps start from —
 * `bulkEstoquePlan.fetchStockFamilies` S1 and `precoPlan.fetchPrecoPage` each open
 * with `paiId == null AND integracoesComProduto array-contains <conta>`, riding
 * the declared `produtos(paiId, integracoesComProduto, __name__)` composite. A
 * conta id in the array means "this account's sweep visits this produto every
 * run", so the array's accuracy IS stock + price coverage.
 *
 * ⚠️ Neither sweep carries `publicado == true` any more — price since #1072,
 * stock since #1087 — and the four-field composite that used to serve them is
 * deleted. THIS array is the produto-side denorm of MERCADO LIVRE publication
 * status (derived here from `linkHasLiveListing`: an item id, and
 * `estado !== 'c'`); `publicado` is an ERP CATALOGUE flag answering a different
 * question, and gating on it dropped every unpublished produto with a live
 * listing — server-side, with no skip row (#804's class 1). That makes the
 * accuracy of this array even more load-bearing than the failure asymmetry
 * says: it is now the ONLY server-side term standing between a live anúncio and
 * the sweep, and the per-listing gates decide the rest.
 *
 * It used to be maintained by hand at scattered call sites and derived from
 * retired legacy produto fields. This module instead re-derives it from the
 * link subcollections, so it survives as a permanent app-owned denorm.
 *
 * ## What lives where since #1519
 *
 * The channel-neutral half — the conta-ref folds, the payload-only plan, the
 * `arrayUnion` add and the guarded remove — moved to
 * `@delfrance/data/admin/produtos`, where Shopee's link trigger reaches it too.
 * ⚠️ **The reasoning moved with it**: the failure asymmetry (a false positive
 * costs one skipped sweep row, a false negative is a silent stock + price
 * outage — when in doubt, over-include), the race discipline of the two writes,
 * and why only the array key is ever written. Read that header before changing
 * anything here.
 *
 * What stays is everything ML-shaped: the two link subcollections, the survivor
 * queries behind a removal, and the variação fallback that resolves a
 * pre-backfill row's conta through its parent link. `planLinkChange` below is a
 * three-argument binding over the promoted core, which takes a fourth: the
 * reader that says where THIS channel keeps its conta ref.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { linkHasLiveListing, variacaoLinkHasListing } from '@delfrance/schemas';
import {
  produtoMercadoLivreLinkCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';
// The narrow subpath, not the `@delfrance/data/admin` barrel: this module sits
// in the Cloud Functions ENTRYPOINT graph, and the barrel drags the whole admin
// surface (notifications, cache, pipelines, reconcile) in behind two predicates.
import {
  adicionarConta as adicionarContaCore,
  contaIdFromRef,
  contaRefForms,
  planLinkChange as planLinkChangeCore,
  removerContaSeOrfa as removerContaSeOrfaCore,
  type SentinelasDeArray,
} from '@delfrance/data/admin/produtos';

import { parsePmlOuterRef } from '../core/linkRefs';

export { contaIdFromRef, contaRefForms } from '@delfrance/data/admin/produtos';

/**
 * The array sentinels the promoted writers cannot import for themselves:
 * `packages/data/src/admin/**` may only `import type` from `firebase-admin`
 * (`adminBundleSafety.test.ts`), so the runtime values are supplied here, at
 * the app boundary — the same seam `escreverAviso`'s `increment` uses.
 */
const SENTINELAS: SentinelasDeArray = {
  arrayUnion: (id) => FieldValue.arrayUnion(id),
  arrayRemove: (id) => FieldValue.arrayRemove(id),
};

/* --------------------------------------------------------------------------
 * Pure helpers
 * ------------------------------------------------------------------------ */

/**
 * What a link write means for the array, decided from the event payload ALONE.
 *
 * The ML binding of the promoted core: this channel keeps its conta ref on the
 * link doc's `contaOuterRef`. Reading any other field name here would resolve
 * `null` on both sides, take the zero-cost fast path, and turn the trigger into
 * a silent no-op — which is why the core takes the reader as a required
 * parameter rather than defaulting to this one (#1519).
 */
export function planLinkChange(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  counts: (link: Record<string, unknown> | null) => boolean,
): { add: string[]; check: string[] } {
  return planLinkChangeCore(before, after, counts, (link) => contaIdFromRef(link.contaOuterRef));
}

/**
 * Could this VARIATION link write have moved membership at all?
 *
 * The child's fast path has to be decidable without a read, because resolving
 * its conta may need one (see {@link resolverContaRefDaVariacao}). So it asks
 * the cheaper question — did anything membership can depend on change — over
 * the raw payload: existence, the conta ref, the parent-link ref the fallback
 * dereferences, and whether the doc names an ML listing at all.
 */
export function variacaoPodeMudarMembership(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): boolean {
  if ((before == null) !== (after == null)) return true;
  if (before == null || after == null) return false;
  if (before.contaOuterRef !== after.contaOuterRef) return true;
  if (before.produtoMercadoLivreOuterRef !== after.produtoMercadoLivreOuterRef) return true;
  return variacaoLinkHasListing(before) !== variacaoLinkHasListing(after);
}

/* --------------------------------------------------------------------------
 * IO
 * ------------------------------------------------------------------------ */

/** Reads the parent link a variation link points at, or null when it is gone. */
export type LeitorDeLinkPai = (pai: {
  produtoId: string;
  linkId: string;
}) => Promise<Record<string, unknown> | null>;

/** {@link LeitorDeLinkPai} over a plain ref read. */
export function lerLinkPai(db: Firestore): LeitorDeLinkPai {
  return async (pai) => {
    const snap = await produtoMercadoLivreLinkCollection
      .docRef(db, { produtoId: pai.produtoId }, pai.linkId)
      .get();
    return snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;
  };
}

/**
 * {@link LeitorDeLinkPai} inside a transaction, so a fallback resolution joins
 * the read set instead of racing it. Over-conservative on purpose — a parent
 * link written meanwhile aborts and retries, and a spurious retry is far
 * cheaper than a wrong removal.
 */
export function lerLinkPaiNaTransacao(
  db: Firestore,
  tx: FirebaseFirestore.Transaction,
): LeitorDeLinkPai {
  return async (pai) => {
    const snap = await tx.get(
      produtoMercadoLivreLinkCollection.docRef(db, { produtoId: pai.produtoId }, pai.linkId),
    );
    return snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;
  };
}

/**
 * The conta ref of a variation link — from its own `contaOuterRef` when present,
 * otherwise by dereferencing `produtoMercadoLivreOuterRef` and reading the
 * parent link's.
 *
 * ⚠️ The fallback is TRANSITIONAL and its expiry condition is named: rows
 * imported from the legacy project arrive without `contaOuterRef` (#920 added
 * it; `VariacoesML` never had it), and
 * `tools/migrations/src/2026-08-ml-integracoes-com-produto` backfills them.
 * Once that has run against a project, the fallback there is dead code.
 *
 * ⚠️ Every conta comparison on a variation link MUST go through here, including
 * the survivor scan behind a removal. Reading `contaOuterRef` directly instead
 * would resolve to null on every pre-backfill sibling, conclude the conta has no
 * surviving listing, and remove it while one is live — the false negative that
 * is a silent outage.
 *
 * Resolves to `null` when the parent link is already gone, which is the normal
 * case for `pruneMigratedSource` (it deletes the parent link and its variation
 * links in ONE batch). Callers must treat that as "leave the entry alone".
 */
export async function resolverContaRefDaVariacao(
  link: Record<string, unknown> | null,
  lerPai: LeitorDeLinkPai,
): Promise<string | null> {
  if (link == null) return null;
  if (typeof link.contaOuterRef === 'string' && link.contaOuterRef.length > 0) {
    return link.contaOuterRef;
  }
  if (typeof link.produtoMercadoLivreOuterRef !== 'string') return null;
  const pai = parsePmlOuterRef(link.produtoMercadoLivreOuterRef);
  if (pai == null) return null;
  const raw = await lerPai(pai);
  if (raw == null) return null;
  return typeof raw.contaOuterRef === 'string' ? raw.contaOuterRef : null;
}

/**
 * Add a conta to the produto's array — the promoted tier-0 write, bound to this
 * app's `FieldValue`. See the core module for the race discipline.
 */
export function adicionarConta(
  db: Firestore,
  produtoId: string,
  integracaoId: string,
): Promise<boolean> {
  return adicionarContaCore(db, produtoId, integracaoId, SENTINELAS);
}

/**
 * Drop a conta from the produto's array once `sobrevivem` proves, inside the
 * transaction, that no qualifying link is left — the promoted tier-1 write,
 * bound to this app's `FieldValue`.
 */
export function removerContaSeOrfa(
  db: Firestore,
  produtoId: string,
  integracaoId: string,
  sobrevivem: (tx: FirebaseFirestore.Transaction) => Promise<boolean>,
): Promise<boolean> {
  return removerContaSeOrfaCore(db, produtoId, integracaoId, sobrevivem, SENTINELAS);
}

/**
 * Does the produto still hold a PARENT link that counts for this conta?
 * Rides the declared `produtoMercadoLivre(contaOuterRef)` COLLECTION index —
 * an `in` over the two accepted ref forms is two index seeks, not a scan.
 */
export function sobrevivemLinksDoProduto(
  db: Firestore,
  produtoId: string,
  integracaoId: string,
): (tx: FirebaseFirestore.Transaction) => Promise<boolean> {
  return async (tx) => {
    const snap = await tx.get(
      produtoMercadoLivreLinkCollection
        .ref(db, { produtoId })
        .where('contaOuterRef', 'in', contaRefForms(integracaoId)),
    );
    return snap.docs.some((d) => linkHasLiveListing(d.data() as Record<string, unknown>));
  };
}

/**
 * Does the variation child still hold a link that counts for this conta?
 *
 * Unfiltered on purpose: a child carries a handful of variation links, so
 * reading them all and filtering in code needs NO index, where a `where` would
 * need a new one.
 *
 * Each survivor's conta goes through {@link resolverContaRefDaVariacao} with a
 * transactional reader, so a pre-backfill sibling that only names its conta via
 * the parent link still counts. Comparing `contaOuterRef` directly here would
 * remove contas that are still live.
 */
export function sobrevivemVariacoesDoProduto(
  db: Firestore,
  produtoId: string,
  integracaoId: string,
): (tx: FirebaseFirestore.Transaction) => Promise<boolean> {
  return async (tx) => {
    const snap = await tx.get(variacaoMercadoLivreLinkCollection.ref(db, { produtoId }));
    const lerPai = lerLinkPaiNaTransacao(db, tx);
    for (const d of snap.docs) {
      const data = d.data() as Record<string, unknown>;
      if (!variacaoLinkHasListing(data)) continue;
      const ref = await resolverContaRefDaVariacao(data, lerPai);
      if (contaIdFromRef(ref) === integracaoId) return true;
    }
    return false;
  };
}
