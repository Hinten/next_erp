/**
 * Server-owned maintenance of `produtos.integracoesComProduto` (#920).
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
 * accuracy of this array even more load-bearing than the paragraph below says:
 * it is now the ONLY server-side term standing between a live anúncio and the
 * sweep, and the per-listing gates decide the rest.
 *
 * It used to be maintained by hand at six scattered call sites, and only ever
 * REMOVED by deriving it from the sibling `marketplace` array
 * (`itemsStatusSync.removeMarketplaceEntry`, `importMigration.applyMarketplaceDeletion`).
 * That coupling is why the three legacy denorm arrays were an all-or-nothing
 * cluster: dropping `marketplace` at the Flutter decommission would have made
 * `integracoesComProduto` append-only (#431 lock 2). This module re-derives it
 * from the LINK SUBCOLLECTIONS instead, so `marketplace` + `marketplaceIds` can
 * die on their own and this array survives as a permanent, app-owned denorm.
 *
 * ## The failure asymmetry that governs every decision here
 *
 * A FALSE POSITIVE (conta listed, no live link) costs one skipped sweep row —
 * `buildSendTasks` rungs out at `'sem-link'`, `precoPlan` at `SEM_LINK`. No ML
 * call, no write, no error. A FALSE NEGATIVE (live link, no array entry) is a
 * SILENT stock + price outage: the produto is never selected and nothing logs a
 * reason. So when in doubt, over-include.
 *
 * ## Race discipline (root CLAUDE.md rule 7 / ADR 0011)
 *
 * - The ADD is **tier 0**: `arrayUnion` is commutative and idempotent, so an
 *   Eventarc redelivery or a concurrent publish costs nothing. Nothing to lose.
 * - The REMOVE reads before it writes, so it is **tier 1**: it runs inside
 *   `runTransaction` and re-derives membership from the `tx.get` result. A
 *   concurrent publish landing in the queried range fails the version check and
 *   the callback re-runs — re-checking a predicate against a binding read taken
 *   OUTSIDE the transaction would not be a guard at all.
 * - Never resurrect a produto: `onProdutoDeleted`'s cascade deletes these links,
 *   so both paths narrow `NOT_FOUND` and return.
 *
 * ## What is deliberately NOT written
 *
 * Only the array key. No `ultimaModificacao`, no `timestamp` — those feed the
 * TableView update monitors (`limit(1)` descending), and churning them on every
 * publish would make the produtos list flash for an edit no operator made. For
 * the same reason `integracoesComProduto` belongs in
 * `PRODUTO_HISTORY_IGNORE_FIELDS` (`apps/functions/src/produtos/onProdutoChanged.ts`).
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  linkHasLiveListing,
  parseRef,
  toOuterRef,
  toOuterRefOrNull,
  variacaoLinkHasListing,
} from '@delfrance/schemas';
import {
  produtoCollection,
  produtoMercadoLivreLinkCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';
// The narrow subpath, not the `@delfrance/data/admin` barrel: this module sits
// in the Cloud Functions ENTRYPOINT graph, and the barrel drags the whole admin
// surface (notifications, cache, pipelines, reconcile) in behind two predicates.
import { isNotFound } from '@delfrance/data/admin/grpcErrors';

import { parsePmlOuterRef } from '../core/linkRefs';

/** The produto field this module owns. */
const CAMPO = 'integracoesComProduto';

/* --------------------------------------------------------------------------
 * Pure helpers
 * ------------------------------------------------------------------------ */

/**
 * The integração doc id a stored `contaOuterRef` points at, or `null`.
 *
 * The array stores BARE doc ids while the link docs store REF strings — an
 * asymmetry every reader depends on (`arrayContains(integracaoId)`), so this is
 * the one place the two representations meet. Tolerates both stored ref forms,
 * matching `refMatchesIntegracao` (`linkRefs.ts`): the canonical
 * `documents/integracao/<id>` every app writes, and the bare `integracao/<id>`
 * readers accept defensively.
 *
 * Non-throwing by construction (`toOuterRefOrNull`): a permanently malformed
 * ref must degrade to "conta not resolvable" and not ride the Eventarc retry
 * forever. The collection check keeps a ref pointing somewhere else from being
 * read as a conta.
 */
