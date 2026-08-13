import { describe, expect, it } from 'vitest';
import {
  MICROS_LOWER_BOUND,
  MILLIS_UPPER_BOUND,
  coerceToMicros,
  coerceToMillis,
  dateToMicros,
  dateToMillis,
  microsToDate,
  microsToMillis,
  millisToDate,
  millisToMicros,
  nowMicros,
  nowMillis,
} from './index';

describe('now*', () => {
  it('nowMillis ≈ Date.now()', () => {
    expect(Math.abs(nowMillis() - Date.now())).toBeLessThan(50);
  });

  it('nowMicros is millisecond precision in microsecond units', () => {
    const us = nowMicros();
    expect(us % 1000).toBe(0); // low three digits always zero
    expect(Math.abs(microsToMillis(us) - Date.now())).toBeLessThan(50);
  });
});

describe('unit conversions', () => {
  it('millisToMicros / microsToMillis round-trip', () => {
    expect(millisToMicros(1_700_000_000_000)).toBe(1_700_000_000_000_000);
    expect(microsToMillis(1_700_000_000_000_000)).toBe(1_700_000_000_000);
  });

  it('microsToMillis truncates sub-millisecond digits', () => {
    expect(microsToMillis(1_700_000_000_000_999)).toBe(1_700_000_000_000);
  });
});

describe('Date interop', () => {
  it('round-trips through a Date in both units', () => {
    const d = new Date('2026-06-16T12:00:00.000Z');
    expect(dateToMillis(d)).toBe(d.getTime());
    expect(dateToMicros(d)).toBe(d.getTime() * 1000);
    expect(millisToDate(d.getTime()).getTime()).toBe(d.getTime());
    expect(microsToDate(d.getTime() * 1000).getTime()).toBe(d.getTime());
  });
});

describe('coerceToMicros', () => {
  const ms = 1_700_000_000_000; // ~2023 — a real millisecond timestamp
  const us = ms * 1000;

  it('scales a millisecond number to microseconds', () => {
    expect(coerceToMicros(ms)).toBe(us);
  });

  it('leaves a microsecond number unchanged (idempotent re-run)', () => {
    expect(coerceToMicros(us)).toBe(us);
  });

  // NOTE: asserted against LITERAL microsecond values, never `Date.parse(iso) * 1000`.
  // That expectation form is a tautology — it restates the very truncation this
  // parser exists to avoid, so it would keep passing if the bug came back.
  it('parses an ISO-8601 string (legacy pagamento)', () => {
    expect(coerceToMicros('2026-06-16T12:00:00.000Z')).toBe(1_781_611_200_000_000);
  });

  it('reads a Date', () => {
    const d = new Date('2026-06-16T12:00:00.000Z');
    expect(coerceToMicros(d)).toBe(d.getTime() * 1000);
  });

  it('returns null for null / undefined / NaN / garbage / dead-zone / object', () => {
    expect(coerceToMicros(null)).toBeNull();
    expect(coerceToMicros(undefined)).toBeNull();
    expect(coerceToMicros(Number.NaN)).toBeNull();
    expect(coerceToMicros('not a date')).toBeNull();
    expect(coerceToMicros(5e13)).toBeNull(); // between the two bounds — undeterminable
    expect(coerceToMicros({})).toBeNull();
  });
});

describe('coerceToMillis', () => {
  const ms = 1_700_000_000_000;
  const us = ms * 1000;

  it('leaves a millisecond number unchanged', () => {
    expect(coerceToMillis(ms)).toBe(ms);
  });

  it('scales a microsecond number down to milliseconds', () => {
    expect(coerceToMillis(us)).toBe(ms);
  });

  it('parses ISO strings and Dates', () => {
    expect(coerceToMillis('2026-06-16T12:00:00.000Z')).toBe(1_781_611_200_000);
    expect(coerceToMillis(new Date('2026-06-16T12:00:00.000Z'))).toBe(1_781_611_200_000);
  });

  it('truncates sub-millisecond digits rather than rounding them up', () => {
    expect(coerceToMillis('2026-06-16T12:00:00.999999Z')).toBe(1_781_611_200_999);
  });

  it('returns null in the undeterminable gap', () => {
    expect(coerceToMillis(5e13)).toBeNull();
  });
});

/**
 * The regression suite for the Loja Integrada stale-overwrite defect.
 *
 * `Date.parse` returns milliseconds, so a provider's sub-millisecond digits were
 * destroyed at the boundary and `coerceToMicros` then refilled them with zeros —
 * making the loss invisible. Two order updates less than a millisecond apart
 * collapsed onto byte-identical stamps, a freshness guard could not order them,
 * and the stale payload won.
 *
 * Every literal below is an absolute instant, so these assertions are
 * independent of the host timezone (`apps/nfe` runs TZ=America/Sao_Paulo while
 * every other backend is UTC).
 */
