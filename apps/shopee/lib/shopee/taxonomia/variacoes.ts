/**
 * `get_variations` — Shopee's STANDARDISED three-level variation tree for a leaf
 * category (variation → group → option).
 *
 * ⚠️ This is the operation whose documented path contradicts its own samples
 * (`get_variation_tree` vs `get_variations`), and the path sits INSIDE the HMAC
 * base string — so the wrong one fails as `error_sign`, which reads exactly like
 * a bad partner key. The route echoes `pathUsed` for that reason; see
 * `taxonomiaCtx` in `./cache`.
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
