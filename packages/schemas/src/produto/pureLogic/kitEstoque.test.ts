import { describe, expect, it } from 'vitest';
import type { ComponentesKit } from '../collection/embedded/kit';
import { componentesKitEntries, estoqueDisponivelComKit, kitEstoqueDisponivel } from './kitEstoque';

function comp(quantidade: number, limitarEstoque = true): ComponentesKit[string] {
  return { quantidade, limitarEstoque, timestamp: null };
}

describe('kitEstoqueDisponivel', () => {
  it('returns null for absent/empty componentes', () => {
    expect(kitEstoqueDisponivel(null, {})).toBeNull();
    expect(kitEstoqueDisponivel(undefined, {})).toBeNull();
    expect(kitEstoqueDisponivel({}, { a: 10 })).toBeNull();
  });

  it('single component with quantidade 1 yields its disponivel', () => {
    expect(kitEstoqueDisponivel({ a: comp(1) }, { a: 7 })).toBe(7);
  });

  it('takes the min across components (models.dart:1447-1454)', () => {
    // a: 9/2 = 4.5, b: 12/3 = 4 → min 4
    expect(kitEstoqueDisponivel({ a: comp(2), b: comp(3) }, { a: 9, b: 12 })).toBe(4);
  });

  it('keeps fractional results unrounded (legacy plain double division)', () => {
    expect(kitEstoqueDisponivel({ a: comp(3) }, { a: 10 })).toBeCloseTo(10 / 3, 10);
  });

  it('skips limitarEstoque=false components even when they are the smallest', () => {
    expect(kitEstoqueDisponivel({ a: comp(1, false), b: comp(2) }, { a: 1, b: 10 })).toBe(5);
  });

  it('returns null when every component has limitarEstoque=false', () => {
    expect(
      kitEstoqueDisponivel({ a: comp(1, false), b: comp(2, false) }, { a: 1, b: 4 }),
    ).toBeNull();
  });

  it('treats a missing/null component disponivel as 0 (divergence from legacy, which skipped it)', () => {
    // b has no estoque doc at this depósito → 0/5 = 0 wins the min.
    expect(kitEstoqueDisponivel({ a: comp(1), b: comp(5) }, { a: 9 })).toBe(0);
    expect(kitEstoqueDisponivel({ a: comp(1), b: comp(5) }, { a: 9, b: null })).toBe(0);
    expect(kitEstoqueDisponivel({ a: comp(1), b: comp(5) }, { a: 9, b: undefined })).toBe(0);
  });

  it('returns 0 (not null) when ALL countable components are missing', () => {
    expect(kitEstoqueDisponivel({ a: comp(2), b: comp(3) }, {})).toBe(0);
  });

  it('treats non-finite disponivel values as 0 (soft-parsed junk)', () => {
    expect(kitEstoqueDisponivel({ a: comp(1) }, { a: Number.NaN })).toBe(0);
    expect(kitEstoqueDisponivel({ a: comp(1) }, { a: Number.POSITIVE_INFINITY })).toBe(0);
  });

  it('propagates negative disponivel (oversold component)', () => {
    expect(kitEstoqueDisponivel({ a: comp(1), b: comp(2) }, { a: -2, b: 10 })).toBe(-2);
  });

  it('a zero-stock component zeroes the kit', () => {
    expect(kitEstoqueDisponivel({ a: comp(1), b: comp(2) }, { a: 0, b: 10 })).toBe(0);
  });

  it('ignores entries whose quantidade is not a finite number > 0', () => {
    expect(kitEstoqueDisponivel({ a: comp(0), b: comp(2) }, { a: 1, b: 10 })).toBe(5);
    expect(kitEstoqueDisponivel({ a: comp(-1) }, { a: 1 })).toBeNull();
    expect(kitEstoqueDisponivel({ a: comp(Number.NaN) }, { a: 1 })).toBeNull();
  });

  it('ignores non-object entries and non-record maps (soft-parsed junk) instead of throwing', () => {
    const withNullEntry = { a: null, b: comp(2) } as unknown as ComponentesKit;
    expect(kitEstoqueDisponivel(withNullEntry, { b: 10 })).toBe(5);
    expect(kitEstoqueDisponivel({ a: null } as unknown as ComponentesKit, {})).toBeNull();
    expect(kitEstoqueDisponivel('junk' as unknown as ComponentesKit, {})).toBeNull();
    expect(kitEstoqueDisponivel([comp(1)] as unknown as ComponentesKit, { 0: 4 })).toBeNull();
  });
});

describe('componentesKitEntries', () => {
  it('returns the well-formed entries and drops junk', () => {
    const map = { a: comp(1), b: null, c: 7 } as unknown as ComponentesKit;
    expect(componentesKitEntries(map).map(([id]) => id)).toEqual(['a']);
  });

  it('returns [] for null/undefined and non-record values', () => {
    expect(componentesKitEntries(null)).toEqual([]);
    expect(componentesKitEntries(undefined)).toEqual([]);
    expect(componentesKitEntries('junk' as unknown as ComponentesKit)).toEqual([]);
    expect(componentesKitEntries([comp(1)] as unknown as ComponentesKit)).toEqual([]);
  });
});

describe('estoqueDisponivelComKit', () => {
  it('non-kit produtos return their own disponivel untouched', () => {
    expect(
      estoqueDisponivelComKit({ ehKit: false, componentesKit: { a: comp(1) } }, 3, { a: 99 }),
    ).toBe(3);
  });

  it('kit with absent/empty componentes falls back to own disponivel', () => {
    expect(estoqueDisponivelComKit({ ehKit: true, componentesKit: null }, 3, {})).toBe(3);
    expect(estoqueDisponivelComKit({ ehKit: true, componentesKit: {} }, 3, {})).toBe(3);
  });

  it('adds the component-derived min on top of own stock (models.dart:1457)', () => {
    // own 1 + min(9/2=4.5, 11/3≈3.667) → 1 + 11/3
    expect(
      estoqueDisponivelComKit({ ehKit: true, componentesKit: { a: comp(2), b: comp(3) } }, 1, {
        a: 9,
        b: 11,
      }),
    ).toBeCloseTo(1 + 11 / 3, 10);
  });

  it('null kit-min (all limitarEstoque=false) contributes 0', () => {
    expect(
      estoqueDisponivelComKit({ ehKit: true, componentesKit: { a: comp(1, false) } }, 2, { a: 8 }),
    ).toBe(2);
  });

  it('negative own disponivel sums with the kit part', () => {
    expect(
      estoqueDisponivelComKit({ ehKit: true, componentesKit: { a: comp(1) } }, -1, { a: 4 }),
    ).toBe(3);
  });
});
