/**
 * Text sanitisation for NF-e fields.
 *
 * SEFAZ rejects certain characters in free-text fields (razão social,
 * endereço, informações adicionais) — see the `nfe` skill,
 * references/leiaute.md. The pipeline is: strip diacritics, then drop
 * restricted characters.
 *
 * XML-significant characters (`& < > " '`) are intentionally left raw here —
 * the XML serializer (`../xml`) escapes them, so escaping is never duplicated.
 */

/** Strip diacritics (á→a, ç→c, ã→a, …) via Unicode NFD decomposition. */
export function removerAcentos(input: string): string {
  return input.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

/** Characters SEFAZ rejects outright — dropped from the text. */
const RESTRICTED = new Set([...'@#%*$£§ªº©®™[]{}=+_|\\~^`']);

/**
 * Drop characters SEFAZ rejects. Control characters are removed; line breaks
 * and tabs become spaces; runs of spaces are collapsed. Apply `removerAcentos`
 * first. Does NOT escape XML — the serializer owns that.
 */
export function removerCharRestrito(input: string): string {
  let out = '';
  for (const ch of input) {
    if (ch === '\n' || ch === '\r' || ch === '\t') {
      out += ' ';
      continue;
    }
    if ((ch.codePointAt(0) ?? 0) <= 0x1f) continue;
    if (RESTRICTED.has(ch)) continue;
    out += ch;
  }
  return out.replace(/ {2,}/g, ' ');
}

/**
 * Full field sanitiser: strip accents, drop restricted characters, trim.
 * Returns `null` for empty/blank input — NF-e omits empty optional tags
 * rather than emitting them (MOC §4.2.1.3).
 *
 * When `maxLen` is provided, the result is capped at that length (XSD
 * `maxLength` facets like `xCpl=60`, `xLgr=60`, `xNome=60`). Truncation
 * happens *after* restricted-char + diacritic stripping, then `trimEnd`
 * runs so a trailing partial space is never returned. Only use this for
 * non-fiscal free-text fields (endereço, party name) — truncating a
 * fiscal field (`xProd`, `infCpl`, `infAdFisco`) silently could
 * misrepresent the document, so leave those raw and let the XSD gate
 * reject them.
 */
export function sanitizeNFeText(
  input: string | null | undefined,
  maxLen?: number,
): string | null {
  if (input == null) return null;
  let cleaned = removerCharRestrito(removerAcentos(input)).trim();
  if (maxLen != null && cleaned.length > maxLen) {
    cleaned = cleaned.slice(0, maxLen).trimEnd();
  }
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * Email-aware sanitiser. Same boundary as {@link sanitizeNFeText} — `null` /
 * blank → `null` — but never applies the restricted-char filter, because
 * `@` is on that list and emails MUST keep it. Trims, drops control
 * characters, and lower-cases for stable comparisons. Does NOT escape XML
 * (`&` etc.) — the serializer owns that.
 *
 * Use this for `<email>` slots (cliente, infRespTec, …); use
 * `sanitizeNFeText` for free-text descriptive fields (razão social,
 * complemento, infCpl).
 */
export function sanitizeNFeEmail(input: string | null | undefined): string | null {
  if (input == null) return null;
  let out = '';
  for (const ch of input.trim()) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f) continue; // drop control chars
    if (ch === ' ') continue; // emails contain no whitespace
    out += ch;
  }
  return out.length === 0 ? null : out;
}