export function contaIdFromRef(raw: unknown): string | null {
  const ref = toOuterRefOrNull(raw);
  if (ref == null) return null;
  const { collection, id } = parseRef(ref);
  if (collection !== 'integracao' || id.length === 0) return null;
  return id;
}

/** Both accepted stored forms of a conta ref — `endsWith` is not a Firestore predicate. */
export function contaRefForms(integracaoId: string): [string, string] {
  return [toOuterRef(`integracao/${integracaoId}`), `integracao/${integracaoId}`];
}

/**
 * What a link write means for the array, decided from the event payload ALONE.
 *
 * Returning `{ add: [], check: [] }` is the fast path, and it is load-bearing:
 * link docs are rewritten constantly for reasons that cannot move membership —
 * every stock-send error and price writeback merges `estado`/`errors`/
 * `ultimaModificacao` through `mergeIfExists`. Those events must cost zero
 * reads and zero writes, so callers must consult this BEFORE touching the db.
 *
 * `check` is "this conta may have lost its last listing" — a candidate for
 * removal, never a decision. Only the transaction that re-reads the surviving
 * links may decide that.
 */
export function planLinkChange(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  counts: (link: Record<string, unknown> | null) => boolean,
): { add: string[]; check: string[] } {
  const contaBefore = before == null ? null : contaIdFromRef(before.contaOuterRef);
  const contaAfter = after == null ? null : contaIdFromRef(after.contaOuterRef);
  const countedBefore = contaBefore != null && counts(before);
  const countsNow = contaAfter != null && counts(after);

  // Same conta, same membership contribution: nothing this write can change.
  if (contaBefore === contaAfter && countedBefore === countsNow) return { add: [], check: [] };

  const add = countsNow && contaAfter != null ? [contaAfter] : [];
  // The old conta is worth re-checking only if THIS doc used to contribute to
  // it and just stopped — either because the ref was re-pointed elsewhere or
  // because the link no longer counts. A doc that never contributed cannot have
  // been the conta's last listing, so checking it would only buy a transaction.
  const perdeuAContribuicao = countedBefore && (contaBefore !== contaAfter || !countsNow);
  const check = contaBefore != null && perdeuAContribuicao ? [contaBefore] : [];
  return { add, check };
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
 * Add a conta to the produto's array. Tier 0 — `arrayUnion`, no read, no
 * precondition, safe to replay.
 *
 * Returns false when the produto is gone: the cascade beat us and re-creating
 * it as a husk carrying one field would be far worse than a missing entry.
 */
export async function adicionarConta(
  db: Firestore,
  produtoId: string,
  integracaoId: string,
): Promise<boolean> {
  try {
    await produtoCollection
      .docRef(db, {}, produtoId)
      .update({ [CAMPO]: FieldValue.arrayUnion(integracaoId) });
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/**
 * Drop a conta from the produto's array, but ONLY once a transactional re-read
 * proves it holds no qualifying link for that conta any more.
 *
 * Tier 1. `sobrevivem` runs inside the transaction and its verdict comes from
 * the `tx.get` result, never from anything captured before `runTransaction` —
 * OCC retries re-run the callback but re-apply the closure verbatim, so a
 * predicate evaluated outside would be re-applied over the winner. The query
 * read-set is what makes a concurrent publish abort this attempt instead of
 * silently losing to it, which matters because losing here is the silent-outage
 * direction.
 */
export async function removerContaSeOrfa(
  db: Firestore,
  produtoId: string,
  integracaoId: string,
  sobrevivem: (tx: FirebaseFirestore.Transaction) => Promise<boolean>,
): Promise<boolean> {
  try {
    return await db.runTransaction(async (tx) => {
      if (await sobrevivem(tx)) return false;
      tx.update(produtoCollection.docRef(db, {}, produtoId), {
        [CAMPO]: FieldValue.arrayRemove(integracaoId),
      });
      return true;
    });
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
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
