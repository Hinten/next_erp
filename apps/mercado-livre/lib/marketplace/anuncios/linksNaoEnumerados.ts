/**
 * The **link-side walk** (#1072, shared since #1200) — the half of the ML
 * sweeps that names every live anúncio their anchor terms cannot reach.
 *
 * Both sweeps ask PRODUTOS "do you carry this conta?"; this asks the LINKS
 * "which produto owns you?" — the unit the legacy enumerated
 * (`ProdutoMercadoLivre.documents.contaOuterRef__isEqualTo(conta)`,
 * `.old/lib/canaisDeVenda/mercadoLivre/pages/table.dart:41-43`). Anything the
 * anchor terms cannot express surfaces here: a produto whose
 * `integracoesComProduto` denorm lost the conta (#804 class 2 — a lost trigger
 * event; the cutover import fires no triggers at all), a link sitting on a
 * variation child (class 3), a `paiId` that is neither null nor an id, and a
 * link that outlived its produto. Class 1 (`publicado`) is gone from both
 * sweeps (#1072 price, #1087 stock).
 *
 * Two consumers, ONE walk:
 *  - `preco/precoReconciliacao.ts` — the price job's report-only phase, which
 *    turns each finding into a `NAO_ENUMERADO_*` skip row on the job report;
 *  - `estoque/auditoriaNaoEnumerados.ts` — the monthly stock audit (02:30 on
 *    the 1st), which HEALS class 2 and raises an aviso for the rest.
 * It moved here verbatim in behaviour instead of being rewritten for the stock
 * side because the two sweeps' anchor terms are IDENTICAL —
 * `bulkEstoquePlan.fetchStockFamilies` S1 and `precoPlan.fetchPrecoPage` both
 * open with `paiId == null` AND `integracoesComProduto array-contains <conta>`
 * (a pipeline `equal(field, null)` is false on an ABSENT field, exactly like the
 * classic `== null`) — so one classifier re-derives both. A second copy is the
 * drift root `CLAUDE.md` names (#1369): two files that read correct while
 * disagreeing.
 *
 * ---- It is the INVERSE of the denorm trigger, and that is what makes it
 * correct rather than heuristic. `onProdutoMercadoLivreLinkChanged` runs
 * `linkHasLiveListing` over a link and writes the verdict onto that link's own
 * produto; this runs the SAME predicate over the SAME links and reports every
 * place the trigger's output disagrees with its input.
 *
 * ---- ⚠️ The classifier IS both anchor predicates, and the pair is pinned
 * where each PREDICATE lives, not here: `bulkEstoquePlan.test.ts` evaluates the
 * S1 `where` that `fetchStockFamilies` actually recorded, and `precoPlan.test.ts`
 * runs `fetchPrecoPage`'s classic clauses, each over the same 24-document
 * matrix (`paiId` × `integracoesComProduto`), asserting `classifier === null ⇔
 * the query matches`. A term added to either query without moving
 * {@link classificarLinkNaoEnumerado} reds there. (`precoReconciliacao.test.ts`
 * pins the classifier's own cases, which cannot notice a QUERY moving.)
 *
 * ---- Index ledger:
 *  - the walk: `produtoMercadoLivre(contaOuterRef ASC, __name__ ASC)`,
 *    **COLLECTION_GROUP** — declared in the same commit as S1's own entry
 *    (#1191). The COLLECTION-scope twin cannot serve a group query;
 *  - the re-confirmation ({@link reclassificarProdutoNaoEnumerado}): the
 *    declared COLLECTION-scope `produtoMercadoLivre(contaOuterRef)`, the entry
 *    `readFamilia` and `sobrevivemLinksDoProduto` already ride;
 *  - the parent produtos: a batch KEY read (`getAll` + `fieldMask`), which needs
 *    no index.
 * Every query here is CLASSIC — no pipeline — so all of it runs in the emulator.
 */
