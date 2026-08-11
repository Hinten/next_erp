import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MICROS_LOWER_BOUND, MILLIS_UPPER_BOUND } from '@delfrance/core/datetime';
import { millisSinceEpoch } from '@delfrance/schemas';

import { asInt, asMillis } from './coerce';

/**
 * The receiver coercers. Both exist for ONE reason — a value that reaches
 * `persistFailure` must never be rejected by the collection's strict write
 * validator — so the load-bearing assertions here are the round-trips through
 * `millisSinceEpoch()`, not the happy paths.
 */

describe('asInt', () => {
  it('accepts a number, truncating toward zero', () => {
    expect(asInt(55)).toBe(55);
    expect(asInt(55.9)).toBe(55);
    expect(asInt(-55.9)).toBe(-55);
    expect(asInt(0)).toBe(0);
  });

  it('accepts a numeric string — the #810 fix (asMillis always did)', () => {
    expect(asInt('55')).toBe(55);
    expect(asInt(' 55 ')).toBe(55);
    expect(asInt('\t55\n')).toBe(55);
    expect(asInt('-55')).toBe(-55);
    expect(asInt('+55')).toBe(55);
    expect(asInt('0123')).toBe(123);
  });

  it('refuses the strings bare Number() would silently coerce', () => {
    // Number('') === 0, Number('  ') === 0, Number('0x1F') === 31,
    // Number('1e3') === 1000. A coerced-from-garbage seller id is worse than a
    // null one: null routes to `no-account` (persisted, swept, visible).
    expect(asInt('')).toBeNull();
    expect(asInt('   ')).toBeNull();
    expect(asInt('0x1F')).toBeNull();
    expect(asInt('1e3')).toBeNull();
    expect(asInt('12.7')).toBeNull();
    expect(asInt('55abc')).toBeNull();
    expect(asInt('abc')).toBeNull();
  });

  it('refuses anything z.number().int() would reject, rather than dropping the notification', () => {
    for (const v of [1e21, '1e21', Number.MAX_SAFE_INTEGER + 2, Infinity, -Infinity, NaN]) {
      expect(asInt(v)).toBeNull();
    }
    // ...and everything it returns IS accepted by that validator.
    const int = z.number().int();
    for (const v of [55, '55', -55, 0, Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)]) {
      expect(int.safeParse(asInt(v)).success).toBe(true);
    }
  });

  it('refuses non-scalars', () => {
    for (const v of [null, undefined, true, {}, [], [55], new Date()]) {
      expect(asInt(v)).toBeNull();
    }
  });
});

describe('asMillis', () => {
  it('accepts epoch millis, ISO-8601 and numeric strings', () => {
    expect(asMillis(1_741_196_520_060)).toBe(1_741_196_520_060);
    expect(asMillis('1741196520060')).toBe(1_741_196_520_060);
    expect(asMillis('2025-03-05T20:27:20.218Z')).toBe(Date.parse('2025-03-05T20:27:20.218Z'));
    expect(asMillis(42)).toBe(42);
  });

  it('nulls the noise providers actually send', () => {
    for (const v of ['', '   ', 'not-a-date', null, undefined, {}, [], true, NaN, Infinity]) {
      expect(asMillis(v)).toBeNull();
    }
  });

  it('does NOT carry coerceToMillis’ µs heuristic — a µs number is not rescaled', () => {
    // The whole point of this coercer being separate: receiver semantics treat
    // any in-range finite number as millis.
    expect(asMillis(1_000)).toBe(1_000);
  });

  it('nulls a value the persisted-doc validator would reject (the gap and above)', () => {
    // `millisSinceEpoch()` runs `coerceToMillis`, which refuses the
    // undeterminable gap (→ NaN → ZodError from inside persistFailure, which
    // sits OUTSIDE handleTask's try/catch) and divides anything above it by
    // 1000. Neither may survive this coercer.
    for (const v of [5e13, '50000000000000', MICROS_LOWER_BOUND, 1e21]) {
      expect(asMillis(v)).toBeNull();
    }
    expect(asMillis(MILLIS_UPPER_BOUND)).toBe(MILLIS_UPPER_BOUND);
    expect(asMillis(MILLIS_UPPER_BOUND + 1)).toBeNull();
  });

  it('everything it returns round-trips through millisSinceEpoch() unchanged', () => {
    const field = millisSinceEpoch().nullable();
    const inputs = [
      0,
      42,
      1_741_196_520_060,
      '1741196520060',
      '2025-03-05T20:27:20.218Z',
      -1_000,
      MILLIS_UPPER_BOUND,
      // ...and the ones that must have been nulled on the way in.
      5e13,
      1e21,
      'garbage',
      '',
    ];
    for (const raw of inputs) {
      const ms = asMillis(raw);
      const parsed = field.safeParse(ms);
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data).toBe(ms);
    }
  });
});
