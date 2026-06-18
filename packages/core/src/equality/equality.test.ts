import { describe, expect, it } from 'vitest';
import { valuesEqual } from './index';

describe('valuesEqual', () => {
  it('compares primitives', () => {
    expect(valuesEqual(1, 1)).toBe(true);
    expect(valuesEqual('a', 'a')).toBe(true);
    expect(valuesEqual(null, null)).toBe(true);
    expect(valuesEqual(1, 2)).toBe(false);
    expect(valuesEqual(null, 0)).toBe(false);
    expect(valuesEqual(undefined, null)).toBe(false);
  });

  it('handles BigInt without serializing', () => {
    expect(valuesEqual(1n, 1n)).toBe(true);
    expect(valuesEqual(1n, 2n)).toBe(false);
  });

  it('compares Dates by epoch', () => {
    expect(valuesEqual(new Date(5), new Date(5))).toBe(true);
    expect(valuesEqual(new Date(5), new Date(6))).toBe(false);
  });

  it('compares arrays positionally', () => {
    expect(valuesEqual([1, [2]], [1, [2]])).toBe(true);
    expect(valuesEqual([1, 2], [2, 1])).toBe(false);
    expect(valuesEqual([1], [1, 2])).toBe(false);
  });

  it('compares plain objects order-independently', () => {
    expect(valuesEqual({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toBe(true);
    expect(valuesEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(valuesEqual({ a: 1 }, { a: 2 })).toBe(false);
  });
});