import { FieldPath, type Firestore, type Query } from 'firebase-admin/firestore';
import { linkHasLiveListing } from '@delfrance/schemas';
import {
  produtoCollection,
  produtoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

import { contaRefForms } from './integracoesComProduto';

/* -------------------------------- vocabulary ------------------------------- */

/**
 * Why a live link's produto is invisible to the anchor terms.
 *
 * ⚠️ The VALUES are wire strings, not labels: the price job persists them raw
 * as `EnvioPrecoSkip.code` on reports already written, and
 * `preco/precoMotivos.MENSAGEM_POR_MOTIVO` keys its pt-BR on them. Renaming one
 * orphans every stored row that carries it. `precoMotivos.test.ts` scans THIS
 * file for them (it is a named scan root), so a code here with no message reds
 * there.
 */
export const CODIGO_NAO_ENUMERADO = {
  /** The link outlived its produto — a real orphan, not a coverage gap. */
  produtoAusente: 'NAO_ENUMERADO_PRODUTO_AUSENTE',
  /** The link sits on a variation CHILD (#804 class 3). */
  linkEmVariacao: 'NAO_ENUMERADO_LINK_EM_VARIACAO',
  /** `paiId` is neither null nor a usable id — a malformed cadastro. */
  paiIdInvalido: 'NAO_ENUMERADO_PAI_ID_INVALIDO',
  /** The denorm dropped a conta the produto is still linked to (#804 class 2). */
  contaForaDoProduto: 'NAO_ENUMERADO_CONTA_FORA_DO_PRODUTO',
} as const;
export type CodigoNaoEnumerado = (typeof CODIGO_NAO_ENUMERADO)[keyof typeof CODIGO_NAO_ENUMERADO];

/**
 * The two projections, shared by the walk and the re-confirmation so both
 * classify from the SAME fields. `id` + `estado` are exactly what
 * `linkHasLiveListing` reads and what a finding reports; `paiId` +
 * `integracoesComProduto` are exactly what the classifier reads. Everything else
 * is dead weight — a link doc carries `descricao` at up to 50 000 chars plus an
 * `attributes` array, a produto heavy media arrays, and Enterprise bills what is
 * scanned.
 */
const CAMPOS_LINK = ['id', 'estado'] as const;
const CAMPOS_PRODUTO = ['paiId', 'integracoesComProduto'] as const;

/* --------------------------------- the walk -------------------------------- */

/** One anúncio the anchor terms could not have reached, and why. */
export interface LinkNaoEnumerado {
  /** The produto that OWNS the link — the subcollection parent, anchor or not. */
  produtoId: string;
  /** The ML item id off the link's `id` field. */
  itemId: string | null;
  code: CodigoNaoEnumerado;
}

/** One page of the walk. */
export interface LinksNaoEnumeradosPage {
  naoEnumerados: LinkNaoEnumerado[];
  /** LIVE links inspected on this page — observability, not a skip count. */
  inspecionados: number;
  /**
   * EVERY link document the group query returned, closed and never-published
   * ones included — the cost driver, because the noise guard runs in code
   * after the read is billed. `lidos - inspecionados` is the seller's closed
   * history, re-read every walk.
   */
  lidos: number;
  /**
   * Distinct produtos key-read for this page (the `getAll` batch, deduped) — 0,
   * with no `getAll` at all, when the page held no live link.
   */
  produtosLidos: number;
  /**
   * The produtos this page read and classified CLEAN (a live link on the conta,
   * and the anchor terms would enumerate the produto), sorted — disjoint from
   * the produtos in `naoEnumerados`, because every link of one produto on
   * one page is classified from the SAME `getAll` read.
   *
   * ⚠️ A clean read is a READ, and a consumer that folds pages must honour it:
   * each page's `getAll` is its own instant, so a produto seen dirty on page k
   * and clean on page k+1 (its cadastro fixed in between) is clean NOW. The
   * stock audit lets the latest read win; with only `naoEnumerados` to go on it
   * would keep page k's stale code and raise an aviso for a clean produto. The
   * price phase emits per-page skip rows and ignores it.
   */
  limpos: string[];
  /**
   * Keyset cursor: the FULL DOCUMENT PATH of the last link read when the page
   * came back full, null when the walk is drained.
   *
   * ⚠️ A path, not a doc id. In a COLLECTION GROUP `__name__` is the full path,
   * so `startAfter` needs a `DocumentReference` rebuilt from this value; the
   * bare-id form `fetchPrecoPage` uses is a root-collection affordance and does
   * not transfer — it throws "must result in a valid document path".
   */
  nextAfterLinkPath: string | null;
}

export interface FetchLinksNaoEnumeradosArgs {
  /** Conta whose anúncios are walked. */
  integracaoId: string;
  /** Resume after this FULL document path (keyset); the first page omits it. */
  afterLinkPath?: string | null;
  /**
   * Links read per page — REQUIRED, because this module reads no environment:
   * the price phase supplies `precoReconPageLimit()`, the audit its own
   * constant, and neither may silently inherit the other's tunable.
   */
  pageLimit: number;
}

/** The walk seam both consumers take — injectable so tests stub it. */
export type FetchLinksNaoEnumeradosPage = (
  db: Firestore,
  args: FetchLinksNaoEnumeradosArgs,
) => Promise<LinksNaoEnumeradosPage>;

/**
 * ONE page of the walk as an unexecuted query — what
 * {@link fetchLinksNaoEnumeradosPage} runs. Exported for the staging suite
 * (`estoque/auditoriaNaoEnumerados.staging.test.ts`), which `explain()`s this
 * very object against the real Enterprise database instead of a hand-copied
 * chain that could drift from it. (Enterprise refuses classic explain today, so
 * that suite also judges the pipeline translation; the day it stops refusing,
 * this is the plan it reads.)
 */
export function consultaDaVarredura(db: Firestore, args: FetchLinksNaoEnumeradosArgs): Query {
  const { pageLimit } = args;
  // ⚠️ Refused, never floored. `full` in the walk is `docs.length === pageLimit`,
  // so a 0 reads nothing, calls that page FULL, finds no last path and returns a
  // null cursor — "drained" after inspecting nothing. For the audit that is a
  // COMPLETE walk, which resolves every open aviso of the conta. The price
  // binding floors its env value at 1 before it gets here, so this never fires
  // on that path; it exists for the next caller that passes a raw number.
  if (!Number.isInteger(pageLimit) || pageLimit < 1) {
    throw new RangeError(
      `[mercado-livre] pageLimit da varredura de anúncios inválido: ${String(pageLimit)}`,
    );
  }
  const afterLinkPath = args.afterLinkPath ?? null;

  const linksQuery = produtoMercadoLivreLinkCollection
    .groupQuery(db)
    .where('contaOuterRef', 'in', contaRefForms(args.integracaoId))
    .select(...CAMPOS_LINK)
    .orderBy(FieldPath.documentId())
    .limit(pageLimit);
  return afterLinkPath == null
    ? linksQuery
    : linksQuery.startAfter(linkRefDoCursor(db, afterLinkPath));
}

export const fetchLinksNaoEnumeradosPage: FetchLinksNaoEnumeradosPage = async (db, args) => {
  const { pageLimit } = args;
  const linksSnap = await consultaDaVarredura(db, args).get();

  // Only the links that name something still sellable. A produto can carry
  // several listings on one conta, so this is a list, not a map.
  const vivos: { produtoId: string; itemId: string | null }[] = [];
  for (const doc of linksSnap.docs) {
    const raw = doc.data() as Record<string, unknown>;
    // ⚠️ THE noise guard, and the reason this report is readable at all. A link
    // with no item id was never published and one at `estado 'c'` is closed —
    // `linkHasLiveListing` is false for both, which is exactly why
    // `onProdutoMercadoLivreLinkChanged` dropped the conta from
    // `integracoesComProduto`. Reporting them would emit a row for every
    // listing the seller has ever closed: the healthy steady state rendered as
    // drift, burying the real findings under it. This is also the ONLY use of
    // the stored ML status here — a classification, never a query predicate.
    if (!linkHasLiveListing(raw)) continue;
    // A link always sits two levels under a produto; a null grandparent means a
    // path this collection group should not have matched.
    const produtoId = doc.ref.parent.parent?.id ?? null;
    if (produtoId == null) continue;
    vivos.push({ produtoId, itemId: nonEmptyString(raw.id) });
  }

  const naoEnumerados: LinkNaoEnumerado[] = [];
  const limpos = new Set<string>();
  let produtosLidos = 0;
  if (vivos.length > 0) {
    const produtoIds = [...new Set(vivos.map((v) => v.produtoId))];
    produtosLidos = produtoIds.length;
    const snaps = await db.getAll(...produtoIds.map((id) => produtoCollection.docRef(db, {}, id)), {
      fieldMask: [...CAMPOS_PRODUTO],
    });
    const porId = new Map(snaps.map((snap) => [snap.id, snap]));

    for (const vivo of vivos) {
      const snap = porId.get(vivo.produtoId);
      const code = classificarLinkNaoEnumerado(
        snap?.exists === true ? ((snap.data() ?? {}) as Record<string, unknown>) : null,
        args.integracaoId,
      );
      if (code != null) naoEnumerados.push({ ...vivo, code });
      else limpos.add(vivo.produtoId);
    }
  }

  // ⚠️ The cursor advances on documents READ, never on rows reported —
  // otherwise a page of closed listings would end the walk early and hide every
  // finding behind it.
  const full = linksSnap.docs.length === pageLimit;
  const lastPath = linksSnap.docs[linksSnap.docs.length - 1]?.ref.path ?? null;
  return {
    naoEnumerados,
    inspecionados: vivos.length,
    lidos: linksSnap.docs.length,
    produtosLidos,
    limpos: [...limpos].sort(),
    nextAfterLinkPath: full ? lastPath : null,
  };
};

/* ------------------------------ the classifier ----------------------------- */

/**
 * Why the anchor terms could not have enumerated a live link's produto — or
 * `null` when they could have, which is the healthy case and reports nothing.
 *
 * ⚠️ This IS the anchor predicate of BOTH sweeps, re-derived. If either query
 * gains or loses a term this must move with it, or the report starts naming
 * rows the sweep did see (noise — and, for the stock audit, a "heal" that
 * changes nothing) or missing rows it did not (the very silence #1072 and #1200
 * exist to end). The binding tests named in the module doc pin the pair; they
 * are what make this paragraph enforceable rather than a promise.
 */
export function classificarLinkNaoEnumerado(
  produto: Record<string, unknown> | null,
  integracaoId: string,
): CodigoNaoEnumerado | null {
  // The link outlived its produto — `onProdutoDeleted`'s cascade should have
  // taken it, so this is a real orphan rather than a coverage gap.
  if (produto == null) return CODIGO_NAO_ENUMERADO.produtoAusente;
  // ⚠️ EXACT, not the repo's usual `nonEmptyString` soft coercion, because the
  // query term is an exact equality: `where('paiId', '==', null)` matches a
  // stored null and NOTHING else — not `''`, and not a document missing the
  // field, since Firestore does not index an absent field and it therefore
  // satisfies no equality at all. Coercing here would call such a produto
  // "enumerable" while the sweep never selected it: a live anúncio reported by
  // nobody, on a `completed` run — the exact silence #1072 exists to end,
  // reintroduced inside the code written to detect it.
  //
  // `produto.ts:215` records that both writers always write `paiId` explicitly,
  // so the absent-field arm should be unreachable; the empty string is the
  // reachable one (the schema is `z.string().nullable()`, with no `.min(1)`,
  // and the legacy corpus is not bound by it at all — rule 8). Both are
  // reported rather than assumed away: over-include when in doubt, per
  // `integracoesComProduto.ts`'s failure asymmetry.
  if (produto.paiId !== null) {
    // A real parent id — the link sits on a variation CHILD, and every anchor
    // term is written for family parents (#804 class 3). No surface in the repo
    // can send to it.
    if (nonEmptyString(produto.paiId) != null) return CODIGO_NAO_ENUMERADO.linkEmVariacao;
    // Neither null nor a usable id: a malformed cadastro rather than a child.
    // Kept a separate code because the remedy differs — this one is "set
    // `paiId` to null on the family parent", not "re-point the anúncio".
    return CODIGO_NAO_ENUMERADO.paiIdInvalido;
  }
  // The denorm no longer names a conta this produto is still linked to (#804
  // class 2). `integracoesComProduto.ts` calls this exact state a SILENT stock
  // + price outage; the stock audit heals it, the price phase reports it.
  const contas = Array.isArray(produto.integracoesComProduto)
    ? produto.integracoesComProduto.filter((c): c is string => typeof c === 'string')
    : [];
  if (!contas.includes(integracaoId)) return CODIGO_NAO_ENUMERADO.contaForaDoProduto;
  return null;
}

/* --------------------------- the re-confirmation --------------------------- */

/**
 * Re-classify ONE produto for one conta, NOW — the check the stock audit runs
 * before it resolves an aviso its walk no longer found.
 *
 * "Not found by this walk" is not proof of "clean now": a walk takes minutes,
 * each page's `getAll` is a separate instant, and a link created or re-pointed
 * behind the cursor is invisible to it. Resolving on absence alone would close
 * an aviso the next month's walk re-opens — a monthly flap the operator learns
 * to ignore. So the audit asks again, from the produto's side, with the SAME
 * predicate and the SAME projections as the walk:
 *  1. that produto's OWN `produtoMercadoLivre` links on the conta (both stored
 *     ref forms), kept only when `linkHasLiveListing` — none live ⇒ `null`,
 *     because a produto with no live anúncio on the conta is not a finding,
 *     whatever its cadastro says (the walk's noise guard, applied here too);
 *  2. otherwise the produto itself, masked to the classifier's two fields — a
 *     missing document is `PRODUTO_AUSENTE`, exactly as in the walk.
 *
 * Two classic reads, both on declared indexes or keys (module doc), so it runs
 * in the emulator. Not transactional on purpose: it guards a RESOLVE of an
 * informational row, and a resolve that loses a race is re-opened by the next
 * completed walk — the audit's own convergence, not a lost update.
 */
export async function reclassificarProdutoNaoEnumerado(
  db: Firestore,
  produtoId: string,
  integracaoId: string,
): Promise<CodigoNaoEnumerado | null> {
  const linksSnap = await produtoMercadoLivreLinkCollection
    .ref(db, { produtoId })
    .where('contaOuterRef', 'in', contaRefForms(integracaoId))
    .select(...CAMPOS_LINK)
    .get();
  const algumVivo = linksSnap.docs.some((d) =>
    linkHasLiveListing(d.data() as Record<string, unknown>),
  );
  if (!algumVivo) return null;

  const [snap] = await db.getAll(produtoCollection.docRef(db, {}, produtoId), {
    fieldMask: [...CAMPOS_PRODUTO],
  });
  return classificarLinkNaoEnumerado(
    snap?.exists === true ? ((snap.data() ?? {}) as Record<string, unknown>) : null,
    integracaoId,
  );
}

/* --------------------------------- helpers --------------------------------- */

/** A non-empty string, or null — the soft coercion `precoPlan` uses on raw docs. */
function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * The stored cursor path as a `DocumentReference`, through the collection
 * HANDLE rather than a raw `db.doc()` (which the `no-inline-admin-collection`
 * rule bans, and rightly: the handle is the one place that knows this path
 * shape).
 *
 * Unlike everything else in this module, a bad value here THROWS rather than
 * degrading. The cursor is machine-written — it only ever comes from
 * `doc.ref.path` on this very query — so a shape that does not parse is
 * corruption, not an operating condition, and the two graceful options are both
 * worse: ignoring it restarts the walk from the beginning on every call (a
 * loop), and concluding early truncates the walk silently — which, for the
 * audit, would read as COMPLETE and license resolving avisos. Throwing rides
 * each caller's own failure path, which says so out loud.
 */
function linkRefDoCursor(db: Firestore, path: string) {
  // `produtos/<produtoId>/produtoMercadoLivre/<linkId>`
  const parts = path.split('/');
  const produtoId = parts.length === 4 ? parts[1] : undefined;
  const linkId = parts.length === 4 ? parts[3] : undefined;
  if (produtoId == null || produtoId === '' || linkId == null || linkId === '') {
    throw new Error(
      `[mercado-livre] cursor de reconciliação de anúncios inválido: ${JSON.stringify(path)}`,
    );
  }
  return produtoMercadoLivreLinkCollection.docRef(db, { produtoId }, linkId);
}
