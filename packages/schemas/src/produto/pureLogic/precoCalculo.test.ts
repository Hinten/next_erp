import { describe, expect, it } from 'vitest';
import type { FormulaCalculoPreco } from '../../listaDePrecos';
import {
  KIT_PESO_BRUTO_FALLBACK_KG,
  KIT_PESO_LIQUIDO_FALLBACK_KG,
  calcularPreco,
  custoDoKit,
  diffPrecos,
  evaluateFormula,
  mesmoPrecoEmReais,
  pesoDoKit,
  precoDaTabela,
  resolveComponentCusto,
  resolveComponentPeso,
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

  it('falls back to the parent cost when a component variation has no own custo', () => {
    // child `c` (no own custo) is a variation of parent `pai` (custo 7).
    const out = custoDoKit({ c: kit(2) }, { c: null, pai: 7 }, { c: 'pai' });
    expect(out).toEqual({ custo: 14, faltando: [] }); // 7 × 2
  });

  it('prefers the component own custo over the parent fallback', () => {
    const out = custoDoKit({ c: kit(1) }, { c: 3, pai: 99 }, { c: 'pai' });
    expect(out).toEqual({ custo: 3, faltando: [] });
  });

  it('reports faltando when neither the child nor its parent has a custo', () => {
    const out = custoDoKit({ c: kit(1) }, { c: null, pai: null }, { c: 'pai' });
    expect(out).toEqual({ custo: null, faltando: ['c'] });
  });
});

describe('resolveComponentCusto', () => {
  it('returns the component own custo when present', () => {
    expect(resolveComponentCusto('c', { c: 5 }, { c: 'pai' })).toBe(5);
  });

  it('falls back to the parent custo when the child has none', () => {
    expect(resolveComponentCusto('c', { c: null, pai: 8 }, { c: 'pai' })).toBe(8);
  });

  it('returns null when neither resolves (and 0 is a real cost, not "missing")', () => {
    expect(resolveComponentCusto('c', { c: null }, { c: 'pai' })).toBeNull();
    expect(resolveComponentCusto('c', { c: null, pai: null }, { c: 'pai' })).toBeNull();
    expect(resolveComponentCusto('c', { c: 0 }, {})).toBe(0);
  });

  it('returns null for a parentless component with no own custo', () => {
    expect(resolveComponentCusto('c', { c: null }, {})).toBeNull();
  });
});

describe('pesoDoKit', () => {
  const kit = (quantidade: number) => ({ quantidade, limitarEstoque: true, timestamp: null });

  it('sums ALL components × quantidade regardless of limitarEstoque (no filter)', () => {
    // c2 has limitarEstoque:false — it must STILL be counted (the legacy getter
    // has no limitarEstoque filter). 0.5×2 + 1.25×1 = 2.25.
    const out = pesoDoKit(
      {
        c1: { quantidade: 2, limitarEstoque: true, timestamp: null },
        c2: { quantidade: 1, limitarEstoque: false, timestamp: null },
      },
      { c1: 0.5, c2: 1.25 },
      {},
      0.3,
    );
    expect(out).toBe(2.25);
  });

  it('uses the per-component fallback for an unresolved weight (never "missing")', () => {
    // c1 has no weight and no parent → fallback 0.3; ×3 = 0.9.
    expect(pesoDoKit({ c1: kit(3) }, { c1: null }, {}, KIT_PESO_BRUTO_FALLBACK_KG)).toBe(0.9);
  });

  it('falls back to the parent weight for a variation child with none of its own', () => {
    const out = pesoDoKit({ c: kit(2) }, { c: null, pai: 0.4 }, { c: 'pai' }, 0.3);
    expect(out).toBe(0.8); // parent 0.4 × 2 (not the 0.3 default)
  });

  it('returns null for an empty/absent kit', () => {
    expect(pesoDoKit({}, {}, {}, 0.3)).toBeNull();
    expect(pesoDoKit(null, {}, {}, 0.3)).toBeNull();
  });
});

describe('resolveComponentPeso', () => {
  it('prefers own weight, then parent, then the fallback default', () => {
    expect(resolveComponentPeso('c', { c: 0.7 }, { c: 'pai' }, 0.3)).toBe(0.7);
    expect(resolveComponentPeso('c', { c: null, pai: 0.9 }, { c: 'pai' }, 0.3)).toBe(0.9);
    expect(resolveComponentPeso('c', { c: null }, {}, KIT_PESO_LIQUIDO_FALLBACK_KG)).toBe(0.25);
  });

  it('treats 0 as a real weight, not "missing"', () => {
    expect(resolveComponentPeso('c', { c: 0 }, {}, 0.3)).toBe(0);
  });
});

/**
 * `precoDaTabela` is a TRANSFORM (rounding) whose output a sender compares, and
 * `mesmoPrecoEmReais` is THE fold that decides "already at that price — skip".
 * Every fold case below has a near-miss beside it that must stay distinct
 * (root `CLAUDE.md`, the equivalence-fold rule; `equivalence-fold-inventory`).
 */
