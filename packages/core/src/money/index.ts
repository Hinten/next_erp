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
 * decimals **from its IEEE-754 double representation** — `Number(n.toFixed(2))`.
 * This is deliberate byte-parity with the rounding already applied to every
 * reais value in the migrated corpus: Flutter's `duasCasasDecimais`
 * (`.old/packages/global/lib/src/mathExtensions.dart:4-6`,
 * `double.parse(x.toStringAsFixed(2))`) rounded them before the export, so a
 * re-computation here has to land on the same number or it silently disagrees
 * with what is stored. Both languages format the *actual*
 * double to 2 decimals and reparse, so a x.xx5 boundary rounds whichever way the
 * double sitting under it actually leans — NOT a textbook half-up rule. E.g.
 * `1.005→1.00`, `2.675→2.67`, `6.555→6.55` all round DOWN because the nearest
 * double to each is a hair below the tie (`1.00499999999999989…`,
 * `2.67499999999999982…`, `6.55499999999999972…`), while `24.015→24.02` rounds
 * UP because its double (`24.0150000000000005684…`) sits a hair above.
 *
 * Replaces the float-robust half-up implementation this helper used before
 * 2026-07-21 (string-shift + `Math.round`, which recovered the exact decimal and
 * rounded `6.555→6.56`/`1.005→1.01`) — that divergence from Dart was flagged as
 * deliberate at the time; the parity call has since been reversed. ⚠️ It buys
 * nothing from a RUNNING Flutter app — there is no dual run (root `CLAUDE.md`
 * rule 8) — only agreement with the values that app already rounded and the
 * migration carries over unchanged.
 *
 * Use this for every monetary CALCULATION (business + fiscal). Ad-hoc
 * `.toFixed(2)` / `Math.round(x*100)/100` are reserved for wire-string
 * serialization only (and are lint-forbidden elsewhere).
 */
export function roundReais(n: number): number {
  if (!Number.isFinite(n)) return n;
  const rounded = Number(n.toFixed(2));
  // `n.toFixed(2)` can format a tiny negative residual as `"-0.00"`; keep a
  // clean `+0` rather than let `-0` leak into currency display (`-R$ 0,00`).
  return rounded === 0 ? 0 : rounded;
}

/**
 * Format a reais amount as a localized BRL string (e.g. `6.5 → "R$ 6,50"`). The
 * ONE sanctioned reais→integer-cents conversion: it applies {@link roundReais}
 * first (so a stray 3rd decimal still displays rounded from the double,
 * `6.555 → "R$ 6,55"`), then scales to the integer minor units the {@link money}
 * constructor requires. Prefer this over hand-rolled
 * `format(money(Math.round(value * 100)))`.
 */
export function formatReais(reais: number, currency = 'BRL', locale = 'pt-BR'): string {
  return format(money(Math.round(roundReais(reais) * 100), currency), locale);
}
