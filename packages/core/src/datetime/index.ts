/**
 * Datetime fields are stored as a plain integer epoch — milliseconds or
 * microseconds since 1970-01-01T00:00:00Z — never a Firebase `Timestamp`.
 *
 * Rationale: every SDK (firebase-admin, the JS Web SDK, the legacy Flutter
 * client) deserializes a native `Timestamp` into a different shape, whereas a
 * plain integer reads back identically everywhere. Two precisions coexist:
 *
 *   - **milliseconds** (`MillisSinceEpoch`) — the legacy Flutter wire format,
 *     kept for `intFrete` / `tokenMelEnv` (the still-active freight integration
 *     reads them as Dart `int`).
 *   - **microseconds** (`MicrosSinceEpoch`) — the higher-precision format the
 *     `pedido` + `pagamento` models converge on (see
 *     `tools/migrations/pedido-pagamento-micros`).
 *
 * Safe-integer note: microseconds since epoch is ~1.78e15 today, well under
 * `Number.MAX_SAFE_INTEGER` (9.007e15 ≈ year 2255), so a plain `number` is
 * exact — no BigInt needed.
 *
 * Resolution note: `Date.now()` only has millisecond resolution, so
 * `nowMicros()` is `Date.now() * 1000` — microsecond UNITS at millisecond
 * PRECISION (the low three digits are always zero). True sub-millisecond
 * ordering would need a higher-resolution clock source. This applies to values
 * we STAMP; values we PARSE carry whatever precision the provider sent (see
 * `parseIsoToMicros`).
 *
 * Timezone policy: nothing here reads the ambient process timezone. An epoch
 * integer is absolute and zone-free, and the one input that could be ambiguous
 * — an ISO string with no offset — is resolved as explicit UTC rather than as
 * host-local time. That matters because `apps/nfe` runs with
 * `TZ=America/Sao_Paulo` while every other backend is UTC, so the old
 * `Date.parse` path resolved the same offset-less payload three hours apart
 * depending on which service parsed it.
 */
import { Temporal } from 'temporal-polyfill';

/** Milliseconds since the Unix epoch (UTC). */
export type MillisSinceEpoch = number;
/** Microseconds since the Unix epoch (UTC). */
export type MicrosSinceEpoch = number;

/**
 * A stored numeric epoch at or above this is treated as microseconds
 * (1e14 µs ≈ 1973). Any real microsecond timestamp far exceeds it (now ≈
 * 1.78e15); no real millisecond timestamp reaches it (now ≈ 1.78e12).
 */
export const MICROS_LOWER_BOUND = 1e14;
/**
 * A stored numeric epoch at or below this is treated as milliseconds
 * (9e12 ms ≈ year 2255). Capped so that scaling a millisecond value up to
 * microseconds (`× 1000` = 9e15) stays below `Number.MAX_SAFE_INTEGER`
 * (≈ 9.007e15) — a larger "ms" value would lose precision on conversion, so it
 * is treated as undeterminable instead of silently scaled. The open gap
 * `(MILLIS_UPPER_BOUND, MICROS_LOWER_BOUND)` is unreachable by any plausible
 * ERP timestamp in either unit.
 */
export const MILLIS_UPPER_BOUND = 9e12;

/* --------------------------------- now ----------------------------------- */

export function nowMillis(): MillisSinceEpoch {
  return Date.now();
}

/** See the resolution note above: millisecond precision in microsecond units. */
export function nowMicros(): MicrosSinceEpoch {
  return Date.now() * 1000;
}

/* ----------------------------- unit conversions -------------------------- */

export function millisToMicros(ms: MillisSinceEpoch): MicrosSinceEpoch {
  return ms * 1000;
}

export function microsToMillis(us: MicrosSinceEpoch): MillisSinceEpoch {
  return Math.trunc(us / 1000);
}

/* ------------------------------- ISO parsing ----------------------------- */

/**
 * Resolve an ISO-8601 / RFC 9557 string to nanoseconds since epoch, or `null`.
 *
 * Two ordered attempts, and **the order is load-bearing**:
 *
 *  1. `Temporal.Instant.from` — the string names an absolute instant because it
 *     carries `Z` or an explicit offset. This is the only branch that may read
 *     an offset, and it is tried first for exactly that reason:
 *     `PlainDateTime.from('…T09:00:00-03:00')` *succeeds* and silently DISCARDS
 *     the `-03:00`, yielding an instant three hours wrong. Reversing these two
 *     blocks is therefore a silent data corruption, not a style choice.
 *  2. `PlainDateTime → UTC` — no offset (Django REST Framework with
 *     `USE_TZ=False` emits exactly this), or a date-only string. Resolved as
 *     **explicit UTC**, never host-local; see the timezone note in the module
 *     docblock.
 *
 * Why Temporal rather than `Date.parse`: `Date.parse` returns milliseconds, so
 * every digit finer than a millisecond was destroyed at the boundary — and
 * `coerceToMicros` then multiplied by 1000, refilling them with zeros and
 * making the loss invisible. Providers do send microseconds: DRF's
 * `isoformat()` emits up to 6 fractional digits from a Postgres microsecond
 * column, and OMITS the fraction entirely when it is zero. Truncating them
 * collapses two updates less than a millisecond apart onto byte-identical
 * stamps, at which point a freshness guard cannot order them and the stale
 * payload can win.
 *
 * Temporal handles the fiddly parts per spec, so none of them are ours to get
 * wrong: fractions are right-padded (`.5` → 500000µs, not 5), over-long
 * fractions TRUNCATE rather than round (`.1234999` → `123499`), and the comma
 * decimal separator is accepted (`Date.parse` returns `NaN` for it).
 *
 * ⚠️ Deliberately NARROWER than `Date.parse` in one respect: non-ISO human
 * formats (`'June 16, 2026'`) now return `null` instead of a parsed instant.
 * That is correct for a function documented as reading ISO-8601, and no
 * provider in this repo sends them — but it is a behaviour change.
 */
