import { describe, expect, it } from 'vitest';
import { DELETE_MARK } from '@delfrance/ui';
import { stripFormulasCalculoPreco, stripFormulasPorCategoria } from './formulaStrip';

describe('stripFormulasCalculoPreco', () => {
  it('passes null through untouched', () => {
    expect(stripFormulasCalculoPreco(null)).toBeNull();
  });

  it('collapses an empty array to null', () => {
    expect(stripFormulasCalculoPreco([])).toBeNull();
  });

  it('drops rows marked for deletion and strips the marker from survivors', () => {
    const value = [
      { limiar: 0, formula: 'A', [DELETE_MARK]: true },
      { limiar: 1, formula: 'B' },
      { limiar: 2, formula: 'C', [DELETE_MARK]: false },
    ];
    const out = stripFormulasCalculoPreco(value) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.formula)).toEqual(['B', 'C']);
    for (const f of out) expect(DELETE_MARK in f).toBe(false);
  });

  it('strips marked faixas inside a surviving formula, empty faixas → null', () => {
    const value = [
      {
        limiar: 0,
        formula: 'A',
        faixasTaxaFixaPeso: [
          { pesoMinKg: 0, pesoMaxKg: 1, taxaFixa: 5 },
          { pesoMinKg: 1, pesoMaxKg: 2, taxaFixa: 8, [DELETE_MARK]: true },
        ],
      },
      {
        limiar: 1,
        formula: 'B',
        faixasTaxaFixaPeso: [{ pesoMinKg: 0, pesoMaxKg: 1, taxaFixa: 3, [DELETE_MARK]: true }],
      },
    ];
    const out = stripFormulasCalculoPreco(value) as Array<Record<string, unknown>>;
    const faixasA = out[0]!.faixasTaxaFixaPeso as Array<Record<string, unknown>>;
    expect(faixasA).toHaveLength(1);
    expect(DELETE_MARK in faixasA[0]!).toBe(false);
    // Every faixa removed → collapses to null.
    expect(out[1]!.faixasTaxaFixaPeso).toBeNull();
  });
});

describe('stripFormulasPorCategoria', () => {
  it('passes null through untouched', () => {
    expect(stripFormulasPorCategoria(null)).toBeNull();
  });

  it('collapses an empty record to null', () => {
    expect(stripFormulasPorCategoria({})).toBeNull();
  });

  it('drops categories marked for deletion and strips the marker from survivors', () => {
    const value = {
      catA: { name: 'A', [DELETE_MARK]: true, formulasCalculoPreco: null },
      catB: { name: 'B', formulasCalculoPreco: null },
    };
    const out = stripFormulasPorCategoria(value) as Record<string, Record<string, unknown>>;
    expect(Object.keys(out)).toEqual(['catB']);
    expect(DELETE_MARK in out.catB!).toBe(false);
  });

  it('preserves an unexpected (null / non-object) entry so validation blocks the save', () => {
    const value = {
      good: { name: 'A', formulasCalculoPreco: null },
      bad: null,
      alsoBad: 'oops',
    };
    const out = stripFormulasPorCategoria(value) as Record<string, unknown>;
    // Malformed entries pass through untouched (not silently dropped) so Zod
    // fails the save loudly.
    expect(out.bad).toBeNull();
    expect(out.alsoBad).toBe('oops');
    expect(out.good).toEqual({ name: 'A', formulasCalculoPreco: null });
  });

  it('recursively strips a surviving category’s marked formulas', () => {
    const value = {
      catA: {
        name: 'A',
        formulasCalculoPreco: [
          { limiar: 0, formula: 'keep' },
          { limiar: 1, formula: 'drop', [DELETE_MARK]: true },
        ],
      },
    };
    const out = stripFormulasPorCategoria(value) as Record<string, Record<string, unknown>>;
    const formulas = out.catA!.formulasCalculoPreco as Array<Record<string, unknown>>;
    expect(formulas).toHaveLength(1);
    expect(formulas[0]!.formula).toBe('keep');
  });
});
