import type { FaixaDto } from './taxonomiaShopeeDto';

/**
 * The Shopee BAND CHECK and the listing's TEXT RESOLUTION (#1911, P2) — the
 * ONE copy of the rules the publisher (`apps/shopee`'s `montarAnuncio`) applies
 * to a listing's name and description before it sends anything, so a browser
 * surface — #1911's draft editor, its pendências and its character counter —
 * can ask the same questions with the same answers instead of keeping a second
 * copy that drifts toward plausible (#1369).
 *
 * Moved VERBATIM in semantics from `montagemAnuncio.ts` (`textoUtilizavel`,
 * `dentroDaFaixa`, `descreverFaixa` and the two `?? ` resolutions of the name
 * and the description); {@link textoNaFaixaShopee} is the one NEW function, the
 * composition the publisher performs inline. Pure and total — no clock, no
 * network, no Firestore.
 *
 * ## What "usable text" folds, and what it keeps
 *
 * {@link textoUtilizavelShopee} is `String.prototype.trim` plus "blank ⇒
 * absent": leading/trailing whitespace (incl. NBSP) goes, and a text that is
 * only whitespace reads as ABSENT. Everything else is kept byte for byte —
 * inner whitespace, case, and a zero-width space (not whitespace to `trim`, so
 * a name of only `U+200B` is PRESENT, one character long). Lengths are UTF-16
 * code units (`String.length`), the publisher's measure: an emoji counts 2.
 *
 * ## Known copies NOT replaced here
 *
 * - `publicarAnuncio.ts`'s `textoUtilizavel` is a DIFFERENT function: it tests
 *   the trimmed text for blankness but returns the UNTRIMMED one, and it feeds
 *   projections, not the band check. Replacing it would change what is stored.
 * - `kits/planoKit.ts` keeps its own `textoUtilizavel` / `dentroDaFaixa`: the
 *   kit path is out of #1911's scope. Recorded, not fixed.
 */

/** A usable text value: trimmed and non-empty. Blank means ABSENT everywhere the publisher reads text. */
export function textoUtilizavelShopee(valor: string | null | undefined): string | null {
  if (typeof valor !== 'string') return null;
  const limpo = valor.trim();
  return limpo.length > 0 ? limpo : null;
}

/**
 * Whether `valor` sits inside `banda` — BOTH ends inclusive.
 *
 * An absent band, or an absent end of one, is NO BOUND — Shopee's limit pages
 * leave ends `null` when the category states none, and treating that as `0`
 * would refuse every description on a category that declares no maximum.
 */
export function dentroDaFaixaShopee(valor: number, banda: FaixaDto | null | undefined): boolean {
  if (banda == null) return true;
  if (banda.min !== null && valor < banda.min) return false;
  if (banda.max !== null && valor > banda.max) return false;
  return true;
}

/** A human description of a band, for a problema's `mensagem`: `min..max`, `—` for an open end. */
export function descreverFaixaShopee(banda: FaixaDto | null | undefined): string {
  if (banda == null) return 'sem faixa informada';
  const min = banda.min === null ? '—' : String(banda.min);
  const max = banda.max === null ? '—' : String(banda.max);
  return `${min}..${max}`;
}

/**
 * The verdict of one text against one band:
 * - `ausente` — no usable text (absent, not a string, or blank);
 * - `fora-da-faixa` — usable, but its length is outside the band (never truncated);
 * - `ok` — usable and inside; `texto` is the TRIMMED text, the one the publisher sends.
 *
 * `comprimento` is the UTF-16 length of the TRIMMED text.
 */
export type TextoNaFaixaShopee =
  | { readonly estado: 'ausente' }
  | { readonly estado: 'fora-da-faixa'; readonly comprimento: number }
  | { readonly estado: 'ok'; readonly texto: string; readonly comprimento: number };

/**
 * {@link textoUtilizavelShopee} then {@link dentroDaFaixaShopee} on its length —
 * exactly the publisher's name and description checks, as one call, so a caller
 * (the draft editor's counter and pendências) cannot measure a different string
 * (an untrimmed one) than the publisher refuses.
 */
export function textoNaFaixaShopee(
  texto: string | null | undefined,
  banda: FaixaDto | null | undefined,
): TextoNaFaixaShopee {
  const utilizavel = textoUtilizavelShopee(texto);
  if (utilizavel === null) return { estado: 'ausente' };
  const comprimento = utilizavel.length;
  if (!dentroDaFaixaShopee(comprimento, banda)) return { estado: 'fora-da-faixa', comprimento };
  return { estado: 'ok', texto: utilizavel, comprimento };
}

/**
 * The listing's TITLE: the link's own `item_name` when usable, else the
 * produto's `nome` — both through {@link textoUtilizavelShopee}, so a blank
 * link name falls back instead of publishing whitespace. `null` ⇔ neither is
 * usable (the publisher's `sem-nome`).
 *
 * ⚠️ The LINK is checked first: an operator-authored listing name always wins
 * over the ERP's product name.
 */
export function tituloDoAnuncioShopee(
  itemNameDoLink: string | null | undefined,
  nomeDoProduto: string | null | undefined,
): string | null {
  return textoUtilizavelShopee(itemNameDoLink) ?? textoUtilizavelShopee(nomeDoProduto);
}

/**
 * The listing's DESCRIPTION: the link's own `description` when usable, else the
 * produto's description (its `extraData/singleton.descricao`) — same rule and
 * same order as {@link tituloDoAnuncioShopee}. `null` ⇔ neither is usable (the
 * publisher's `sem-descricao`).
 */
export function descricaoDoAnuncioShopee(
  descricaoDoLink: string | null | undefined,
  descricaoDoProduto: string | null | undefined,
): string | null {
  return textoUtilizavelShopee(descricaoDoLink) ?? textoUtilizavelShopee(descricaoDoProduto);
}
