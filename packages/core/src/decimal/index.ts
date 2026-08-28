/**
 * pt-BR decimal STRINGS — the separator, and nothing else.
 *
 * Deliberately NOT in the root barrel. `@delfrance/core/money` is what sits
 * there, and a decimal-string coercer beside `formatReais` invites exactly the
 * confusion `@delfrance/core/wire` already warns about: a provider WIRE decimal
 * is always dot-separated and must stay that way, while the strings here are
 * what a Brazilian operator types and reads. They are different vocabularies
 * that happen to look alike.
 *
 * The one production consumer is the Mercado Livre size-chart grid, where a
 * measurement is stored as a STRING (ML's own shape) rather than a number — so
 * `DecimalInput` / `parseDecimalInput` from `@delfrance/ui`, which parse to
 * `number | null`, are the wrong tool: they would drop the distinction between
 * `'10,5'` and `'10,50'`, and ML echoes the value back verbatim on the anúncio.
 */

/**
 * A plain decimal written with a DOT and one or two fractional digits, and
 * nothing else in the string.
 *
 * ⚠️ Three or more fractional digits are excluded on purpose: `'1.234'` is
 * equally readable as a thousands group, and no garment measurement carries
 * that precision — so a string shaped like that is not a measurement, and
 * guessing at it would invent data. Same bound the comma direction uses.
 */
const DOT_DECIMAL = /^\s*[+-]?\d+\.\d{1,2}\s*$/;

/** A decimal written with either separator, and nothing else in the string. */
const PLAIN_DECIMAL = /^\s*[+-]?\d+(?:[.,]\d+)?\s*$/;

/**
 * `'10.5'` → `'10,5'`. Anything that is not a bare dot-decimal comes back
 * untouched — a unit suffix, prose, an already-localized value, an ambiguous
 * thousands form (`'1.234,5'`, which holds both separators).
 *
 * This runs on the model's answer AND on the operator's keystrokes, so the
 * "untouched" half is load-bearing: a stricter-than-necessary rule leaves a dot
 * on screen, while a looser one turns `'aprox. 50'` into `'aprox, 50'`.
 */
export function localizarDecimal(text: string): string {
  // Exactly one dot by construction, so the first replacement is the only one.
  return DOT_DECIMAL.test(text) ? text.replace('.', ',') : text;
}

/**
 * `'10,5'` and `'10.5'` → `10.5`; null when the string is not a bare decimal.
 *
 * Null for `'1.234,5'` too: two separators is the ambiguous case this module
 * refuses to resolve, and returning a confident number there would be worse
 * than returning nothing.
 */
export function parseDecimalPtBr(text: string): number | null {
  if (!PLAIN_DECIMAL.test(text)) return null;
  const n = Number(text.trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** A decimal of AT MOST two fractional digits, split for exact conversion. */
const CENTESIMOS = /^\s*([+-]?)(\d+)(?:[.,](\d{1,2}))?\s*$/;

/**
 * `'10,5'` → `1050`, `'50'` → `5000`; null when the string is not a decimal of
 * at most two fractional digits.
 *
 * ⚠️ Hundredths as an INTEGER, and parsed digit-wise rather than through
 * `Math.round(n * 100)`. Its caller walks `+1` at a time to clear Mercado
 * Livre's duplicate rule, and in binary floating point `50 + 0.01 + 0.01` is
 * `50.019999999999996` — a set keyed on that misses `50.02` and the walk never
 * terminates on the value it just placed.
 *
 * ⚠️ Three or more fractional digits are null, not rounded. `'10,125'` is
 * outside the precision this reasons in, and silently reading it as `10,13`
 * would edit a measurement in order to compare it. Such a cell is simply not
 * offset, and ML's own validation stays the authority on it.
 */
export function parseCentesimos(text: string): number | null {
  const m = CENTESIMOS.exec(text);
  if (m == null) return null;
  const inteiro = Number(m[2]);
  const fracao = Number((m[3] ?? '').padEnd(2, '0'));
  const total = inteiro * 100 + fracao;
  if (!Number.isSafeInteger(total)) return null;
  return m[1] === '-' ? -total : total;
}

/**
 * `1051` → `'10,51'`, `1050` → `'10,5'`, `5000` → `'50'` — the fewest decimals
 * that say it, in the pt-BR spelling the grid uses everywhere else.
 */
export function formatarCentesimos(centesimos: number): string {
  const sinal = centesimos < 0 ? '-' : '';
  const abs = Math.abs(centesimos);
  const inteiro = Math.trunc(abs / 100);
  const resto = abs % 100;
  if (resto === 0) return `${sinal}${String(inteiro)}`;
  if (resto % 10 === 0) return `${sinal}${String(inteiro)},${String(resto / 10)}`;
  return `${sinal}${String(inteiro)},${String(resto).padStart(2, '0')}`;
}
