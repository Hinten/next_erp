/**
 * **The link folds** — which stored `prodshopee` / `variashopee` rows belong to
 * which conta, which listing, and which model.
 *
 * They were `estoque/planoEstoque.ts`'s private code until step 13's price push
 * (#1521) needed exactly the same three answers for the same two collections.
 * Promoted verbatim rather than copied: a price planner and a stock planner that
 * attribute a model to a listing through two spellings is the drift shape the
 * root `CLAUDE.md` names (#1369) — both carry a comment, both read green, and one
 * of them sends listing B's models to listing A. Pure: no clock, no Firestore,
 * no Shopee.
 *
 * ## The three folds, and their scope
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
 * 3. **Which `model_id` readings mean "no usable model"** — `0` (Shopee's
 *    no-variation sentinel), absent, non-numeric and non-integer all fold to
 *    ONE outcome: the row is not a model this planner can address. DISTINCT:
 *    every positive integer, including two ids one digit apart.
 *
 * Fold (1) is {@link idDoRef} compared by the caller; fold (2) is
 * {@link varLinksDoAnuncio}; fold (3) is {@link modelosUtilizaveis}.
 */
import { idFromRef } from '@delfrance/schemas';

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

/** One attributed `variashopee`, reduced to what a planner addresses. */
export interface ModeloCandidato {
  readonly modelId: number;
  readonly produtoId: string;
  readonly varLinkDocId: string | null;
}

/* -------------------------------------------------------------------------- */
/*                              SMALL TOTAL READERS                           */
/* -------------------------------------------------------------------------- */

/** A non-empty string, or null. */
function textoNaoVazio(bruto: unknown): string | null {
  return typeof bruto === 'string' && bruto !== '' ? bruto : null;
}

/**
 * A positive INTEGER, or null — fold (3)'s whole definition of a usable
 * `model_id`. `0`, a fraction, a numeric string and `NaN` all answer null.
 */
function inteiroPositivo(bruto: unknown): number | null {
  return typeof bruto === 'number' && Number.isInteger(bruto) && bruto > 0 ? bruto : null;
}

/* -------------------------------------------------------------------------- */
/*                                  THE FOLDS                                 */
/* -------------------------------------------------------------------------- */

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
 * The attributed rows a planner can address, in discovery order.
 *
 * Order of operations, and it is load-bearing:
 * 1. a row marked absent by a model-list read is dropped **FIRST**, before the
 *    cut — keeping it would let a dead model push a live one past the per-call
 *    cap (M-49);
 * 2. a row whose `model_id` folds to "no usable model" is dropped;
 * 3. duplicates by `modelId` collapse to the first — `stock_list` is keyed by
 *    `model_id` and a repeat would be the same model written twice in one call.
 */
export function modelosUtilizaveis(
  atribuidos: readonly {
    readonly filho: { readonly produtoId: string };
    readonly varLink: VarLinkShopeeCru;
  }[],
): ModeloCandidato[] {
  const vistos = new Set<number>();
  const saida: ModeloCandidato[] = [];
  for (const { filho, varLink } of atribuidos) {
    // ⚠️ Any non-null reading drops the row. The field is stamped when a model
    // list stopped reporting the model, and the mark is never cleared by
    // deletion — so a junk value still means "somebody marked this gone".
    if (varLink.modeloAusenteEm != null) continue;
    const modelId = inteiroPositivo(varLink.model_id);
    if (modelId == null) continue;
    if (vistos.has(modelId)) continue;
    vistos.add(modelId);
    saida.push({
      modelId,
      produtoId: filho.produtoId,
      varLinkDocId: textoNaoVazio(varLink.varLinkDocId),
    });
  }
  return saida;
}
