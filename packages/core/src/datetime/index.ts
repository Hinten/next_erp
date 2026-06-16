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
 * ordering would need a higher-resolution clock source.
 */

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
 * (1e13 ms ≈ year 2286). The open gap `(MILLIS_UPPER_BOUND, MICROS_LOWER_BOUND)`
 * is unreachable by any plausible ERP timestamp in either unit, so a value
 * landing there is treated as undeterminable rather than guessed.
 */
export const MILLIS_UPPER_BOUND = 1e13;

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
 *   - an ISO-8601 string (legacy `pagamento`) → parsed, ×1000
 *   - a `Date` → ×1000
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
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms * 1000;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms * 1000;
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
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}
