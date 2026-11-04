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
 * ## Where each fold lives (step 21, #1529)
 *
 * Folds (1) and (2) — which CONTA a `prodshopee` belongs to, and which LISTING
 * a `variashopee` belongs to — MOVED to `@delfrance/schemas`
 * (`produto/collection/vinculosShopee.ts`, with their scope tables and their
 * pair/near-miss suite), because the produto's Shopee tab in `apps/web` must
 * attribute rows through the SAME two functions and `apps/web` cannot import
 * this app. They are re-exported below, so none of their importers changed.
 *
 * Fold (3) stays here — the planners are its only readers:
 *
 * 3. **Which `model_id` readings mean "no usable model"** — `0` (Shopee's
 *    no-variation sentinel), absent, non-numeric and non-integer all fold to
 *    ONE outcome: the row is not a model this planner can address. DISTINCT:
 *    every positive integer, including two ids one digit apart.
 *
 * Fold (1) is `idDoRef` compared by the caller; fold (2) is `varLinksDoAnuncio`;
 * fold (3) is {@link modelosUtilizaveis}.
 */
import type { VarLinkShopeeCru } from '@delfrance/schemas';

export { idDoRef, varLinksDoAnuncio, type VarLinkShopeeCru } from '@delfrance/schemas';

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
