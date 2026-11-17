/**
 * The ONE text-search fold of the Shopee pickers: the category search
 * (`apps/shopee`'s `taxonomia/categorias/busca` route, over the cached tree)
 * and the brand filter of the conta's brand modal (`apps/web`
 * `AdicionarMarcasShopeeModal`, over the brand pages already loaded). Both
 * surfaces fold the same way, so the module lives here — `apps/web` cannot
 * import `apps/shopee`, and a second copy would drift (#1369).
 *
 * ## What it folds, and what it must not
 *
 * A search decides only what is DISPLAYED — no write, no identity, no diff
 * reads it — so folding too much shows an extra row and folding too little
 * hides one. It still follows the fold inventory's rule (#1372): both halves
 * are pinned in `buscaTextoShopee.test.ts`.
 *
 * - **Equal:** case and accents (`Calçados` ≡ `calcados`, `CAMISETA` ≡
 *   `camiseta`), runs of whitespace, and the ORDER of the query's words
 *   (`camiseta masculina` ≡ `masculina camiseta`). A word is a SUBSTRING match
 *   on purpose: `cami` finds `Camiseta`.
 * - **Distinct:** punctuation and separators inside a word (`tshirt` does
 *   not find `T-Shirt`, nor `t-shirt` find `TShirt`), and any letter that is
 *   not an accent variant (`calca` does not find `Calda`).
 *
 * The fold is `normalizeLoose`'s (`@delfrance/ai`) and `normalizarIe`'s
 * (`./cliente.ts`) — NFD, drop diacritics, lowercase — inlined because this
 * package depends only on `@delfrance/core` and `zod`. Pure and total.
 */

/** A text folded for search: no accents, pt-BR lowercase, one space between words, trimmed. */
export function dobrarTextoBuscaShopee(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The distinct folded words of a query, in order; `[]` for a blank one. */
export function termosDaBuscaShopee(consulta: string): readonly string[] {
  const dobrada = dobrarTextoBuscaShopee(consulta);
  if (dobrada === '') return [];
  return [...new Set(dobrada.split(' '))];
}

/**
 * Whether EVERY term is a substring of at least one of `textos`, folded.
 * `null` texts are skipped. An empty `termos` matches everything: what a
 * blank query means ("no filter", or "do not search") is the caller's call.
 */
export function correspondeABuscaShopee(
  textos: readonly (string | null | undefined)[],
  termos: readonly string[],
): boolean {
  if (termos.length === 0) return true;
  const dobrados = textos
    .filter((t): t is string => typeof t === 'string')
    .map(dobrarTextoBuscaShopee);
  return termos.every((termo) => dobrados.some((texto) => texto.includes(termo)));
}
