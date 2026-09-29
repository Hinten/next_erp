/**
 * The ONE sanitizer for Shopee's free text on the NF-e path (#1522, step 14):
 * SEFAZ's pending reason and the detail of a refusal no classifier row
 * recognises. Its output is the ONLY form of Shopee text that may reach an
 * aviso, the handler's completion log or the CLI — never the raw string, which
 * can carry an access key, a CNPJ, an order number or an IP.
 *
 * ## Two rules, because each alone leaks
 *
 * - **(a) digit groups** — every maximal run of digits joined by AT MOST ONE of
 *   `.` `/` `-` or a space between groups, whose DIGIT total is ≥ 7. It catches
 *   a key printed the way the DANFE prints it (eleven groups of four digits,
 *   each a harmless-looking token on its own) and a formatted CNPJ or CPF. A
 *   whitespace-token rule alone lets the DANFE-spaced key through.
 * - **(b) mixed tokens** — every whitespace token of ≥ 12 characters that mixes
 *   letters and ≥ 2 digits. It catches an alphanumeric CNPJ, an order number
 *   shaped like `260910KJBHUJDM` (only six digits) and a key glued to a label.
 *   A digit-run rule alone lets both through.
 *
 * Each match becomes `•••`. ⚠️ Both rules judge the SAME unmasked text and the
 * union of their spans is masked, so neither can hide a match from the other
 * (masking one first can shorten a token below the other's threshold and leave
 * a fragment readable); the pass then repeats until nothing more matches, so
 * the output is a fixpoint and a second call changes nothing.
 *
 * ⚠️ **Short numbers SURVIVE on purpose**: a cStat (`539`), a CFOP (`5102`) and
 * any run of up to six digits are what an operator needs to act on the reason,
 * and a mask that ate every number would erase the instruction along with the
 * identifier. The price is paid at the other edge: a date written with
 * separators (eight digits) is masked too.
 *
 * ## Order (each step's reason)
 *
 * 1. `null` / blank ⇒ `null`.
 * 2. Control characters are DROPPED (not spaced): Shopee's page prints a TAB
 *    inside its own strings. Dropping can only glue — a longer token or a
 *    longer digit run — so it can never hide a match from the mask.
 * 3. Whitespace collapsed, trimmed.
 * 4. A leading `Wrong parameters, detail:` (case-insensitive) is stripped — the
 *    envelope most refusals share, which tells the operator nothing — and so
 *    are trailing periods (Shopee's own messages end in `..`).
 * 5. Masked, as above.
 * 6. Capped at `max` characters with `…` — AFTER masking, so a cut can never
 *    expose the first digits of a number the mask would have hidden whole.
 *
 * Pure and total: no clock, no I/O, no Firestore.
 */
import { EXCERTO_SHOPEE_MAX } from './constantesNfe';

/** What a masked span becomes. */
const MASCARA = '•••';

/** What a capped text ends with. */
const RETICENCIAS = '…';

/** Rule (a): the digit total at which a joined run is an identifier. */
const MIN_DIGITOS_DO_GRUPO = 7;

/** Rule (b): the length at which a mixed token is an identifier. */
const MIN_CARACTERES_DO_TOKEN = 12;

/** Rule (b): the digits a long token must carry to count as mixed. */
const MIN_DIGITOS_DO_TOKEN = 2;

const CONTROLE = /\p{Cc}/gu;
const ESPACOS = /\s+/gu;
const PREFIXO_DO_ENVELOPE = /^(?:wrong parameters,\s*detail:\s*)+/iu;
const FIM_COM_PONTOS = /[.\s]+$/u;

/** Rule (a): digit groups, each joined to the next by exactly one separator. */
const GRUPO_DE_DIGITOS = /\p{Nd}+(?:[./ -]\p{Nd}+)*/gu;
const TOKEN = /\S+/gu;
const DIGITO = /\p{Nd}/gu;
const LETRA = /\p{L}/u;

function contarDigitos(texto: string): number {
  return texto.match(DIGITO)?.length ?? 0;
}

/**
 * Mark every span rule (a) or rule (b) finds in `texto` — both over the SAME
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
    const token = m[0];
    if (
      Array.from(token).length >= MIN_CARACTERES_DO_TOKEN &&
      LETRA.test(token) &&
      contarDigitos(token) >= MIN_DIGITOS_DO_TOKEN
    ) {
      marcar(m.index, m.index + token.length);
    }
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
 * replaces), so the loop ends.
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
 */
export function resumirTextoDaShopee(
  raw: string | null | undefined,
  max: number = EXCERTO_SHOPEE_MAX,
): string | null {
  if (raw === null || raw === undefined) return null;
  const limpo = raw
    .replace(CONTROLE, '')
    .replace(ESPACOS, ' ')
    .trim()
    .replace(PREFIXO_DO_ENVELOPE, '')
    .replace(FIM_COM_PONTOS, '')
    .trim();
  if (limpo === '') return null;
  return limitar(mascarar(limpo), max);
}
