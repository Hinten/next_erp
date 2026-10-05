/**
 * The ONE rule for a Shopee TOKEN reaching a returns log line (#1525, step 17):
 * a status, a reason, a logistics state, a push field name. Read by the
 * importer's log line, the push parser's diary and the `importar:devolucao`
 * CLI's transcript — three copies of one regex were written before this module
 * existed, and the third carried a comment saying it was "the same regex",
 * which is root CLAUDE.md's #1369 smell verbatim.
 *
 * PURE and TOTAL: no clock, no I/O, no environment, no `console`.
 *
 * ⚠️ **A token, never a fold.** Nothing is trimmed, case-folded or repaired:
 * `' NOT_RECEIPT'` and `'Delivery Failed'` are NOT tokens and are replaced by
 * the marker — a log line here carries ids, tokens, counts and booleans only,
 * and the marker is the record that SOMETHING arrived without echoing what.
 *
 * ⚠️ **Not the error-code gate.** Shopee's error CODE (`err.code`) reaches a
 * log through `nfe/redacaoNfe.ts`'s `codigoSeguro` (trimmed, dotted codes
 * allowed, seven digits refused) — a different rule for a different field.
 */

/**
 * A plain Shopee token: 1–64 ASCII letters, digits or `_`. No flags — a `g`
 * would make `.test` stateful across calls.
 */
export const TOKEN_SHOPEE_PARA_LOG: RegExp = /^[A-Za-z0-9_]{1,64}$/;

/**
 * What replaces anything that is not a plain token — never the value itself.
 * Also what `respostaReclamacao.ts`'s `semFraseDaShopee` puts where
 * `codigoSeguro` refuses a Shopee error code: one marker for "something
 * arrived that we do not echo".
 */
export const MARCADOR_NAO_TOKEN = '<nao-token>';

/**
 * A value as a log line may carry it.
 *
 * @returns `null` for `null`/`undefined`; the value VERBATIM when it is a
 *   {@link TOKEN_SHOPEE_PARA_LOG} token; otherwise `'<nao-token>'`. PAIR:
 *   `'NOT_RECEIPT'` ⇒ itself. NEAR-MISS: `' NOT_RECEIPT'`, `''`, a 65-character
 *   token and `'returns.error_data'` ⇒ the marker.
 */
export function tokenParaLog(v: string | null | undefined): string | null {
  if (v == null) return null;
  return TOKEN_SHOPEE_PARA_LOG.test(v) ? v : MARCADOR_NAO_TOKEN;
}
