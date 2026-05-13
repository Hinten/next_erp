import { describe, expect, it } from 'vitest';
import { add, format, money, subtract } from './index';

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
