/**
 * **The link folds** — which stored `prodshopee` / `variashopee` rows belong to
 * which conta and which listing.
 *
 * They were `estoque/planoEstoque.ts`'s private code until step 13's price push
 * (#1521) needed exactly the same three answers for the same two collections.
 * Promoted verbatim rather than copied: a price planner and a stock planner that
 * attribute a model to a listing through two spellings is the drift shape the
 * root `CLAUDE.md` names (#1369) — both carry a comment, both read green, and one
 * of them sends listing B's models to listing A. Pure: no clock, no Firestore,
 * no Shopee.
 *
 * Step 21 (#1529) MOVED folds (1) and (2) here from
 * `apps/shopee/lib/shopee/core/vinculosShopee.ts`, which re-exports them, so the
 * produto's Shopee tab in `apps/web` reads a link's conta and a model's listing
 * through the SAME two functions the planners call — `apps/web` has no
 * dependency edge to `apps/shopee`, and a browser copy is the #1369 smell. Fold
 * (3) is the planners' alone and stays there.
 *
 * ## The two folds here, and their scope
 *
 * 1. **Which conta a `prodshopee` belongs to** — the stored
 *    `contaProdutoShopeeOuterRef` compared to the integração id by its LAST
 *    path segment. EQUAL: the two stored ref encodings of one integração
 *    (`documents/integracoes/<id>` and the bare `integracoes/<id>`), because the
 *    migrated corpus carries both. DISTINCT: any other id. ⚠️ Recorded
 *    widening: only the last segment is compared, so a ref into a DIFFERENT
 *    collection whose document id happened to equal the integração id would
 *    match. Nothing writes such a value — every producer writes
 *    `integracaoCollection.docPath` — and the alternative (comparing the
 *    collection segment too) would refuse a legacy encoding this fold exists to
 *    accept.
 * 2. **Which LISTING a `variashopee` belongs to** — the stored
 *    `produtoShopeeOuterRef` compared to the `prodshopee` document id, by the
 *    same last-segment rule. ⚠️ This one is load-bearing rather than defensive:
 *    **two `prodshopee` documents under one produto are LEGAL**, so a child
 *    model must be attributed to its parent LINK and never to its parent
 *    PRODUTO. Attributing by produto would hand listing A the models of listing
 *    B, and `update_stock` would answer 200 having written the wrong numbers.
 *
 * Fold (1) is {@link idDoRef}, and {@link vinculoShopeeEhDaConta} is its
 * comparison spelled once; fold (2) is {@link varLinksDoAnuncio}. Fold (3) —
 * which `model_id` readings mean "no usable model" — is `modelosUtilizaveis`,
 * still in `apps/shopee/lib/shopee/core/vinculosShopee.ts`.
 *
 * Both folds are hand-rolled over `idFromRef`, so the #1372 obligation is
 * discharged by the EQUAL pairs and the near-misses in `vinculosShopee.test.ts`
 * (moved here with them).
 */
import { idFromRef } from '../../shared/outerRef';

/**
 * One `variashopee` document as a discovery projection returns it —
 * unvalidated, every field `unknown`.
 */
export interface VarLinkShopeeCru {
  /** Which conta owns this model link. Carried; attribution uses the LINK ref. */
  contaVariacaoShopeeOuterRef?: unknown;
  /**
   * ⚠️ **Load-bearing.** The `prodshopee` document this model belongs to. Two
   * `prodshopee` docs under one produto are LEGAL, so this — not the produto —
   * is what binds a model to a listing. See fold (2) in the module header.
   */
  produtoShopeeOuterRef?: unknown;
  /** Shopee's model id. `0`, absent and unreadable all mean "no usable model". */
  model_id?: unknown;
  model_status?: unknown;
  tier_index?: unknown;
  /** MILLISECONDS — set while a model list stopped reporting this model. */
  modeloAusenteEm?: unknown;
  /** The `variashopee` document's own id, projected by the query. */
  varLinkDocId?: unknown;
  [k: string]: unknown;
}

/** A non-empty string, or null. */
function textoNaoVazio(bruto: unknown): string | null {
  return typeof bruto === 'string' && bruto !== '' ? bruto : null;
}

/**
 * The document id a stored ref names — both encodings, or null.
 *
 * See folds (1) and (2) in the module header for what this treats as equal and
 * what it keeps distinct.
 */
export function idDoRef(bruto: unknown): string | null {
  const bruta = textoNaoVazio(bruto);
  if (bruta == null) return null;
  return textoNaoVazio(idFromRef(bruta));
}

/**
 * Every `variashopee` of the family that names THIS listing — before any
 * filtering, because "no rows at all" and "rows that were all dropped" are
 * different listings and get different lines.
 *
 * Structural in the child: anything carrying a `produtoId` and its `varLinks`
 * qualifies, so the stock family's child and the price family's child both
 * pass, and each gets its OWN type back on `filho`.
 */
export function varLinksDoAnuncio<
  F extends { readonly produtoId: string; readonly varLinks: readonly VarLinkShopeeCru[] },
>(
  children: readonly F[],
  linkDocId: string,
): { readonly filho: F; readonly varLink: VarLinkShopeeCru }[] {
  const saida: { filho: F; varLink: VarLinkShopeeCru }[] = [];
  for (const filho of children) {
    for (const varLink of filho.varLinks) {
      if (idDoRef(varLink.produtoShopeeOuterRef) === linkDocId) saida.push({ filho, varLink });
    }
  }
  return saida;
}

/**
 * Fold (1) as a predicate: does this stored `prodshopee` belong to the conta
 * `integracaoId`? {@link idDoRef} of `contaProdutoShopeeOuterRef`, compared
 * EXACTLY — never a prefix, a suffix or a substring: `int-1` is not `int-12`.
 *
 * Total over an unvalidated document: an absent, empty or non-string ref folds to
 * `null`, which equals no id (and `idDoRef` never answers `''`, so an empty
 * `integracaoId` matches nothing either).
 */
export function vinculoShopeeEhDaConta(
  link: { readonly contaProdutoShopeeOuterRef?: unknown },
  integracaoId: string,
): boolean {
  return idDoRef(link.contaProdutoShopeeOuterRef) === integracaoId;
}
