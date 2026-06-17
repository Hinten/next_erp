import { describe, expect, it } from 'vitest';
import type { FormulaCalculoPreco } from '../listaDePrecos';
import {
  calcularPreco,
  custoDoKit,
  diffPrecos,
  evaluateFormula,
  samePrecos,
  taxaFixaPorPeso,
  temFormulas,
} from './precoCalculo';

function formula(over: Partial<FormulaCalculoPreco> & { limiar: number; formula: string }) {
  return {
    taxaFixa: 0,
    custoFixo: 0,
    margemDeLucro: 0,
    comissaoMarketplace: 0,
    imposto: 0,
    frete: 0,
    marketing: 0,
    ...over,
  };
}

describe('evaluateFormula', () => {
  const vars = { C: 10, T: 5, L: 2 };

  it('respects precedence and parentheses', () => {
    expect(evaluateFormula('C+T*L', vars)).toBe(20);
    expect(evaluateFormula('(C+T)*L', vars)).toBe(30);
    expect(evaluateFormula('C*L+T', vars)).toBe(25);
  });

  it('supports division, power (right-assoc) and unary minus', () => {
    expect(evaluateFormula('C/L', vars)).toBe(5);
    expect(evaluateFormula('L^3', vars)).toBe(8);
    expect(evaluateFormula('L^3^2', vars)).toBe(512); // right-assoc: 2^(3^2), not (2^3)^2=64
    expect(evaluateFormula('-C+T', vars)).toBe(-5);
    expect(evaluateFormula('C*-L', vars)).toBe(-20);
  });

  it('treats comma as decimal separator (wire format)', () => {
    expect(evaluateFormula('C*1,5', vars)).toBe(15);
  });

  it('returns null on bad input instead of throwing', () => {
    expect(evaluateFormula('C+', vars)).toBeNull();
    expect(evaluateFormula('(C+T', vars)).toBeNull();
    expect(evaluateFormula('C X', vars)).toBeNull(); // trailing garbage
    expect(evaluateFormula('Z+1', vars)).toBeNull(); // unbound variable
    expect(evaluateFormula('C/0*0', vars)).toBeNull(); // NaN
  });
});

describe('taxaFixaPorPeso', () => {
  const f = formula({
    limiar: 100,
    formula: 'C',
    taxaFixa: 9,
    faixasTaxaFixaPeso: [
      { pesoMinKg: 0, pesoMaxKg: 0.5, taxaFixa: 3 },
      { pesoMinKg: 0.51, pesoMaxKg: 2, taxaFixa: 6 },
    ],
  });

  it('picks the band containing the weight (inclusive bounds)', () => {
    expect(taxaFixaPorPeso(f, 0.25)).toBe(3);
    expect(taxaFixaPorPeso(f, 0.5)).toBe(3);
    expect(taxaFixaPorPeso(f, 2)).toBe(6);
  });

  it('rounds the weight UP at 2 decimals before matching (Dart ceil)', () => {
    // 0.501 → ceil to 0.51 → second band, not the first.
    expect(taxaFixaPorPeso(f, 0.501)).toBe(6);
  });

  it('falls back to taxaFixa outside every band or with no bands', () => {
    expect(taxaFixaPorPeso(f, 5)).toBe(9);
    expect(taxaFixaPorPeso(formula({ limiar: 1, formula: 'C', taxaFixa: 7 }), 1)).toBe(7);
  });
});

