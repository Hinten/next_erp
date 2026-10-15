/**
 * The size-chart REFUSAL classifier (step 18, #1526): which of Shopee's two
 * documented `get_size_chart_*` refusals a `ShopeeApiError` is — a template id
 * the shop no longer has, or a category Shopee will not list charts for.
 *
 * ## Why a classifier, and why it reads the SENTENCE
 *
 * Both refusals arrive as the SAME code, `product.error_param` (`kind:
 * 'other'`), and differ only in Shopee's own sentence: the detail page's error
 * example says "Size chart id not exist in this shop", the list page's "Category
 * id is invalid" (both committed under `fixtures/__wire__/`). So the code alone
 * decides nothing, and the sentence alone is not enough either — the same words
 * under another code (`error_data`) are not the documented refusal.
 *
 * It compares through the app's two shared folds (`core/recusaShopee.ts`), never
 * a third copy: the code after `codigoCanonicoShopee` (trim, ONE module segment
 * stripped, trim) and the sentence after `fraseCanonicaShopee(providerMessage)`
 * (whitespace collapsed, `Wrong parameters, detail:` dropped, lower-cased,
 * trailing periods dropped). ⚠️ It reads `providerMessage`, NEVER `err.message`:
 * that one is OUR formatted sentence (`Shopee <path> respondeu <code> …`), and a
 * needle matched on it proves nothing about what Shopee said.
 *
 * ## ⚠️ The ONE spelling of each sentence
 *
 * The publish refusal table (`anuncios/problemasPublicacao.ts`, step 18's
 * attach) classifies a stale template through {@link classificarRecusaTabelaMedidas}
 * itself — never a copied needle — so the routes and publish cannot disagree on
 * what a stale template is. That is also why this module is pure and Next-free:
 * the Functions bundle reaches `anuncios/`.
 *
 * ## `null` means "not a refusal this table knows"
 *
 * The CALLER decides: the routes answer through `shopeeErrorResponse`, the list
 * fan-out aborts. The caller also gates on `kind === 'other'` before calling —
 * a dead grant or a rate limit is a `ShopeeApiError` too, and keeps its own
 * answer.
 *
 * Pure and total: no clock, no I/O, no environment.
 */
import type { ShopeeApiError } from '@delfrance/integrations-shopee';

import { codigoCanonicoShopee, fraseCanonicaShopee } from '../core/recusaShopee';

/**
 * `get_size_chart_detail`'s documented refusal of a template id this shop does
 * not have (deleted in Seller Centre, or another shop's), in Shopee's casing —
 * the needle, matched as a SUBSTRING of the folded sentence (the page prints
 * "Size chart id not exist in this shop").
 */
export const FRASE_TABELA_MEDIDAS_INEXISTENTE = 'Size chart id not exist';

/** `get_size_chart_list`'s documented refusal of the category, in Shopee's casing. */
export const FRASE_CATEGORIA_INVALIDA_TABELA = 'Category id is invalid';

export type MotivoRecusaTabelaMedidas = 'tabela-inexistente' | 'categoria-invalida';

export const MOTIVO_RECUSA_TABELA_MEDIDAS = {
  /** The template id is not in this shop — the detail route's 404, the fan-out's `removidas`. */
  tabelaInexistente: 'tabela-inexistente',
  /** Shopee will not list charts for this category in this shop — the list route's 404. */
  categoriaInvalida: 'categoria-invalida',
} as const satisfies Record<string, MotivoRecusaTabelaMedidas>;

/** The ONE code both refusals carry, as {@link codigoCanonicoShopee} folds it. */
const CODIGO_DA_RECUSA = 'error_param';

/**
 * The needles, folded ONCE through the same fold as the haystack — so a needle
 * can never be compared in a form the haystack is not. Checked in this order;
 * neither needle contains the other.
 */
const AGULHAS: readonly (readonly [string, MotivoRecusaTabelaMedidas])[] = [
  [
    fraseCanonicaShopee(FRASE_TABELA_MEDIDAS_INEXISTENTE),
    MOTIVO_RECUSA_TABELA_MEDIDAS.tabelaInexistente,
  ],
  [
    fraseCanonicaShopee(FRASE_CATEGORIA_INVALIDA_TABELA),
    MOTIVO_RECUSA_TABELA_MEDIDAS.categoriaInvalida,
  ],
];

/**
 * Classify Shopee's refusal of a size-chart read (see the module docblock).
 *
 * - EQUAL: `product.error_param` ≡ `error_param` ≡ ` error_param\t`; the
 *   sentence with any casing, a `Wrong parameters, detail:` prefix, trailing
 *   periods, or extra words AFTER the needle ("… in this shop").
 * - DISTINCT (→ `null`): another code carrying the same sentence
 *   (`product.error_data`), a code with TWO module segments
 *   (`x.product.error_param`), a shorter or different sentence ("Size chart not
 *   exist", "parameter invalid"), a `null` `providerMessage` — whatever
 *   `err.message` says.
 *
 * @returns the motivo, or `null` ⇒ not a refusal this table knows.
 */
export function classificarRecusaTabelaMedidas(
  err: ShopeeApiError,
): MotivoRecusaTabelaMedidas | null {
  if (codigoCanonicoShopee(err.code) !== CODIGO_DA_RECUSA) return null;
  const frase = fraseCanonicaShopee(err.providerMessage);
  for (const [agulha, motivo] of AGULHAS) {
    if (frase.includes(agulha)) return motivo;
  }
  return null;
}
