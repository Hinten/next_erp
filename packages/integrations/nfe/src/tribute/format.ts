/**
 * SEFAZ-format numeric helpers.
 *
 * Every numeric value on the NF-e wire is a string with a fixed number of
 * decimals — SEFAZ rejects shapes that don't match its XSD facets. The
 * Flutter side does this with `.toStringAsFixed(N)` per field; these
 * helpers are the TypeScript equivalent, **each with its own test**, so
 * the per-field rounding rule lives in one place.
 *
 * Negative values are an upstream bug — we throw rather than silently
 * masking with `Math.max(0, n)`.
 */

function check(name: string, n: number, allowNull = false): number | null {
  if (n == null) {
    if (allowNull) return null;
    throw new TributeFormatError(`${name} is required (got null)`);
  }
  if (!Number.isFinite(n)) {
    throw new TributeFormatError(`${name} must be finite, got ${n}`);
  }
  if (n < 0) {
    throw new TributeFormatError(`${name} must be ≥ 0, got ${n}`);
  }
  return n;
}

export class TributeFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TributeFormatError';
  }
}

/** Format a monetary amount — 2 decimals. Used for vBC, vICMS, vProd, vNF, … */
export function fmtMoney(name: string, n: number): string {
  return (check(name, n) as number).toFixed(2);
}

/** Nullable variant — returns null when the input is null/undefined. */
export function fmtMoneyOpt(name: string, n: number | null | undefined): string | undefined {
  if (n == null) return undefined;
  return fmtMoney(name, n);
}

/** Format a percentage — 4 decimals (SEFAZ pattern for pICMS, pPIS, …). */
export function fmtRate(name: string, n: number): string {
  return (check(name, n) as number).toFixed(4);
}

export function fmtRateOpt(name: string, n: number | null | undefined): string | undefined {
  if (n == null) return undefined;
  return fmtRate(name, n);
}

/**
 * Format a quantity — 4 decimals (qCom, qTrib, and the PIS/COFINS `qBCProd`).
 * Also the formatter for the 4-decimal per-unit rates — PIS/COFINS
 * `vAliqProd` (`TDec_1104v`, at most 4 decimals) and IPI `vUnid`.
 */
export function fmtQuantity(name: string, n: number): string {
  return (check(name, n) as number).toFixed(4);
}

/**
 * Format a unit-price — 10 decimals. For `vUnCom` / `vUnTrib` ONLY: the
 * per-unit tax rates (`vAliqProd`, `vUnid`) allow at most 4 decimals, so a
 * 10-decimal string there fails the XSD — they go through `fmtQuantity`.
 */
export function fmtUnitValue(name: string, n: number): string {
  return (check(name, n) as number).toFixed(10);
}

export function fmtUnitValueOpt(name: string, n: number | null | undefined): string | undefined {
  if (n == null) return undefined;
  return fmtUnitValue(name, n);
}

/**
 * Canonical money rounding (2dp from the IEEE-754 double — byte-parity with
 * Dart's `duasCasasDecimais`), re-exported so the tribute module keeps a
 * single rounding import surface. See `@delfrance/core/money`.
 */
export { roundReais } from '@delfrance/core/money';
