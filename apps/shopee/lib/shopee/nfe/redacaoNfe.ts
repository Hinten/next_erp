/**
 * The ONE sanitizer for Shopee's free text on the NF-e path (#1522, step 14):
 * SEFAZ's pending reason and the detail of a refusal no classifier row
 * recognises. Its output is the ONLY form of Shopee text that may reach an
 * aviso, the handler's completion log or the CLI — never the raw string, which
 * can carry an access key, a CNPJ or CPF (numeric or alphanumeric) or an
 * order number. (An IP address is masked only when it carries ≥ 7 digits: an
 * IPv4 such as `34.95.1.2`, six digits, survives — our own egress address, not
 * personal data.)
 *
 * ## Three rules, because each alone leaks
 *
 * - **(a) digit groups** — every maximal run of digits joined by AT MOST ONE of
 *   `.` `/` `-` or a space between groups, whose DIGIT total is ≥ 7. It catches
 *   a key printed the way the DANFE prints it (eleven groups of four digits,
 *   each a harmless-looking token on its own) and a formatted CNPJ or CPF. A
 *   whitespace-token rule alone lets the DANFE-spaced key through.
 * - **(b) long tokens** — every whitespace token of ≥ 12 characters that
 *   carries ≥ 7 digits (letters or not), or that mixes letters with ≥ 2
 *   digits. The first arm catches a numeric key or CNPJ whose groups are joined
 *   by a character rule (a) does not join on (`,` `_` `|` `:` `–`), which
 *   rule (a) sees as short separate runs; the second catches an alphanumeric
 *   CNPJ, an order number shaped like `260910KJBHUJDM` (only six digits) and a
 *   key glued to a label. A digit-run rule alone lets all of them through.
 * - **(c) alphanumeric groups** — every maximal run of ≥ 3 groups joined by
 *   ONE space, `.`, `/` or `-`, each group 1–6 characters of `[0-9A-Za-z]`
 *   carrying ≥ 1 digit, whose DIGIT total is ≥ 7. It catches a DANFE-spaced key
 *   whose CNPJ is alphanumeric (`… 09ZZ 1ZZ2 ZZ3Z …`: rule (a) stops at every
 *   letter and every token is short) and a SPACED alphanumeric CNPJ (a
 *   formatted one with no space, `12.ABC.345/01DE-35`, is one long token and
 *   rule (b)'s). The one-digit-per-group demand is what keeps prose alive:
 *   without it `539 CFOP 5102` would read as one seven-digit identifier.
 *
 * Each match becomes `•••`. ⚠️ All three rules judge the SAME unmasked text and
 * the union of their spans is masked, so none can hide a match from another
 * (masking one first can shorten a token below another's threshold and leave a
 * fragment readable); the pass then repeats until nothing more matches.
 *
 * ⚠️ **Short numbers SURVIVE on purpose**: a cStat (`539`), a CFOP (`5102`) and
 * any run of up to six digits are what an operator needs to act on the reason,
 * and a mask that ate every number would erase the instruction along with the
 * identifier. The price is paid at the other edge: a date written with
 * separators (eight digits) is masked too.
 *
 * ## The accepted residue (measured, and pinned by the tests)
 *
 * - Groups joined by TWO characters — ` - `, `, `, `; ` — do not join under
 *   any rule, so a key printed `9926 - 0911 - …` leaves every four-digit group
 *   readable. Joining across two characters would also join `123 - 4567` and a
 *   list of short numbers, which is prose.
 * - A group with NO digit breaks rule (c)'s run: the bare alphanumeric root
 *   `12.ABC.345` (five digits) survives whole, and a spaced
 *   `12 ABC 345 01DE 35` keeps its leading `12 ABC` while the rest is masked.
 *
 * ## Order (each step's reason)
 *
 * 1. `null` / blank ⇒ `null`.
 * 2. Control (`\p{Cc}`) AND format (`\p{Cf}`) characters are DROPPED (not
 *    spaced): Shopee's page prints a TAB inside its own strings, and a
 *    zero-width space or a soft hyphen between digit groups is invisible to
 *    an operator yet splits every rule's run. Dropping can only glue — a
 *    longer token or a longer digit run — so it can never hide a match from
 *    the mask.
 * 3. Whitespace collapsed, trimmed.
 * 4. A leading `Wrong parameters, detail:` (case-insensitive, repeated) is
 *    stripped — the envelope most refusals share, which tells the operator
 *    nothing — and so are trailing periods (Shopee's own messages end in `..`).
 * 5. Masked, as above.
 * 6. Capped at `max` characters with `…` — AFTER masking, so a cut can never
 *    expose the first digits of a number the mask would have hidden whole.
 * 7. Masked AGAIN: the cut glues `…` to the last token, which can lift it to
 *    rule (b)'s twelve characters. Without this pass the output is not a
 *    fixpoint at the cap edge, and the aviso, the log line and the CLI — which
 *    each re-sanitize — could disagree. A mask only shrinks the text, so the
 *    result is still within `max`, and sanitizing it again changes nothing.
 *
 * Pure and total: no clock, no I/O, no Firestore.
 */
import { EXCERTO_SHOPEE_MAX } from './constantesNfe';

/** What a masked span becomes. */
const MASCARA = '•••';

/** What a capped text ends with. */
const RETICENCIAS = '…';

/** Rules (a), (b) and (c): the digit total at which a span is an identifier. */
const MIN_DIGITOS_DO_GRUPO = 7;

