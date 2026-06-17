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

  it('parses an ISO-8601 string (legacy pagamento)', () => {
    const iso = '2026-06-16T12:00:00.000Z';
    expect(coerceToMicros(iso)).toBe(Date.parse(iso) * 1000);
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
    const iso = '2026-06-16T12:00:00.000Z';
    expect(coerceToMillis(iso)).toBe(Date.parse(iso));
    expect(coerceToMillis(new Date(iso))).toBe(Date.parse(iso));
  });

  it('returns null in the undeterminable gap', () => {
    expect(coerceToMillis(5e13)).toBeNull();
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
