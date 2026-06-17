import { describe, expect, it } from 'vitest';
import { microsSinceEpoch, millisSinceEpoch } from './datetime';

describe('microsSinceEpoch', () => {
  const schema = microsSinceEpoch('Criação').nullable().default(null);

  it('passes a microsecond number through unchanged', () => {
    const us = 1_700_000_000_000_000;
    expect(schema.parse(us)).toBe(us);
  });

  it('coerces a legacy millisecond number to microseconds', () => {
    expect(schema.parse(1_700_000_000_000)).toBe(1_700_000_000_000_000);
  });

  it('coerces a legacy ISO-8601 string to microseconds', () => {
    const iso = '2026-06-16T12:00:00.000Z';
    expect(schema.parse(iso)).toBe(Date.parse(iso) * 1000);
  });

  it('keeps null / undefined as null via the default', () => {
    expect(schema.parse(null)).toBeNull();
    expect(schema.parse(undefined)).toBeNull();
  });

  it('rejects an unparseable value rather than nulling it', () => {
    expect(() => microsSinceEpoch().parse('garbage')).toThrow();
  });

  it('rejects a number in the undeterminable ms/µs gap (not silently accepted)', () => {
    // 5e13 sits between MILLIS_UPPER_BOUND and MICROS_LOWER_BOUND — coerce
    // refuses it, so the builder must reject rather than store a raw int.
    expect(() => microsSinceEpoch().parse(5e13)).toThrow();
  });

  it('carries datetime UI metadata in describe()', () => {
    const meta = JSON.parse(microsSinceEpoch('Criação').description ?? '{}');
    expect(meta).toMatchObject({ kind: 'datetime', unit: 'us', label: 'Criação' });
  });
});

describe('millisSinceEpoch', () => {
  const schema = millisSinceEpoch();

  it('passes a millisecond number through unchanged', () => {
    expect(schema.parse(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('coerces a microsecond number down to milliseconds', () => {
    expect(schema.parse(1_700_000_000_000_000)).toBe(1_700_000_000_000);
  });

  it('tags unit ms (no label when omitted)', () => {
    const meta = JSON.parse(millisSinceEpoch().description ?? '{}');
    expect(meta).toMatchObject({ kind: 'datetime', unit: 'ms' });
    expect(meta.label).toBeUndefined();
  });
});