describe('precoDaTabela — the price a channel sends, read off `precos`', () => {
  it('rounds with roundReais: EQUAL pair 10.004 → 10, NEAR-MISS 24.015 → 24.02 (never 24.01)', () => {
    expect(precoDaTabela({ t: { valor: 10.004 } }, 't')).toBe(10);
    expect(precoDaTabela({ t: { valor: 10 } }, 't')).toBe(10);
    // The roundReais doc's own up-lean: the double under 24.015 sits a hair above.
    expect(precoDaTabela({ t: { valor: 24.015 } }, 't')).toBe(24.02);
    expect(precoDaTabela({ t: { valor: 24.015 } }, 't')).not.toBe(24.01);
  });

  it('checks positivity AFTER rounding: 0.004 → null, NEAR-MISS 0.005 → 0.01 (a price)', () => {
    expect(precoDaTabela({ t: { valor: 0.004 } }, 't')).toBeNull();
    expect(precoDaTabela({ t: { valor: 0.005 } }, 't')).toBe(0.01);
  });

  it('never coerces: a string valor "10" → null, NEAR-MISS the number 10 → 10', () => {
    expect(precoDaTabela({ t: { valor: '10' } }, 't')).toBeNull();
    expect(precoDaTabela({ t: { valor: 10 } }, 't')).toBe(10);
  });

  it('refuses a non-finite, zero or negative valor', () => {
    expect(precoDaTabela({ t: { valor: Number.NaN } }, 't')).toBeNull();
    expect(precoDaTabela({ t: { valor: Number.POSITIVE_INFINITY } }, 't')).toBeNull();
    expect(precoDaTabela({ t: { valor: 0 } }, 't')).toBeNull();
    expect(precoDaTabela({ t: { valor: -1 } }, 't')).toBeNull();
    expect(precoDaTabela({ t: {} }, 't')).toBeNull();
  });

  it('returns null for a null or empty tabela id', () => {
    expect(precoDaTabela({ t: { valor: 10 } }, null)).toBeNull();
    expect(precoDaTabela({ '': { valor: 10 } }, '')).toBeNull();
  });

  it('tolerates junk shapes: a non-object precos or entry, an array, a missing tabela', () => {
    expect(precoDaTabela(null, 't')).toBeNull();
    expect(precoDaTabela(undefined, 't')).toBeNull();
    expect(precoDaTabela(10, 't')).toBeNull();
    expect(precoDaTabela([{ valor: 1 }], '0')).toBeNull();
    expect(precoDaTabela({ t: 5 }, 't')).toBeNull();
    expect(precoDaTabela({ t: [{ valor: 1 }] }, 't')).toBeNull();
    expect(precoDaTabela({ outra: { valor: 10 } }, 't')).toBeNull();
  });

  it('reads OWN entries only: a `__proto__` / inherited tabela → null, NEAR-MISS an own one → its price', () => {
    // A plain object: `precos.__proto__` is Object.prototype, which has no `valor`.
    expect(precoDaTabela({ t: { valor: 10 } }, '__proto__')).toBeNull();
    expect(precoDaTabela({ t: { valor: 10 } }, 'toString')).toBeNull();
    // A prototype that DOES carry a `valor` / a tabela: only an own-property read refuses it.
    const protoComValor: unknown = Object.create({ valor: 10 });
    expect(precoDaTabela(protoComValor, '__proto__')).toBeNull();
    const herdado: unknown = Object.create({ t: { valor: 10 } });
    expect(precoDaTabela(herdado, 't')).toBeNull();
    const proprio: Record<string, unknown> = Object.create({ t: { valor: 99 } });
    proprio.t = { valor: 10 };
    expect(precoDaTabela(proprio, 't')).toBe(10);
  });
});

describe('mesmoPrecoEmReais — THE skip-if-equal fold', () => {
  it('EQUAL pair: 10.004 ≡ 10 and 0.1 + 0.2 ≡ 0.3 (float residue is not an edit)', () => {
    expect(mesmoPrecoEmReais(10, 10.004)).toBe(true);
    expect(mesmoPrecoEmReais(10.004, 10)).toBe(true);
    expect(mesmoPrecoEmReais(0.1 + 0.2, 0.3)).toBe(true);
  });

  it('EQUAL pair across a rounding UP: 49.999 ≡ 50 and 10.006 ≡ 10.01 (a truncating fold would split them)', () => {
    expect(mesmoPrecoEmReais(49.999, 50)).toBe(true);
    expect(mesmoPrecoEmReais(10.006, 10.01)).toBe(true);
  });

  it('NEAR-MISS: one centavo apart stays DISTINCT — 49.99 ≠ 50, 11.10 ≠ 11.11', () => {
    expect(mesmoPrecoEmReais(49.99, 50)).toBe(false);
    expect(mesmoPrecoEmReais(11.1, 11.11)).toBe(false);
  });

  it('NEAR-MISS: 49.991 ≠ 50 — 0.009 apart, yet different centavos (a `< 0.01` tolerance would equate them)', () => {
    expect(mesmoPrecoEmReais(49.991, 50)).toBe(false);
  });

  it('NEAR-MISS at the up-lean: 24.015 ≠ 24.01 (it rounds to 24.02), EQUAL pair 24.015 ≡ 24.02', () => {
    expect(mesmoPrecoEmReais(24.015, 24.01)).toBe(false);
    expect(mesmoPrecoEmReais(24.015, 24.02)).toBe(true);
  });

  it('null never equals anything: mesmoPrecoEmReais(null, 10) is false, NEAR-MISS (10, 10) is true', () => {
    expect(mesmoPrecoEmReais(null, 10)).toBe(false);
    expect(mesmoPrecoEmReais(null, 0)).toBe(false);
    expect(mesmoPrecoEmReais(10, 10)).toBe(true);
  });
});
