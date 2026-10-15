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

/* ---------------------- civil time in an explicit zone --------------------- */

/*
 * Everything below takes the IANA zone as a PARAMETER and never reads the ambient
 * process timezone (see the timezone policy in the module docblock).
 * `@delfrance/core` cannot import the ERP's fiscal-zone constant (`FUSO_FISCAL`, in
 * `@delfrance/schemas`), so the caller passes it. A bad zone id makes Temporal throw
 * a `RangeError` — a programming error, deliberately NOT swallowed here; only a
 * malformed civil DATE, which is user input, becomes `null`.
 */

/** A civil date exactly as `Temporal.PlainDate.toString()` prints it: `YYYY-MM-DD`. */
const DATA_CIVIL_ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a strict `YYYY-MM-DD` civil date, or `null` when it is not one.
 *
 * The regex comes FIRST because `Temporal.PlainDate.from` also accepts a full
 * date-time string — `'2026-09-30T10:00:00'` parses and silently drops the time —
 * and a loose `'2026-9-30'` must not be read as a date either. An impossible day
 * (`2026-02-30`) is rejected by the ISO parser; `overflow: 'reject'` states that
 * intent outright, so a later switch to field-based construction cannot turn it into
 * the clamp to the last day of the month that the default `'constrain'` performs.
 * Only the `RangeError` Temporal raises for "not a valid date" is caught; anything
 * else is a real fault and propagates.
 */
function parsePlainDate(dataCivil: string): Temporal.PlainDate | null {
  if (!DATA_CIVIL_ISO.test(dataCivil)) return null;
  try {
    return Temporal.PlainDate.from(dataCivil, { overflow: 'reject' });
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    return null;
  }
}

/**
 * Format an instant as an ISO-8601 string in `timeZone` WITH its UTC offset and
 * millisecond precision: `YYYY-MM-DDTHH:mm:ss.SSS±HH:MM` — never `Z`, and never
 * with a bracketed zone annotation. This is the shape Mercado Pago's Checkout Pro
 * documents for `expiration_date_to` (`2026-09-29T23:59:59.000-03:00`).
 *
 * The offset is the zone's offset AT THAT INSTANT, not a constant: Brazil observed
 * daylight saving until 2019, so `2018-12-01` is `-02:00` and `2018-06-01` is
 * `-03:00`. Hard-coding `-03:00` would put every summer-2018 deadline an hour off.
 *
 * @throws RangeError when `ms` is not an integer in Temporal's range or `timeZone`
 *   is not a known IANA zone id.
 */
export function formatIsoNoFuso(ms: MillisSinceEpoch, timeZone: string): string {
  const zoned = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(timeZone);
  return zoned.toString({ timeZoneName: 'never', fractionalSecondDigits: 3 });
}

/**
 * The instant, as epoch milliseconds, of `23:59:59.000` on the civil day
 * `dataCivil` (`YYYY-MM-DD`) in `timeZone` — the "valid until the end of that day"
 * deadline of a payment link. `null` when `dataCivil` is not a real calendar date
 * in exactly that shape (`'2026-02-30'`, `'2026-9-30'`, `''`).
 *
 * Deliberately `23:59:59`, not `24:00:00` / the next midnight: the deadline must
 * still read as the SAME civil day when it is turned back into a date
 * ({@link dataCivilNoFuso}) or printed ({@link formatIsoNoFuso}). When the zone's
 * clock repeats that wall time (a fall-back at midnight), the EARLIER occurrence is
 * returned — Temporal's default `'compatible'` disambiguation — so the deadline is
 * never later than the operator's day.
 *
 * @throws RangeError when `timeZone` is not a known IANA zone id.
 */
export function fimDoDiaNoFuso(dataCivil: string, timeZone: string): MillisSinceEpoch | null {
  const data = parsePlainDate(dataCivil);
  if (data === null) return null;
  const fim = data.toPlainDateTime({ hour: 23, minute: 59, second: 59 });
  return fim.toZonedDateTime(timeZone).epochMilliseconds;
}

/**
 * The civil date (`YYYY-MM-DD`) an instant falls on in `timeZone`. The same instant
 * is a different day in different zones — `2026-09-28T02:30Z` is the 28th in UTC and
 * still the 27th in São Paulo — which is exactly why a bare `toISOString().slice(0,
 * 10)` shows the operator the wrong day for any evening deadline.
 *
 * @throws RangeError when `ms` is not an integer in Temporal's range or `timeZone`
 *   is not a known IANA zone id.
 */
export function dataCivilNoFuso(ms: MillisSinceEpoch, timeZone: string): string {
  const zoned = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(timeZone);
  return zoned.toPlainDate().toString();
}

/**
 * Calendar arithmetic on a civil date: `dataCivil` (`YYYY-MM-DD`) plus `dias` days
 * (negative subtracts), as `YYYY-MM-DD`. Whole calendar days — there is no zone, so
 * no daylight-saving day is ever 23 or 25 hours long here.
 *
 * `null` when `dataCivil` is malformed or not a real date, and also when the sum
 * cannot be represented (`dias` not an integer, or a result outside Temporal's
 * range) — a caller feeding it a form value gets `null` to render, not an exception.
 */
export function somarDiasCivis(dataCivil: string, dias: number): string | null {
  const data = parsePlainDate(dataCivil);
  if (data === null) return null;
  try {
    return data.add({ days: dias }).toString();
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    return null;
  }
}
