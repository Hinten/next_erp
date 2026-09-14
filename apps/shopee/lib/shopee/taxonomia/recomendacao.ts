/**
 * `category_recommend` — the category ids Shopee suggests for a product name.
 *
 * ⚠️ **Offered, never applied.** Nothing here writes, nothing picks, and the
 * route says so on the body (`applied: false`). That is #799 in one line: the
 * Mercado Livre publish path used to call `suggestCategories(nome, 1)` and apply
 * `[0]` with no human in the loop, so a wrong first hit only surfaced once the
 * listing existed, in the wrong category, on a live marketplace.
 *
 * ⚠️ Shopee's payload is `category_id: int[]` — an ARRAY despite the singular
 * name — and nothing published says whether it is a ranked list of candidates or
 * a root-to-leaf path. So `position` is the index it arrived at (1-based) and
 * nothing more: this module does not decide what the order means.
 */
import { type ShopeeTaxonomiaCtx, lerIndiceDeCategorias, lerRecomendacaoCached } from './cache';
import { caminhoDaCategoria, ehFolha } from './categorias';
import { type CategoriaResumoDto, projetarCategoria } from './dto';

/** One suggested category, resolved against the cached tree where possible. */
export interface RecomendacaoDto {
  /** 1-based, the order Shopee sent. See the module header. */
  readonly position: number;
  readonly categoryId: number;
  /** `null` when the id is not in this shop's tree. */
  readonly name: string | null;
  /** `null` — not `false` — when the id could not be resolved. */
  readonly isLeaf: boolean | null;
  readonly pathFromRoot: readonly CategoriaResumoDto[];
}

/** What {@link lerRecomendacaoDeCategoria} answers. */
export interface RecomendacaoLida {
  readonly recomendacoes: readonly RecomendacaoDto[];
  /** How many suggested ids were absent from this shop's category tree. */
  readonly unresolved: number;
}

/**
 * Suggest categories for `nome`, each resolved against the cached tree.
 *
 * ⚠️ Two failure directions, deliberately opposite:
 *
 *  - **one id that is not in the tree** degrades to a row with `name: null`,
 *    `isLeaf: null` and an empty path, and is counted in `unresolved`. A
 *    suggestion Shopee returned is worth showing even when we cannot decorate
 *    it, and the alternative — failing the list — throws away the rows that DID
 *    resolve. `isLeaf: null` rather than `false` keeps the three-valued verdict
 *    honest: "unknown" is not "has children".
 *  - **the tree read itself failing** SURFACES. It is not one row's problem: it
 *    is the read every other taxonomy route depends on, and hiding it would
 *    answer a full list of undecorated rows while the conta is actually
 *    unreadable.
 *
 * ⚠️ ONE log line for the whole read, not one per row: a product name that
 * suggests eight unknown categories is one fact about the shop's tree, and eight
 * lines is how a log stops being read.
 */
export async function lerRecomendacaoDeCategoria(
  ctx: ShopeeTaxonomiaCtx,
  nome: string,
  imagemCapa: string | null,
): Promise<RecomendacaoLida> {
  const ids = await lerRecomendacaoCached(ctx, nome, imagemCapa);
  // Nothing suggested: no tree read, no fan-out, nothing to resolve.
  if (ids.length === 0) return { recomendacoes: [], unresolved: 0 };

  const indice = await lerIndiceDeCategorias(ctx);
  let unresolved = 0;
  const recomendacoes = ids.map((categoryId, i) => {
    const no = indice.porId.get(categoryId);
    if (no === undefined) {
      unresolved += 1;
      return { position: i + 1, categoryId, name: null, isLeaf: null, pathFromRoot: [] };
    }
    return {
      position: i + 1,
      categoryId,
      name: no.display_category_name,
      isLeaf: ehFolha(indice, categoryId) === 'folha',
      pathFromRoot: caminhoDaCategoria(indice, categoryId).map((row) =>
        projetarCategoria(indice, row),
      ),
    };
  });

  if (unresolved > 0) {
    console.warn('[shopee/taxonomia] category_recommend sugeriu categorias fora da árvore', {
      integracaoId: ctx.integracaoId,
      sugeridas: ids.length,
      naoResolvidas: unresolved,
    });
  }

  return { recomendacoes, unresolved };
}