/** Rule (b): the length at which a token is an identifier. */
const MIN_CARACTERES_DO_TOKEN = 12;

/** Rule (b), second arm: the digits a long lettered token must carry. */
const MIN_DIGITOS_DO_TOKEN = 2;

const CONTROLE_E_FORMATO = /[\p{Cc}\p{Cf}]/gu;
const ESPACOS = /\s+/gu;
const PREFIXO_DO_ENVELOPE = /^(?:wrong parameters,\s*detail:\s*)+/iu;
const FIM_COM_PONTOS = /[.\s]+$/u;

/** Rule (a): digit groups, each joined to the next by exactly one separator. */
const GRUPO_DE_DIGITOS = /\p{Nd}+(?:[./ -]\p{Nd}+)*/gu;

/**
 * Rule (c): one group — 1–6 of `[0-9A-Za-z]` with a digit among them (the
 * lookahead reads letters then a digit, all inside the group, since a group
 * can only end at a separator or at a non-letter, non-digit character).
 */
const GRUPO_ALFANUMERICO = String.raw`(?=[A-Za-z]{0,5}[0-9])[0-9A-Za-z]{1,6}`;

/**
 * Rule (c): ≥ 3 such groups joined by one separator, bounded on both sides by
 * anything that is not a letter or a digit (so `não` or `12ã` never yields a
 * group).
 */
const GRUPOS_ALFANUMERICOS = new RegExp(
  String.raw`(?<![\p{L}\p{N}])${GRUPO_ALFANUMERICO}(?:[./ -]${GRUPO_ALFANUMERICO}){2,}(?![\p{L}\p{N}])`,
  'gu',
);

const TOKEN = /\S+/gu;
const DIGITO = /\p{Nd}/gu;
const LETRA = /\p{L}/u;

function contarDigitos(texto: string): number {
  return texto.match(DIGITO)?.length ?? 0;
}

/** Rule (b): a whitespace token long enough, and digit-heavy enough, to mask. */
function tokenEhIdentificador(token: string): boolean {
  if (Array.from(token).length < MIN_CARACTERES_DO_TOKEN) return false;
  const digitos = contarDigitos(token);
  return digitos >= MIN_DIGITOS_DO_GRUPO || (LETRA.test(token) && digitos >= MIN_DIGITOS_DO_TOKEN);
}

/**
 * Mark every span rule (a), (b) or (c) finds in `texto` — all over the SAME
 * string — and replace each maximal marked run with ONE mask.
 */
function mascararUmaVez(texto: string): string {
  const marcado = new Uint8Array(texto.length);
  const marcar = (inicio: number, fim: number): void => {
    marcado.fill(1, inicio, fim);
  };

  for (const m of texto.matchAll(GRUPO_DE_DIGITOS)) {
    if (contarDigitos(m[0]) >= MIN_DIGITOS_DO_GRUPO) marcar(m.index, m.index + m[0].length);
  }
  for (const m of texto.matchAll(TOKEN)) {
    if (tokenEhIdentificador(m[0])) marcar(m.index, m.index + m[0].length);
  }
  for (const m of texto.matchAll(GRUPOS_ALFANUMERICOS)) {
    if (contarDigitos(m[0]) >= MIN_DIGITOS_DO_GRUPO) marcar(m.index, m.index + m[0].length);
  }

  let saida = '';
  let i = 0;
  while (i < texto.length) {
    if (marcado[i] === 1) {
      saida += MASCARA;
      while (i < texto.length && marcado[i] === 1) i += 1;
      continue;
    }
    saida += texto[i];
    i += 1;
  }
  return saida;
}

/**
 * Repeat the mask until nothing more matches. Each pass that changes anything
 * makes the text strictly SHORTER (a mask is shorter than any span it
 * replaces — every rule's span has ≥ 7 characters), so the loop ends.
 */
function mascarar(texto: string): string {
  let atual = texto;
  for (;;) {
    const proximo = mascararUmaVez(atual);
    if (proximo === atual) return atual;
    atual = proximo;
  }
}

/** Cap at `max` code points, ending in `…` when anything was cut. */
function limitar(texto: string, max: number): string {
  const teto = Math.max(1, Math.floor(max));
  const pontos = Array.from(texto);
  if (pontos.length <= teto) return texto;
  return `${pontos
    .slice(0, teto - 1)
    .join('')
    .trimEnd()}${RETICENCIAS}`;
}

/**
 * Sanitize a Shopee free-text string for an operator (see the module header).
 *
 * @param raw the provider's text — SEFAZ's pending reason or a refusal's
 *   detail, verbatim; `null`/`undefined` accepted.
 * @param max the cap, in characters, applied after masking (default
 *   {@link EXCERTO_SHOPEE_MAX}).
 * @returns the masked, capped excerpt, or `null` when nothing readable is left.
 *   Idempotent: sanitizing the output again returns it unchanged.
 */
export function resumirTextoDaShopee(
  raw: string | null | undefined,
  max: number = EXCERTO_SHOPEE_MAX,
): string | null {
  if (raw === null || raw === undefined) return null;
  const limpo = raw
    .replace(CONTROLE_E_FORMATO, '')
    .replace(ESPACOS, ' ')
    .trim()
    .replace(PREFIXO_DO_ENVELOPE, '')
    .replace(FIM_COM_PONTOS, '')
    .trim();
  if (limpo === '') return null;
  return mascarar(limitar(mascarar(limpo), max));
}
