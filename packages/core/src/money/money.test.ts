import { describe, expect, it } from 'vitest';
import {
  add,
  centavosDeReais,
  cotaExataReais,
  format,
  formatReais,
  money,
  ratearReais,
  roundReais,
  subtract,
} from './index';

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

/** Σ of the parts in INTEGER cents — a float sum (`0.1 + 0.2 !== 0.3`) is never compared. */
function somaEmCentavos(partes: readonly number[]): number {
  return partes.reduce((acc, p) => acc + centavosDeReais(p), 0);
}

describe('ratearReais', () => {
  it('gives the extra cents to the FIRST parts, in order, and sums exactly', () => {
    // A "remainder on the last part" implementation returns [33.33, 33.33, 33.34].
    expect(ratearReais(100, 3)).toEqual([33.34, 33.33, 33.33]);
    expect(ratearReais(10, 6)).toEqual([1.67, 1.67, 1.67, 1.67, 1.66, 1.66]);
  });

  it('is a plain equal split when the cents divide evenly', () => {
    expect(ratearReais(10, 4)).toEqual([2.5, 2.5, 2.5, 2.5]);
    expect(ratearReais(10, 1)).toEqual([10]);
  });

  it('can return 0-value parts when the total is under partes cents', () => {
    expect(ratearReais(0.02, 3)).toEqual([0.01, 0.01, 0]);
    expect(ratearReais(0.05, 2)).toEqual([0.03, 0.02]);
    expect(ratearReais(0, 2)).toEqual([0, 0]);
  });

  it('splits roundReais(total), not the raw total (6.555 is 6.55, so 655 cents)', () => {
    const partes = ratearReais(6.555, 2);
    expect(partes).toEqual([3.28, 3.27]);
    // Near-miss: a half-up total (6.56 → 656 cents) would sum to 656.
    expect(somaEmCentavos(partes)).toBe(655);
  });

  it('sums to the total in integer cents, parts never more than a cent apart', () => {
    const totais = [
      0, 0.01, 0.02, 0.05, 0.99, 1, 10, 33.33, 99.99, 100, 1005.55, 1005.56, 12345.67, 99999.99,
    ];
    for (const total of totais) {
      for (let n = 1; n <= 12; n += 1) {
        const partes = ratearReais(total, n);
        const centavos = partes.map(centavosDeReais);
        expect(partes).toHaveLength(n);
        expect(somaEmCentavos(partes)).toBe(centavosDeReais(total));
        expect(Math.max(...centavos) - Math.min(...centavos)).toBeLessThanOrEqual(1);
        // non-increasing: the extra cents sit at the front
        expect(centavos).toEqual([...centavos].sort((a, b) => b - a));
        // every part is already a clean 2-decimal amount
        for (const parte of partes) expect(roundReais(parte)).toBe(parte);
      }
    }
  });

  it('accepts the boundaries: 1 part, 50 parts, a zero total', () => {
    expect(ratearReais(7.77, 1)).toEqual([7.77]);
    const cinquenta = ratearReais(0.5, 50);
    expect(cinquenta).toHaveLength(50);
    expect(cinquenta.every((p) => p === 0.01)).toBe(true);
  });

  it('throws RangeError for a bad number of parts', () => {
    expect(() => ratearReais(100, 0)).toThrow(RangeError);
    expect(() => ratearReais(100, 1.5)).toThrow(RangeError);
    expect(() => ratearReais(100, 51)).toThrow(RangeError);
    expect(() => ratearReais(100, -1)).toThrow(RangeError);
    expect(() => ratearReais(100, Number.NaN)).toThrow(RangeError);
    expect(() => ratearReais(100, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('throws RangeError for a negative, non-finite or unsplittable total', () => {
    expect(() => ratearReais(-1, 3)).toThrow(RangeError);
    expect(() => ratearReais(-0.001, 3)).toThrow(RangeError);
    expect(() => ratearReais(Number.NaN, 3)).toThrow(RangeError);
    expect(() => ratearReais(Number.POSITIVE_INFINITY, 3)).toThrow(RangeError);
    expect(() => ratearReais(Number.MAX_SAFE_INTEGER, 3)).toThrow(RangeError);
  });
});

describe('cotaExataReais', () => {
  it('returns the per-payment amount only when the cents divide exactly', () => {
    expect(cotaExataReais(99, 3)).toBe(33);
    expect(cotaExataReais(100, 4)).toBe(25);
    expect(cotaExataReais(0.03, 3)).toBe(0.01);
    expect(cotaExataReais(10, 1)).toBe(10);
  });

  it('returns null, never a rounded-up amount, when they do not', () => {
    // A ceil implementation returns 33.34 here and collects 100.02.
    expect(cotaExataReais(100, 3)).toBeNull();
    expect(cotaExataReais(0.02, 3)).toBeNull();
    expect(cotaExataReais(10, 6)).toBeNull();
  });

  it('is non-null exactly when ratearReais gives equal parts, and N × cota is the total', () => {
    const totais = [0.01, 0.03, 0.06, 1, 10, 33.33, 99, 100, 1005.55, 1005.56, 99999.99];
    for (const total of totais) {
      for (let n = 1; n <= 12; n += 1) {
        const cota = cotaExataReais(total, n);
        const iguais = new Set(ratearReais(total, n)).size === 1;
        expect(cota !== null).toBe(iguais);
        if (cota !== null) expect(centavosDeReais(cota) * n).toBe(centavosDeReais(total));
      }
    }
  });

  it('throws RangeError under the same conditions as ratearReais', () => {
    expect(() => cotaExataReais(100, 0)).toThrow(RangeError);
    expect(() => cotaExataReais(100, 1.5)).toThrow(RangeError);
    expect(() => cotaExataReais(100, 51)).toThrow(RangeError);
    expect(() => cotaExataReais(Number.NaN, 3)).toThrow(RangeError);
    expect(() => cotaExataReais(-1, 3)).toThrow(RangeError);
  });
});
