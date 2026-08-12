import { describe, expect, it } from 'vitest';
import { add, format, formatReais, money, roundReais, subtract } from './index';

describe('money', () => {
  it('rejects non-integer amounts', () => {
    expect(() => money(1.5)).toThrow(/integer/);
  });

  it('defaults to BRL', () => {
    expect(money(100).currency).toBe('BRL');
  });
});

describe('add / subtract', () => {
  it('adds same-currency amounts', () => {
    expect(add(money(100), money(50))).toEqual({ amount: 150, currency: 'BRL' });
  });

  it('subtracts same-currency amounts', () => {
    expect(subtract(money(100), money(40))).toEqual({ amount: 60, currency: 'BRL' });
  });

  it('rejects mixed-currency arithmetic', () => {
    expect(() => add(money(100, 'BRL'), money(50, 'USD'))).toThrow();
    expect(() => subtract(money(100, 'BRL'), money(50, 'USD'))).toThrow();
  });
});

describe('format', () => {
  it('renders BRL with pt-BR locale', () => {
    // Use a fixed value and assert key properties (currency symbol + amount)
    // rather than the full string, since whitespace varies by ICU version.
    const out = format(money(12345));
    expect(out).toContain('123,45');
    expect(out).toMatch(/R\$/);
  });
});

describe('roundReais', () => {
  it('rounds from the IEEE-754 double, matching Dart duasCasasDecimais (toFixed), NOT textbook half-up', () => {
    // These x.xx5 boundaries round DOWN because the nearest double to each is a
    // hair BELOW the exact tie (e.g. 1.005 is really 1.00499999999999989…).
    expect(roundReais(1.005)).toBe(1.0);
    expect(roundReais(2.675)).toBe(2.67);
    expect(roundReais(6.555)).toBe(6.55);
    // ...while this one rounds UP: its double (24.0150000000000005684…) sits a
    // hair ABOVE the tie. Same rule (round the actual double), opposite result.
    expect(roundReais(24.015)).toBe(24.02);
  });

  it('agrees with plain Number(n.toFixed(2)) by construction', () => {
    expect(roundReais(6.555)).toBe(Number((6.555).toFixed(2)));
    expect(roundReais(1.005)).toBe(Number((1.005).toFixed(2)));
  });

  it('rounds negatives from their own double the same way (no forced symmetry)', () => {
    expect(roundReais(-1.005)).toBe(-1.0);
    expect(roundReais(10.005)).toBe(10.01); // its double sits above the tie
    expect(roundReais(-5.523)).toBe(-5.52);
  });

  it('leaves already-2-decimal and integer values unchanged', () => {
    expect(roundReais(30)).toBe(30);
    expect(roundReais(6.5)).toBe(6.5);
    expect(roundReais(0)).toBe(0);
  });

  it('rounds ordinary non-boundary values as expected', () => {
    expect(roundReais(5.523)).toBe(5.52);
    expect(roundReais(6.739)).toBe(6.74);
  });

  it('passes non-finite values through unchanged', () => {
    expect(roundReais(Number.NaN)).toBeNaN();
    expect(roundReais(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  it('collapses tiny values to 0 (not NaN)', () => {
    expect(roundReais(1e-7)).toBe(0);
    expect(roundReais(5.5e-17)).toBe(0);
    // The textbook float residual must not poison a near-zero difference.
    expect(roundReais(0.1 + 0.2 - 0.3)).toBe(0);
  });

  it('never returns -0 when a tiny negative rounds to zero', () => {
    expect(Object.is(roundReais(-0.001), 0)).toBe(true);
    expect(Object.is(roundReais(-1e-9), 0)).toBe(true);
  });
});

describe('formatReais', () => {
  it('formats a reais amount as BRL, rounding from the double first', () => {
    const out = formatReais(6.555);
    expect(out).toContain('6,55');
    expect(out).toMatch(/R\$/);
  });

  it('pads to two decimals', () => {
    expect(formatReais(6.5)).toContain('6,50');
  });
});
