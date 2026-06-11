import { describe, expect, it } from 'vitest';
import { isEmpty, pickDirty, valuesEqual } from './diff';

describe('pickDirty', () => {
  it('keeps only keys flagged as dirty', () => {
    expect(pickDirty({ a: 1, b: 2, c: 3 }, { a: true, c: true })).toEqual({ a: 1, c: 3 });
  });

  it('preserves null values when the key is dirty (NullClearButton case)', () => {
    expect(pickDirty({ email: null, nome: 'x' }, { email: true })).toEqual({
      email: null,
    });
  });

  it('returns an empty object when nothing is dirty', () => {
    expect(pickDirty({ a: 1 }, {})).toEqual({});
  });

  it('skips keys where the dirty flag is falsy', () => {
    expect(pickDirty({ a: 1, b: 2 }, { a: true, b: false })).toEqual({ a: 1 });
  });
});

describe('isEmpty', () => {
  it('returns true for {}', () => {
    expect(isEmpty({})).toBe(true);
  });
  it('returns false for objects with any key, even null/undefined values', () => {
    expect(isEmpty({ a: null })).toBe(false);
    expect(isEmpty({ a: undefined })).toBe(false);
  });
});

describe('valuesEqual', () => {
  it('compares primitives, null and undefined with === semantics', () => {
    expect(valuesEqual('a', 'a')).toBe(true);
    expect(valuesEqual(1, 2)).toBe(false);
    expect(valuesEqual(null, null)).toBe(true);
    expect(valuesEqual(null, undefined)).toBe(false);
  });

  it('handles BigInt without throwing (JSON.stringify would)', () => {
    expect(valuesEqual(1n, 1n)).toBe(true);
    expect(valuesEqual(1n, 2n)).toBe(false);
    expect(valuesEqual({ perm: 1n }, { perm: 1n })).toBe(true);
  });

  it('compares arrays element-wise and objects key-wise (deep)', () => {
    expect(valuesEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(valuesEqual(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(valuesEqual([{ id: 'x' }], [{ id: 'x' }])).toBe(true);
    expect(valuesEqual({ a: [1], b: null }, { a: [1], b: null })).toBe(true);
    expect(valuesEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('compares Dates by epoch and never equates them to plain objects', () => {
    expect(valuesEqual(new Date(1000), new Date(1000))).toBe(true);
    expect(valuesEqual(new Date(1000), new Date(2000))).toBe(false);
    expect(valuesEqual(new Date(1000), {})).toBe(false);
  });
});
