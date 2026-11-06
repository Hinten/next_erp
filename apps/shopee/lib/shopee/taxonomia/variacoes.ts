/**
 * `get_variations` — Shopee's STANDARDISED three-level variation tree for a leaf
 * category (variation → group → option).
 *
 * ⚠️ This is the operation whose documented path contradicts its own samples
 * (`get_variation_tree` vs `get_variations`). SETTLED on BR production
 * (2026-11-04): the default is `get_variation_tree`, and the samples' spelling
 * answers HTTP 404 `error_not_found`. `SHOPEE_VARIATIONS_PATH` stays an escape
 * hatch, so the route echoes `pathUsed`; see `taxonomiaCtx` in `./cache`.
 */
import { type ShopeeTaxonomiaCtx, lerVariacoesCached } from './cache';
import { type VariacaoDto, projetarVariacoes } from './dto';

/** What {@link lerVariacoes} answers for one leaf category. */
export interface VariacoesLidas {
  readonly categoryId: number;
  readonly standardiseVariationList: readonly VariacaoDto[];
}

/**
 * Read (and cache) the standardised variation tree.
 *
 * ⚠️ `variation_option_id: 0` is an observed CUSTOM option, not an absence, and
 * it survives the projection as the value it is. A reader that treated it as
 * missing would drop exactly the option an operator typed by hand.
 */
export async function lerVariacoes(
  ctx: ShopeeTaxonomiaCtx,
  categoryId: number,
): Promise<VariacoesLidas> {
  const payload = await lerVariacoesCached(ctx, categoryId);
  return {
    categoryId,
    standardiseVariationList: projetarVariacoes(payload.standardise_variation_list),
  };
}
