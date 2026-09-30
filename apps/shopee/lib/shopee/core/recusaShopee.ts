/**
 * The two folds every Shopee REFUSAL classifier in this app compares through:
 * the envelope `error` code and the provider's own sentence.
 *
 * They were `nfe/classificarNfe.ts`'s private `codigoDaRecusa` /
 * `detalheDaRecusa` (#1522, step 14) until the label flow (#1523, step 15)
 * needed the identical reading of `get_shipping_parameter` / `ship_order` /
 * `create_shipping_document` refusals. Promoted verbatim — same steps, same
 * order — rather than copied: two copies of a fold with a comment claiming they
 * agree is the drift root `CLAUDE.md` names (#1369), and here a drift is a
 * refusal that one classifier reads as a known row and the other as "unknown".
 *
 * ## ⚠️ What each fold treats as EQUAL, and what must stay DISTINCT
 *
 * `codigoCanonicoShopee` — trim, strip ONE module segment with the package's
 * `shopeeCodeSemPrefixoDeModulo` (which does not trim), trim again:
 * - EQUAL: `order.upload_invoice_error\t` ≡ `upload_invoice_error` (the api page
 *   prints its code followed by a TAB), ` logistics.package_already_shipped` ≡
 *   `package_already_shipped`.
 * - DISTINCT: `a.b.source_ip_undeclared` keeps `b.` (exactly one segment, never a
 *   greedy strip that would let any code that merely ENDS in a known one match);
 *   the CASE is kept (`Error_Param` ≠ `error_param`).
 *
 * `fraseCanonicaShopee` — whitespace runs collapsed to one space, trimmed, a
 * leading `Wrong parameters, detail:` stripped (case-insensitive — twelve of
 * guide 382's seventeen texts, and `get_shipping_parameter`, share that
 * template), lower-cased, trailing periods and blanks dropped (guide 382's
 * texts end in `..`):
 * - EQUAL: `Wrong parameters, detail: Invalid CNPJ..` ≡ `invalid cnpj`.
 * - DISTINCT: interior punctuation stays (`nf-e` ≠ `nfe`), and the prefix is
 *   stripped only at the START (a sentence that merely CONTAINS it keeps it).
 * - `null` ⇒ `''`, which no needle matches.
 *
 * ⚠️ Read `providerMessage`, NEVER the thrown Error's `.message`: that is OUR
 * sentence (`Shopee <path> respondeu <code> …`), and a needle matched on it
 * matches our own prefix before Shopee has said a word.
 *
 * Pure and total: no clock, no I/O, no environment — the functions bundle may
 * reach it through `nfe/`.
 */
import { shopeeCodeSemPrefixoDeModulo } from '@delfrance/integrations-shopee';

/** The template prefix most of Shopee's refusal sentences share. */
const PREFIXO_DO_ENVELOPE = /^wrong parameters,\s*detail:\s*/i;

/**
 * The envelope code as a refusal table compares it: trimmed, ONE module segment
 * stripped, trimmed again. The VERBATIM code stays the caller's, for its log
 * line; a table never returns this.
 */
export function codigoCanonicoShopee(code: string): string {
  const aparado = code.trim();
  return (shopeeCodeSemPrefixoDeModulo(aparado) ?? aparado).trim();
}

/**
 * The provider's sentence as a refusal table's needles read it (see the module
 * docblock). `null` ⇒ `''`, which no needle matches.
 */
export function fraseCanonicaShopee(providerMessage: string | null): string {
  if (providerMessage === null) return '';
  return providerMessage
    .replace(/\s+/g, ' ')
    .trim()
    .replace(PREFIXO_DO_ENVELOPE, '')
    .toLowerCase()
    .replace(/[.\s]+$/, '');
}