describe('calcularPreco', () => {
  const lista = {
    formulasCalculoPreco: [
      // Deliberately out of order — selection must sort by limiar ASC.
      formula({ limiar: 999999, formula: 'C*L', margemDeLucro: 1.8 }),
      formula({ limiar: 100, formula: 'C*L+T', margemDeLucro: 2, taxaFixa: 5 }),
    ],
    formulasPorCategoria: {
      cat1: {
        name: 'cat1',
        formulasCalculoPreco: [formula({ limiar: 999999, formula: 'C*L', margemDeLucro: 3 })],
      },
      catVazia: { name: 'catVazia', formulasCalculoPreco: null },
    },
  };

  it('uses the first formula (limiar asc) whose result fits its limiar', () => {
    // custo 10: first candidate (limiar 100) → 10*2+5=25 ≤ 100 → wins.
    expect(calcularPreco(lista, 10)).toEqual({ valor: 25 });
    // custo 60: limiar-100 formula → 125 > 100 → falls to limiar-999999 → 108.
    expect(calcularPreco(lista, 60)).toEqual({ valor: 108 });
  });

  it('rounds to 2 decimals like Dart toStringAsFixed', () => {
    // custo 3.333 → 3.333*2+5 = 11.666 → 11.67
    expect(calcularPreco(lista, 3.333)).toEqual({ valor: 11.67 });
  });

  it('prefers categoria formulas and falls back when the bucket is empty', () => {
    expect(calcularPreco(lista, 10, { idCategoria: 'cat1' })).toEqual({ valor: 30 });
    expect(calcularPreco(lista, 10, { idCategoria: 'catVazia' })).toEqual({ valor: 25 });
    expect(calcularPreco(lista, 10, { idCategoria: 'inexistente' })).toEqual({ valor: 25 });
  });

  it('returns null for custo ≤ 0, no formulas, or nothing under the limiar', () => {
    expect(calcularPreco(lista, 0)).toBeNull();
    expect(calcularPreco({ formulasCalculoPreco: null }, 10)).toBeNull();
    expect(
      calcularPreco(
        { formulasCalculoPreco: [formula({ limiar: 1, formula: 'C*L', margemDeLucro: 2 })] },
        10,
      ),
    ).toBeNull(); // 20 > limiar 1
  });

  it('skips unparsable and non-positive results', () => {
    const broken = {
      formulasCalculoPreco: [
        formula({ limiar: 5, formula: '???' }),
        formula({ limiar: 10, formula: 'C-L*C', margemDeLucro: 2 }), // 10-20 = -10 → skip
        formula({ limiar: 1000, formula: 'C*L', margemDeLucro: 2 }),
      ],
    };
    expect(calcularPreco(broken, 10)).toEqual({ valor: 20 });
  });

  it('temFormulas reflects default and categoria buckets', () => {
    expect(temFormulas(lista)).toBe(true);
    expect(temFormulas({ formulasCalculoPreco: null })).toBe(false);
    expect(
      temFormulas(
        { formulasCalculoPreco: null, formulasPorCategoria: lista.formulasPorCategoria },
        'cat1',
      ),
    ).toBe(true);
  });
});

describe('precos diffing', () => {
  it('samePrecos compares entries by valor, tolerating null/undefined maps', () => {
    expect(samePrecos(null, undefined)).toBe(true);
    expect(samePrecos({ a: { valor: 1 } }, { a: { valor: 1 } })).toBe(true);
    expect(samePrecos({ a: { valor: 1 } }, { a: { valor: 2 } })).toBe(false);
    expect(samePrecos({ a: { valor: 1 } }, {})).toBe(false);
  });

  it('diffPrecos covers changed, added and removed entries (Flutter matrix)', () => {
    const out = diffPrecos(
      { a: { valor: 10 }, b: { valor: 5 }, c: { valor: 7 } },
      { a: { valor: 12 }, c: { valor: 7 }, d: { valor: 3 } },
    );
    expect(out).toEqual([
      { listaId: 'a', valorOriginal: 10, valorFinal: 12 },
      { listaId: 'd', valorOriginal: null, valorFinal: 3 },
      { listaId: 'b', valorOriginal: 5, valorFinal: null },
    ]);
  });

  it('handles null→map and map→null transitions', () => {
    expect(diffPrecos(null, { a: { valor: 1 } })).toEqual([
      { listaId: 'a', valorOriginal: null, valorFinal: 1 },
    ]);
    expect(diffPrecos({ a: { valor: 1 } }, null)).toEqual([
      { listaId: 'a', valorOriginal: 1, valorFinal: null },
    ]);
    expect(diffPrecos(null, null)).toEqual([]);
  });
});

describe('custoDoKit', () => {
  const kit = (quantidade: number) => ({ quantidade, limitarEstoque: true, timestamp: null });

  it('sums component cost × quantidade, rounded to 2 decimals', () => {
    const out = custoDoKit({ p1: kit(2), p2: kit(3) }, { p1: 10.5, p2: 1.005 });
    expect(out).toEqual({ custo: 24.02, faltando: [] }); // 21 + 3.015 = 24.015 → 24.02
  });

  it('returns null cost with the missing ids when a component cost is unresolved', () => {
    expect(custoDoKit({ p1: kit(1), p2: kit(1) }, { p1: 10 })).toEqual({
      custo: null,
      faltando: ['p2'],
    });
    expect(custoDoKit({ p1: kit(1) }, { p1: null })).toEqual({ custo: null, faltando: ['p1'] });
  });

  it('returns null for an empty/absent kit (Flutter parity)', () => {
    expect(custoDoKit({}, {})).toEqual({ custo: null, faltando: [] });
    expect(custoDoKit(null, {})).toEqual({ custo: null, faltando: [] });
  });
});
