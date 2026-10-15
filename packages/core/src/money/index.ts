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
  return format(money(centavosDeReais(reais), currency), locale);
}

/**
 * Reais → integer minor units (cents), applying {@link roundReais} first.
 *
 * The same conversion {@link formatReais} performs, exported because callers
 * increasingly need the NUMBER rather than the formatted string: a payment
 * gateway payload, a provider that prices in centavos, a comparison against a
 * stored integer.
 *
 * ⚠️ It is NOT what a marketplace channel needs. The removed
 * `MarketplaceChannel` contract typed its money as integer centavos
 * (`MinorUnits`), and that is precisely why `pushPrice`/`pushStock` went
 * unused for the whole Mercado Livre port: the produto price tables and every
 * Brazilian marketplace wire speak reais floats, so the conversion had no
 * correct place to happen. `@delfrance/core/marketplace` is reais throughout
 * — see ADR 0015.
 *
 * ⚠️ Exists so those callers do not hand-roll `Math.round(x * 100)`, which
 * `delfrance/no-ad-hoc-money-rounding` forbids for a real reason: skipping
 * {@link roundReais} makes a stray third decimal round differently from every
 * other total in the ERP, and the divergence only shows at the x.xx5 edges
 * where it is hardest to notice.
 */
export function centavosDeReais(reais: number): number {
  return Math.round(roundReais(reais) * 100);
}

/**
 * Upper bound on the number of parts {@link ratearReais} / {@link cotaExataReais}
 * will split a total into. It is the ceiling of a Mercado Pago payment link's
 * `quantidadeMaxima` (a shared link paid N times) and of the per-person links of
 * one "vaquinha" — a bigger `partes` is a caller bug, not a request, so it throws
 * instead of quietly producing a thousand one-cent payments.
 */
const PARTES_MAXIMAS_RATEIO = 50;

/**
 * Shared input guard of {@link ratearReais} and {@link cotaExataReais}; returns the
 * total in integer cents so neither has to re-derive it.
 *
 * Every rejection is a `RangeError`, never a `NaN`-poisoned result: `roundReais`
 * passes a non-finite value through UNCHANGED, so `ratearReais(NaN, 3)` would
 * otherwise return `[NaN, NaN, NaN]` and `NaN` would travel into a payment payload
 * (`Math.floor(NaN / 3)` is `NaN`, and `NaN < 0` is `false` — the classic guard
 * that never fires).
 */
function centavosParaRateio(total: number, partes: number): number {
  if (!Number.isFinite(total) || total < 0) {
    throw new RangeError(`total must be a finite amount >= 0 (got ${String(total)}).`);
  }
  if (!Number.isInteger(partes) || partes < 1 || partes > PARTES_MAXIMAS_RATEIO) {
    throw new RangeError(
      `partes must be an integer between 1 and ${PARTES_MAXIMAS_RATEIO} (got ${String(partes)}).`,
    );
  }
  const centavos = centavosDeReais(total);
  if (!Number.isSafeInteger(centavos)) {
    throw new RangeError(`total is too large to split exactly (got ${String(total)}).`);
  }
  return centavos;
}

/**
 * Split `total` reais into `partes` amounts that sum EXACTLY to it: integer cents,
 * largest-remainder with equal weights — every part gets `floor(cents / partes)`
 * and the first `cents mod partes` parts get one extra cent, so the parts differ by
 * at most R$ 0,01 and come out in non-increasing order (`100, 3` →
 * `[33.34, 33.33, 33.33]`).
 *
 * The total is taken through {@link centavosDeReais} first, so the parts sum to
 * `roundReais(total)` — `6.555` is split as `6.55`. Compare the parts in integer
 * cents (`centavosDeReais`), never by summing the floats: `0.1 + 0.2 !== 0.3`.
 *
 * ⚠️ Deliberately NOT what `buildChequeSplitPagamentos` does (`apps/web/app/(app)/
 * pedidos/_components/PagamentoForm.ts`): that one rounds `total / n` for every row
 * and does not redistribute the remainder, which is right for a cheque schedule the
 * operator can edit row by row. A payment link cannot be edited by the payer, and a
 * pedido settles only when the payments' sum reaches its total
 * (`nextPedidoEstado`: Σ ≥ `valorCobrado`) — so `100 / 3` paid as three
 * `33.33`s sums to `99.99`, never reaches `pago`, and leaves the last cent
 * unpayable. Here the sum is exact.
 *
 * May return `0` parts when `total` is under `partes` cents (`0.02, 3` →
 * `[0.01, 0.01, 0]`); a caller that turns each part into a charge must enforce its
 * own R$ 0,01 minimum.
 *
 * @throws RangeError when `total` is not finite or is negative, or when `partes`
 *   is not an integer between 1 and 50.
 */
export function ratearReais(total: number, partes: number): number[] {
  const centavos = centavosParaRateio(total, partes);
  const base = Math.floor(centavos / partes);
  const resto = centavos - base * partes;
  return Array.from({ length: partes }, (_, i) => (base + (i < resto ? 1 : 0)) / 100);
}

/**
 * The amount each of `partes` EQUAL payments must have for them to add up to
 * exactly `total`, or `null` when no such amount exists — that is, when the total in
 * cents is not divisible by `partes` (`99, 3` → `33`; `100, 3` → `null`).
 *
 * Exists for the SHARED payment link: one link paid `partes` times, every payment
 * the same amount, so the operator cannot give the last payer the odd cent the way
 * {@link ratearReais} does. Rounding the per-payment amount UP (`100, 3` → `33.34`)
 * would collect `100.02` and overpay the pedido by R$ 0,02, and any overpayment
 * blocks NF-e emission (cStat 866): a Mercado Pago payment is never `tPag 01`
 * (dinheiro), so the document may carry no troco. So the shared mode is offered only
 * for totals that divide exactly, and the caller falls back to per-person links (or
 * to `partes - 1` shared payments plus one individual link for the remainder).
 *
 * @throws RangeError under the same conditions as {@link ratearReais}.
 */
export function cotaExataReais(total: number, partes: number): number | null {
  const centavos = centavosParaRateio(total, partes);
  return centavos % partes === 0 ? centavos / partes / 100 : null;
}