function parseIsoInstantNs(value: string): bigint | null {
  try {
    return Temporal.Instant.from(value).epochNanoseconds;
  } catch (err) {
    // A RangeError means "not an absolute instant" — fall through to (2). Any
    // other error is a real fault and must not be swallowed.
    if (!(err instanceof RangeError)) throw err;
  }
  try {
    return Temporal.PlainDateTime.from(value).toZonedDateTime('UTC').toInstant().epochNanoseconds;
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    return null;
  }
}

/**
 * Nanoseconds → a safe integer in the target unit, or `null` when the instant
 * is too far from the epoch to represent exactly. Returning `null` beats
 * returning a lossy number: a value that cannot survive its own round-trip is
 * worse than an absent one.
 *
 * BigInt division is exact and truncates toward zero, so pre-epoch instants
 * come out right by construction — `1969-12-31T23:59:59.5Z` is `-500_000`µs,
 * not the `-1_000_500_000` that naïve signed arithmetic on a truncated second
 * plus a positive fraction produces.
 */
function nsToUnit(ns: bigint | null, perUnit: bigint): number | null {
  if (ns === null) return null;
  const value = Number(ns / perUnit);
  return Number.isSafeInteger(value) ? value : null;
}

/** Parse an ISO-8601 string to microseconds since epoch, keeping every digit the source sent. */
export function parseIsoToMicros(value: string): MicrosSinceEpoch | null {
  return nsToUnit(parseIsoInstantNs(value), 1_000n);
}

/** Parse an ISO-8601 string to milliseconds since epoch. Sub-millisecond digits truncate. */
export function parseIsoToMillis(value: string): MillisSinceEpoch | null {
  return nsToUnit(parseIsoInstantNs(value), 1_000_000n);
}

/* ------------------------------ Date interop ----------------------------- */

export function millisToDate(ms: MillisSinceEpoch): Date {
  return new Date(ms);
}

export function microsToDate(us: MicrosSinceEpoch): Date {
  return new Date(microsToMillis(us));
}

export function dateToMillis(d: Date): MillisSinceEpoch {
  return d.getTime();
}

export function dateToMicros(d: Date): MicrosSinceEpoch {
  return d.getTime() * 1000;
}

/* --------------------------- tolerant coercion --------------------------- */

/**
 * Normalize a heterogeneous stored value to microseconds since epoch.
 *
 * Accepts every format these fields have ever held:
 *   - a microsecond number (≥ `MICROS_LOWER_BOUND`) → returned unchanged
 *   - a millisecond number (≤ `MILLIS_UPPER_BOUND`) → ×1000
 *   - an ISO-8601 string (legacy `pagamento`, and every provider payload) →
 *     parsed at FULL precision via `parseIsoToMicros`; sub-millisecond digits
 *     the source sent are preserved rather than truncated and zero-filled
 *   - a `Date` → ×1000 (a `Date` holds only milliseconds, so this is exact)
 *
 * Returns `null` for null/undefined, an unparseable value, or a number in the
 * undeterminable gap — callers decide whether `null` means "leave as-is"
 * (the backfill migration) or "let validation reject it" (the Zod preprocess
 * in `@delfrance/schemas`). This is the single definition of "what is
 * microseconds" shared by the `microsSinceEpoch()` builder and the migration.
 */
export function coerceToMicros(value: unknown): MicrosSinceEpoch | null {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (value >= MICROS_LOWER_BOUND) return Math.trunc(value);
    if (value <= MILLIS_UPPER_BOUND) return Math.trunc(value) * 1000;
    return null; // undeterminable gap — never guess
  }
  if (typeof value === 'string') {
    // Full-precision: the string may carry microseconds, and they survive.
    return parseIsoToMicros(value);
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) return null;
    const us = ms * 1000;
    // A `Date` only ever holds milliseconds, so nothing is lost here — but a
    // far-future one still overflows on the ×1000, the same hole the number
    // branch closes above.
    return Number.isSafeInteger(us) ? us : null;
  }
  return null;
}

/**
 * Normalize a heterogeneous stored value to milliseconds since epoch — the
 * mirror of `coerceToMicros`. Accepts ms numbers (unchanged), µs numbers
 * (÷1000), ISO strings, and `Date`s. Same `null` semantics.
 */
export function coerceToMillis(value: unknown): MillisSinceEpoch | null {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (value <= MILLIS_UPPER_BOUND) return Math.trunc(value);
    if (value >= MICROS_LOWER_BOUND) return microsToMillis(value);
    return null;
  }
  if (typeof value === 'string') {
    return parseIsoToMillis(value);
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}
