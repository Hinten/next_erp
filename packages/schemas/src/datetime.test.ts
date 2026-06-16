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
