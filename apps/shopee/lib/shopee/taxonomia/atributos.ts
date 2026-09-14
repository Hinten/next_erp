/**
 * `get_attribute_tree` for ONE category: the row that answers the question we
 * asked, its per-category warning, and the raw log that keeps Shopee's own
 * parameter-name contradiction one literal away from being settled.
 */
import { ShopeeApiError, type ShopeeAttribute } from '@delfrance/integrations-shopee';

import { type ShopeeTaxonomiaCtx, lerAtributosCached } from './cache';

/** What {@link lerAtributos} answers for one category. */
export interface ShopeeAtributosLidos {
  readonly categoryId: number;
  /** Shopee's per-category warning, already filtered — see {@link avisoDeShopee}. */
  readonly warning: string | null;
  readonly atributos: readonly ShopeeAttribute[];
}

/**
 * The warnings Shopee sends that mean nothing, dropped; everything else kept.
 *
 * ⚠️ **EXACT equality, on `''` and `'success'` only.** No trim, no case fold, no
 * normalisation of any kind. `get_variations`' success sample carries
 * `warning: "success"` — noise on a call that worked — and surfacing it would
 * put a warning banner on every healthy read. But a fold here would be an
 * equivalence fold in the #1372 sense: it would need an inventory entry, and
 * more importantly it would pick the wrong default. `'Success'` with a capital
 * S, or `' success'` with a space, is a string Shopee chose to send that is NOT
 * the one observed as noise, and the honest answer is to show it. A warning that
 * is wrongly shown costs a question; a warning that is wrongly hidden is the
 * partial failure nobody heard about.
 */
export function avisoDeShopee(warning: string | null | undefined): string | null {
  if (warning == null) return null;
  return warning === '' || warning === 'success' ? null : warning;
}

/**
 * Whether a Shopee error code is the `error_param` family.
 *
 * Module errors arrive PREFIXED (`product.error_param`), and the bare spelling
 * appears in the shared `common_error_list`. Both are the same verdict here.
 */
function ehErroDeParametro(code: string): boolean {
  return code === 'error_param' || code.endsWith('.error_param');
}

/**
 * Read one category's attribute tree.
 *
 * ⚠️ The row is found by `category_id`, **never `list[0]`**. `get_attribute_tree`
 * answers one row per requested category and nothing in the page promises an
 * order; today this module asks for exactly one id, so `list[0]` would look
 * correct forever — right up to the day a caller batches two and every answer
 * silently describes the first category. A `list` that does not contain the id
 * we asked about is "no attributes for this category", not somebody else's.
 *
 * ⚠️ `error_param` is LOGGED RAW and then RETHROWN (never swallowed — rule 6).
 * That log is the instrument for an open contradiction: the page's parameter
 * table says `category_id_list` while its own cURL sample says `category_ids`.
 * One id serialises identically under both, so this call should work either way
 * — and if it does not, the raw `code`/`message` beside the parameter name we
 * sent is what says so, and the flip is a single literal in the package's
 * `getAttributeTree`.
 */
export async function lerAtributos(
  ctx: ShopeeTaxonomiaCtx,
  categoryId: number,
): Promise<ShopeeAtributosLidos> {
  try {
    const arvore = await lerAtributosCached(ctx, categoryId);
    const linha = arvore.list.find((row) => row.category_id === categoryId);
    if (linha === undefined) return { categoryId, warning: null, atributos: [] };
    return {
      categoryId,
      warning: avisoDeShopee(linha.warning),
      atributos: linha.attribute_tree,
    };
  } catch (err) {
    if (err instanceof ShopeeApiError && ehErroDeParametro(err.code)) {
      console.warn('[shopee/taxonomia] get_attribute_tree recusou o parâmetro enviado', {
        integracaoId: ctx.integracaoId,
        categoryId,
        // The name the package actually sends — see `getAttributeTree` in
        // `packages/integrations/shopee/src/api.ts`.
        parametro: 'category_id_list',
        codigo: err.code,
        mensagem: err.message,
      });
      throw err;
    }
    throw err;
  }
}
