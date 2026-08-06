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

/* --------------------------- corrupted-text detection ----------------------- */

/**
 * U+FFFD REPLACEMENT CHARACTER — what a lenient UTF-8 decoder substitutes for a
 * byte it could not make sense of. The original byte is gone, so this class is
 * unrecoverable by definition.
 */
const REPLACEMENT_CHAR = 0xfffd;

/**
 * Where cp1252 differs from latin1: it remaps the 27 assigned bytes in `80..9F`
 * onto printable characters instead of C1 controls. Listed in byte order —
 * `0x80` first — so the table can be checked against the WHATWG index.
 */
const CP1252_SPECIALS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);

/** What a UTF-8 continuation byte (`80..BF`) becomes under a single-byte read. */
function ehContinuacaoMalLida(cp: number): boolean {
  // latin1 maps 80..BF to itself; cp1252 only differs over 80..9F.
  return (cp >= 0x0080 && cp <= 0x00bf) || CP1252_SPECIALS.has(cp);
}

/**
 * The UTF-8 lead bytes that matter here, as the single-byte read renders them
 * (`C2`/`C3` → `Â`/`Ã`, `E2` → `â` — identical under latin1 and cp1252):
 *
 * - `C2`, `C3` cover **all** of Latin-1 Supplement, so every accented character
 *   Portuguese uses.
 * - `E2` covers the U+2000 block — "smart typography" (curly quotes, en/em
 *   dashes, the ellipsis), which marketplace exports ship routinely.
 *
 * All three are ordinary Portuguese letters on their own (`SÃO`, `CÂMARA`,
 * `câmara`), which is why a lead alone proves nothing — it must be FOLLOWED by
 * a {@link ehContinuacaoMalLida} character, and that class holds no letters.
 */
const LEADS_MAL_LIDOS = new Set([0x00c2, 0x00c3, 0x00e2]);

/**
 * True when `input` carries the evidence of a lost encoding round-trip.
 *
 * Two classes, both derived from what the bytes actually do:
 *
 * 1. **U+FFFD anywhere** — unrecoverable, see {@link REPLACEMENT_CHAR}.
 * 2. **A UTF-8 payload read back as latin1/cp1252.** UTF-8 encodes every
 *    character this domain cares about as a {@link LEADS_MAL_LIDOS} lead byte
 *    plus one or two continuation bytes `80..BF`; a single-byte read turns that
 *    sequence into a lead character followed by a
 *    {@link ehContinuacaoMalLida} character.
 *
 * Why this exists: the legacy Flutter app decoded some UTF-8 HTTP bodies as
 * latin1 (Dart's `Response.body` defaults to latin1 when the Content-Type names
 * no charset), and the corrupted text it produced was written to Firestore and
 * is still there. `removerAcentos` + `removerCharRestrito` then launder it into
 * plausible ASCII — the mojibake form of `Aclimação` sanitises to `AclimaAAo`,
 * and a U+FFFD-bearing `São Paulo` to `So Paulo` — which passes every downstream
 * gate and gets SIGNED, then printed on the DANFE at the buyer's door. Callers
 * use this to reject the value loudly instead. See issue #788.
 *
 * ⚠️ Run this on the RAW value, before any sanitisation. `removerAcentos`
 * NFD-decomposes `Ã` into `A` + combining tilde and strips the tilde, and
 * `removerCharRestrito` drops U+FFFD as `> 0xFF`; either one erases the evidence.
 *
 * ⚠️ Compared by codepoint, never against a literal pattern, so this source file
 * stays free of the very characters it detects — a repo-wide U+FFFD or digraph
 * scan keeps meaning what it means instead of matching the detector itself.
 *
 * False positives: the continuation class holds no ASCII and no ordinary Latin
 * letter, so legitimate uppercase Portuguese (`SÃO PAULO`, `CÂMARA`) never
 * matches, and the `ª`/`º` ordinals common in Brazilian addresses (`1º andar`)
 * follow a digit, never `Ã`/`Â`.
 */
export function temTextoCorrompido(input: string | null | undefined): boolean {
  if (input == null || input === '') return false;
  const cps = [...input].map((ch) => ch.codePointAt(0) ?? 0);
  for (let i = 0; i < cps.length; i += 1) {
    const cp = cps[i] as number;
    if (cp === REPLACEMENT_CHAR) return true;
    const next = cps[i + 1];
    if (next != null && LEADS_MAL_LIDOS.has(cp) && ehContinuacaoMalLida(next)) return true;
  }
  return false;
}

/* ------------------------------- sanitisation ------------------------------- */

/** Characters SEFAZ rejects outright — dropped from the text. */
const RESTRICTED = new Set([...'@#%*$£§ªº©®™[]{}=+_|\\~^`']);

/**
 * Drop characters SEFAZ rejects. Control characters are removed; line breaks
 * and tabs become spaces; runs of spaces are collapsed. Apply `removerAcentos`
 * first. Does NOT escape XML — the serializer owns that.
 *
 * Also drops any codepoint outside the XSD `TString` permitted range —
 * `[!-ÿ]` = U+0021..U+00FF. "Smart typography" (em dash U+2014, en dash
 * U+2013, curly quotes U+2018..U+201D, ellipsis U+2026, …) all live
 * above U+00FF; marketplace exports routinely ship them and they fail
 * the XSD `pattern` facet at the pre-send gate, so we strip them here.
 * Diacritic-bearing Latin-1 chars (`ç`, `ã`, `É`, …) are still handled
 * by `removerAcentos` first, so they never reach this code path with
 * their accents intact.
 */
export function removerCharRestrito(input: string): string {
  let out = '';
  for (const ch of input) {
    if (ch === '\n' || ch === '\r' || ch === '\t') {
      out += ' ';
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f) continue;
    if (code > 0xff) continue;
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
 *
 * ⚠️ This does NOT detect a lost encoding round-trip — it launders one into
 * plausible ASCII. Gate the raw value with {@link temTextoCorrompido} first.
 */
export function sanitizeNFeText(input: string | null | undefined, maxLen?: number): string | null {
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
