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
  it('rounds HALF UP at the 2nd decimal (the 3rd decimal decides)', () => {
    expect(roundReais(5.523)).toBe(5.52);
    expect(roundReais(6.555)).toBe(6.56);
    expect(roundReais(6.739)).toBe(6.74);
    expect(roundReais(2.675)).toBe(2.68);
  });

  it('is float-robust where toFixed / Math.round are NOT', () => {
    // The two naive impls disagree AND each is wrong on some input:
    // toFixed sees the 6.55499… double for 6.555 and rounds DOWN to 6.55,
    expect(Number((6.555).toFixed(2))).toBe(6.55); // naive #1 (wrong here)
    // while Math.round(n*100) underflows on 1.005 (1.005*100 = 100.4999…) → 1.00.
    expect(Math.round(1.005 * 100) / 100).toBe(1); // naive #2 (wrong here)
    // The canonical helper rounds both half-up correctly.
    expect(roundReais(6.555)).toBe(6.56);
    expect(roundReais(1.005)).toBe(1.01);
  });

  it('rounds away from zero for negatives (symmetric)', () => {
    expect(roundReais(-6.555)).toBe(-6.56);
    expect(roundReais(-5.523)).toBe(-5.52);
  });

  it('leaves already-2-decimal and integer values unchanged', () => {
    expect(roundReais(30)).toBe(30);
    expect(roundReais(6.5)).toBe(6.5);
    expect(roundReais(0)).toBe(0);
  });

  it('passes non-finite values through unchanged', () => {
    expect(roundReais(Number.NaN)).toBeNaN();
    expect(roundReais(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  it('collapses tiny values that stringify in scientific notation to 0 (not NaN)', () => {
    // `(1e-7).toString() === "1e-7"`, which the naive `${n}e2` shift would turn
    // into the invalid literal "1e-7e2" → NaN.
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
  it('formats a reais amount as BRL, rounding half-up first', () => {
    const out = formatReais(6.555);
    expect(out).toContain('6,56');
    expect(out).toMatch(/R\$/);
  });

  it('pads to two decimals', () => {
    expect(formatReais(6.5)).toContain('6,50');
  });
});