describe('ISO parsing keeps the precision the provider sent', () => {
  const NOON_UTC_US = 1_781_611_200_000_000; // 2026-06-16T12:00:00Z

  it('preserves microseconds — the defect this parser exists to fix', () => {
    expect(coerceToMicros('2026-06-16T12:00:00.123456Z')).toBe(NOON_UTC_US + 123_456);
  });

  it('right-pads a short fraction (.5 is 500000µs, not 5µs)', () => {
    expect(coerceToMicros('2026-06-16T12:00:00.5Z')).toBe(NOON_UTC_US + 500_000);
    expect(coerceToMicros('2026-06-16T12:00:00.12Z')).toBe(NOON_UTC_US + 120_000);
  });

  it('omits the fraction entirely when it is zero (DRF isoformat does this)', () => {
    expect(coerceToMicros('2026-06-16T12:00:00Z')).toBe(NOON_UTC_US);
  });

  it('truncates finer-than-microsecond digits rather than rounding', () => {
    // A rounding implementation would give …123500 here. That is the discriminator.
    expect(coerceToMicros('2026-06-16T12:00:00.1234999Z')).toBe(NOON_UTC_US + 123_499);
    expect(coerceToMicros('2026-06-16T12:00:00.123456789Z')).toBe(NOON_UTC_US + 123_456);
  });

  it('accepts the ISO comma decimal separator (Date.parse returns NaN for it)', () => {
    expect(Number.isNaN(Date.parse('2026-06-16T12:00:00,123456Z'))).toBe(true);
    expect(coerceToMicros('2026-06-16T12:00:00,123456Z')).toBe(NOON_UTC_US + 123_456);
  });

  it('honours an explicit offset — and does NOT silently discard it', () => {
    // Guards the ordering inside parseIsoInstantNs: PlainDateTime.from() SUCCEEDS
    // on this string while ignoring the -03:00, which would land the instant three
    // hours early. Instant.from() must therefore be attempted first.
    expect(coerceToMicros('2026-06-16T09:00:00.123456-03:00')).toBe(NOON_UTC_US + 123_456);
    expect(coerceToMicros('2026-06-16T09:00:00.123456-0300')).toBe(NOON_UTC_US + 123_456);
  });

  it('resolves an offset-less string as UTC, never as host-local time', () => {
    // Django REST Framework with USE_TZ=False emits exactly this shape. The old
    // Date.parse path read it in the process timezone, so the same payload landed
    // three hours apart in apps/nfe (TZ=America/Sao_Paulo) versus every other
    // backend. Asserting equality with the Z form pins the host-independence.
    expect(coerceToMicros('2026-06-16T12:00:00')).toBe(NOON_UTC_US);
    expect(coerceToMicros('2026-06-16T12:00:00.123456')).toBe(NOON_UTC_US + 123_456);
  });

  it('reads a date-only string as UTC midnight (unchanged from Date.parse)', () => {
    expect(coerceToMicros('2026-06-16')).toBe(1_781_568_000_000_000);
  });

  it('gets pre-epoch instants right (the fraction is not a negative offset)', () => {
    // Naïve arithmetic — truncated second plus a positive fraction — yields
    // -1_000_500_000 here. BigInt division on epochNanoseconds cannot make that mistake.
    expect(coerceToMicros('1969-12-31T23:59:59.5Z')).toBe(-500_000);
    expect(coerceToMillis('1969-12-31T23:59:59.5Z')).toBe(-500);
  });

  it('refuses non-ISO human formats that Date.parse accepted (documented narrowing)', () => {
    expect(Number.isNaN(Date.parse('June 16, 2026'))).toBe(false);
    expect(coerceToMicros('June 16, 2026')).toBeNull();
  });

  it('refuses an instant too far from the epoch to hold exactly', () => {
    expect(coerceToMicros('9999-12-31T00:00:00Z')).toBeNull();
  });
});

describe('safe-integer headroom', () => {
  it('microseconds since epoch stays a safe integer well past 2100', () => {
    const us2100 = dateToMicros(new Date('2100-01-01T00:00:00.000Z'));
    expect(us2100).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(us2100)).toBe(true);
  });

  it('the unit bounds leave an undeterminable gap', () => {
    expect(MILLIS_UPPER_BOUND).toBeLessThan(MICROS_LOWER_BOUND);
  });

  it('scaling the largest classifiable millisecond value to µs stays safe', () => {
    // The cap exists so ms × 1000 never overflows Number.MAX_SAFE_INTEGER.
    expect(MILLIS_UPPER_BOUND * 1000).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('refuses a millisecond value large enough to overflow µs (no silent precision loss)', () => {
    const farFutureMs = 1.05e13; // ~year 2302 in ms — above the cap
    expect(farFutureMs * 1000).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(coerceToMicros(farFutureMs)).toBeNull();
  });
});
