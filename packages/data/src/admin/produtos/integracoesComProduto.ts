/**
 * Server-owned maintenance of `produtos.integracoesComProduto` (#920) — the
 * channel-neutral half, promoted out of
 * `apps/mercado-livre/lib/marketplace/anuncios/integracoesComProduto.ts` by
 * #1519 (Shopee step 11) when a second channel gained a link trigger.
 *
 * `packages/data/src/admin/produtos/resolveProdutoPorSku.ts` is the precedent
 * and states the reason: a second copy of a decision this expensive drifts
 * toward plausible while reading correct. Everything channel-shaped stays in
 * the app — the link subcollections, the survivor queries, the variação
 * fallbacks — and enters here as two injected readers: `counts`, which decides
 * whether a link doc contributes, and `contaDoLink`, which says where that
 * doc's conta ref lives.
 *
 * That array is the ANCHOR PRE-FILTER the marketplace sweeps start from: a
 * conta id in it means "this account's sweep visits this produto every run", so
 * the array's accuracy IS stock + price coverage. It is the produto-side denorm
 * of PUBLICATION status, derived from the link subcollections — never from the
 * ERP catalogue flag `publicado`, which answers a different question and whose
 * use as a gate dropped every unpublished produto with a live listing,
 * server-side, with no skip row (#804's class 1, #1072, #1087).
 *
 * ## The failure asymmetry that governs every decision here
 *
 * A FALSE POSITIVE (conta listed, no live link) costs one skipped sweep row —
 * the send planner rungs out at "no link", the price plan at `SEM_LINK`. No
 * provider call, no write, no error. A FALSE NEGATIVE (live link, no array
 * entry) is a SILENT stock + price outage: the produto is never selected and
 * nothing logs a reason. So when in doubt, over-include.
 *
 * ⚠️ That asymmetry is why {@link planLinkChange}'s `contaDoLink` is a REQUIRED
 * parameter with no default. A default reading one channel's field name would
 * answer `null` for every other channel's link, both sides of the comparison
 * would be `null`, and the zero-cost fast path would swallow the write — a
 * trigger that logs nothing and does nothing, which is precisely the
 * false-negative direction (#1519, C37a).
 *
 * ## Race discipline (root CLAUDE.md rule 7 / ADR 0011)
 *
 * - The ADD is **tier 0**: `arrayUnion` is commutative and idempotent, so an
 *   Eventarc redelivery or a concurrent publish costs nothing. Nothing to lose.
 * - The REMOVE reads before it writes, so it is **tier 1**: it runs inside
 *   `runTransaction` and re-derives membership from the `tx.get` result. A
 *   concurrent publish landing in the queried range fails the version check and
 *   the callback re-runs — re-checking a predicate against a binding read taken
 *   OUTSIDE the transaction would not be a guard at all. Since #1519 the
 *   survivors reader is a caller-supplied closure (ML's two collection-bound
 *   ones, Shopee's unfiltered `prodshopee` scan), so the class is unchanged:
 *   the verdict still comes from the callback's own `tx.get`.
 * - Never resurrect a produto: the produto cascade deletes these links, so both
 *   paths narrow `NOT_FOUND` and return.
 *
 * ## What is deliberately NOT written
 *
 * Only the array key. No `ultimaModificacao`, no `timestamp` — those feed the
 * TableView update monitors (`limit(1)` descending), and churning them on every
 * publish would make the produtos list flash for an edit no operator made. For
 * the same reason `integracoesComProduto` belongs in
 * `PRODUTO_HISTORY_IGNORE_FIELDS` (`apps/functions/src/produtos/onProdutoChanged.ts`).
 */

import type { Firestore } from 'firebase-admin/firestore';
import { parseRef, toOuterRef, toOuterRefOrNull } from '@delfrance/schemas';

import { produtoCollection } from '../collections';
import { isNotFound } from '../grpcErrors';

/** The produto field this module owns. */
const CAMPO = 'integracoesComProduto';

/**
 * The two array sentinels the writes below need, supplied by the caller.
 *
 * ⚠️ `packages/data/src/admin/**` may only `import type` from `firebase-admin`
 * — `adminBundleSafety.test.ts` asserts it over the whole subtree, because
 * `apps/web` imports this package and that separation rests on import hygiene
 * rather than on tooling. `FieldValue.arrayUnion` / `FieldValue.arrayRemove`
 * are RUNTIME values, so they arrive from the app the way
 * `EscreverAvisoDeps.increment` does (`../avisos/escreverAviso.ts`):
 * `{ arrayUnion: (id) => FieldValue.arrayUnion(id), arrayRemove: (id) => FieldValue.arrayRemove(id) }`.
 *
 * ⚠️ ONE object with NAMED keys, deliberately — not two positional callbacks.
 * Both have the identical type `(id: string) => unknown`, so as parameters they
 * are interchangeable to the compiler, and a caller that swapped them would
 * make the ADD path remove the conta: the silent stock + price outage this
 * module's header calls the expensive direction. Named keys make the swap
 * something you have to write on purpose.
 */
export interface SentinelasDeArray {
  /** `(id) => FieldValue.arrayUnion(id)` */
  readonly arrayUnion: (id: string) => unknown;
  /** `(id) => FieldValue.arrayRemove(id)` */
  readonly arrayRemove: (id: string) => unknown;
}

/* --------------------------------------------------------------------------
 * Pure helpers
 * ------------------------------------------------------------------------ */

/**
 * The integração doc id a stored conta ref points at, or `null`.
 *
 * The array stores BARE doc ids while the link docs store REF strings — an
 * asymmetry every reader depends on (`arrayContains(integracaoId)`), so this is
 * the one place the two representations meet. Tolerates both stored ref forms:
 * the canonical `documents/integracao/<id>` every app writes, and the bare
 * `integracao/<id>` readers accept defensively.
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
 *
 * @param counts does this link doc contribute to its conta's membership?
 * @param contaDoLink where this channel's conta ref lives on the link doc.
 *   ⚠️ REQUIRED and never defaulted — see the header's failure asymmetry.
 */
export function planLinkChange(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  counts: (link: Record<string, unknown> | null) => boolean,
  contaDoLink: (link: Record<string, unknown>) => string | null,
): { add: string[]; check: string[] } {
  const contaBefore = before == null ? null : contaDoLink(before);
  const contaAfter = after == null ? null : contaDoLink(after);
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

/* --------------------------------------------------------------------------
 * IO
 * ------------------------------------------------------------------------ */

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
  sentinelas: SentinelasDeArray,
): Promise<boolean> {
  try {
    await produtoCollection
      .docRef(db, {}, produtoId)
      .update({ [CAMPO]: sentinelas.arrayUnion(integracaoId) });
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
  sentinelas: SentinelasDeArray,
): Promise<boolean> {
  try {
    return await db.runTransaction(async (tx) => {
      if (await sobrevivem(tx)) return false;
      tx.update(produtoCollection.docRef(db, {}, produtoId), {
        [CAMPO]: sentinelas.arrayRemove(integracaoId),
      });
      return true;
    });
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}
