/**
 * Money is stored as integer minor units (cents) + ISO 4217 currency code.
 * Avoids floating-point pitfalls. All arithmetic stays in BigInt where needed.
 */
export interface Money {
  amount: number; // cents (or smallest unit for the currency)
  currency: string; // ISO 4217, e.g. 'BRL', 'USD'
}

export function money(amount: number, currency = 'BRL'): Money {
  if (!Number.isInteger(amount)) {
    throw new Error('Money.amount must be an integer (minor units).');
  }
  return { amount, currency };
}

export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`Cannot add ${a.currency} and ${b.currency}.`);
  }
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`Cannot subtract ${b.currency} from ${a.currency}.`);
  }
  return { amount: a.amount - b.amount, currency: a.currency };
}

export function format(value: Money, locale = 'pt-BR'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: value.currency,
  }).format(value.amount / 100);
}

/**
 * THE canonical money rounding for the whole codebase: round a reais amount to 2
 * decimals, **HALF UP, away from zero** (symmetric for credits/debits — the 3rd
 * decimal decides: 0–4 down, 5–9 up). Examples: `5.523→5.52`, `6.555→6.56`,
 * `6.739→6.74`, `1.005→1.01`, `2.675→2.68`, `-6.555→-6.56`.
 *
 * It is **float-robust** where the naive impls are not: both `n.toFixed(2)` and
 * `Math.round(n * 100) / 100` give `6.555→6.55`, because the IEEE-754 double
 * nearest to 6.555 is 6.55499…. Parsing the string `"6.555e2"` recovers the
 * intended exact `655.5` (decimal-literal scaling, not a binary multiply), so
 * `Math.round` then rounds it up to `656`. `abs`+`sign` makes it symmetric
 * (`Math.round` alone rounds .5 toward +∞, which would bias negatives).
 *
 * Use this for every monetary CALCULATION (business + fiscal). Ad-hoc
 * `.toFixed(2)` / `Math.round(x*100)/100` are reserved for wire-string
 * serialization only (and are lint-forbidden elsewhere).
 */
export function roundReais(n: number): number {
  if (!Number.isFinite(n)) return n;
  const sign = n < 0 ? -1 : 1;
  const shifted = Math.round(Number(`${Math.abs(n)}e2`));
  return sign * Number(`${shifted}e-2`);
}

/**
 * Format a reais amount as a localized BRL string (e.g. `6.5 → "R$ 6,50"`). The
 * ONE sanctioned reais→integer-cents conversion: it applies {@link roundReais}
 * first (so a stray 3rd decimal still displays half-up, `6.555 → "R$ 6,56"`),
 * then scales to the integer minor units the {@link money} constructor requires.
 * Prefer this over hand-rolled `format(money(Math.round(value * 100)))`.
 */
export function formatReais(reais: number, currency = 'BRL', locale = 'pt-BR'): string {
  return format(money(Math.round(roundReais(reais) * 100), currency), locale);
}
