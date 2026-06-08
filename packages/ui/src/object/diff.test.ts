import { describe, expect, it } from 'vitest';
import { isEmpty, pickDirty } from './diff';

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
