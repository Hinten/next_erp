import { describe, expect, it } from 'vitest';
import { taxaFixaPorPeso, type FormulaCalculoPreco } from '@delfrance/schemas';

/**
 * Justifies `FaixaTaxaFixaPesoEditor`'s `decimalScale={2}` on the two weight
 * bounds, which is otherwise an arbitrary-looking cap on a field the operator
 * might reasonably want three digits in.
 *
 * `taxaFixaPorPeso` rounds the product's weight UP to 2 decimals before
 * comparing it to the bounds, so the comparison only ever lands on a 0,01
 * grid.
 *
 * These tests pin what that implies for each bound. ⚠️ The two bounds do NOT
 * behave alike: the third decimal is unobservable on the MAX bound but fully
 * observable on the MIN bound, because the rounding is UP. What makes the cap
 * safe is therefore not that the digit is ignored, but that every 3-decimal
 * bound has an exact 2-decimal equivalent — ceil for the min, floor for the
 * max, which is what `FaixaTaxaFixaPesoEditor` displays. The rounding itself is deliberate (legacy
 * `getTaxaFixaPorPeso`, and it matches how carriers bill weight) and is not
 * under test here — only what it implies for the input.
 */

const PADRAO = 99;

function comFaixas(
  faixas: Array<{ pesoMinKg: number; pesoMaxKg: number; taxaFixa: number }>,
): FormulaCalculoPreco {
  return {
    limiar: 1000,
    formula: 'C+T',
    taxaFixa: PADRAO,
    custoFixo: 0,
    margemDeLucro: 0,
    comissaoMarketplace: 0,
    imposto: 0,
    frete: 0,
    marketing: 0,
    faixasTaxaFixaPeso: faixas,
  };
}

/** Weights spanning the interesting part of the 0,01 grid, incl. 3-decimal ones. */
const PESOS = [
  0.24, 0.244, 0.25, 0.251, 0.252, 0.255, 0.259, 0.26, 0.485, 0.49, 0.4952, 0.499, 0.5,
];

describe('a third decimal in the MAX bound is inert', () => {
  // The bounds differ only in a digit the engine can never observe, so the two
  // configurations must be indistinguishable for EVERY weight.
  it('0,499 behaves exactly as 0,49', () => {
    const tres = comFaixas([{ pesoMinKg: 0, pesoMaxKg: 0.499, taxaFixa: 5 }]);
    const duas = comFaixas([{ pesoMinKg: 0, pesoMaxKg: 0.49, taxaFixa: 5 }]);
    for (const peso of PESOS) {
      expect(taxaFixaPorPeso(tres, peso)).toBe(taxaFixaPorPeso(duas, peso));
    }
  });

  // Control: the sweep above is only meaningful if these weights actually
  // exercise both outcomes. If every probe fell in the same branch the
  // equality would hold trivially.
  it('the sweep exercises both the matched and the fallback branch (control)', () => {
    const duas = comFaixas([{ pesoMinKg: 0, pesoMaxKg: 0.49, taxaFixa: 5 }]);
    const resultados = new Set(PESOS.map((p) => taxaFixaPorPeso(duas, p)));
    expect(resultados).toEqual(new Set([5, PADRAO]));
  });
});

describe('a third decimal in the MIN bound is NOT inert', () => {
  // The asymmetry that makes "the engine ignores the third digit" wrong. The
  // weight is rounded UP, so `peso >= 0.251` admits exactly the grid steps
  // `peso >= 0.26` admits — the bound behaves as the CEIL of itself.
  it('0,251 behaves exactly as 0,26', () => {
    const tres = comFaixas([{ pesoMinKg: 0.251, pesoMaxKg: 2, taxaFixa: 5 }]);
    const grade = comFaixas([{ pesoMinKg: 0.26, pesoMaxKg: 2, taxaFixa: 5 }]);
    for (const peso of PESOS) {
      expect(taxaFixaPorPeso(tres, peso)).toBe(taxaFixaPorPeso(grade, peso));
    }
  });

  // ...and is genuinely distinguishable from the TRUNCATION, which is why the
  // editor displays the ceil rather than a round: showing 0,25 would state a
  // band that accepts a 0,25 kg product, and it does not.
  it('differs from 0,25 — truncating a min bound would widen the band', () => {
    const tres = comFaixas([{ pesoMinKg: 0.251, pesoMaxKg: 2, taxaFixa: 5 }]);
    const truncado = comFaixas([{ pesoMinKg: 0.25, pesoMaxKg: 2, taxaFixa: 5 }]);
    expect(taxaFixaPorPeso(tres, 0.25)).toBe(PADRAO);
    expect(taxaFixaPorPeso(truncado, 0.25)).toBe(5);
  });
});

describe('a band that spans no multiple of 0,01 can never match', () => {
  it('0,251-0,259 always falls back to the default taxaFixa', () => {
    const inalcancavel = comFaixas([{ pesoMinKg: 0.251, pesoMaxKg: 0.259, taxaFixa: 5 }]);
    for (const peso of PESOS) {
      expect(taxaFixaPorPeso(inalcancavel, peso)).toBe(PADRAO);
    }
  });

  // Control: an equivalent band placed ON the grid does match, so the test
  // above is about the bounds and not about a broken lookup.
  it('the same band snapped to the grid does match (control)', () => {
    const alcancavel = comFaixas([{ pesoMinKg: 0.25, pesoMaxKg: 0.26, taxaFixa: 5 }]);
    expect(taxaFixaPorPeso(alcancavel, 0.252)).toBe(5);
  });
});

describe('the rounding is UP, not to nearest', () => {
  // Why the fallback in the first suite happens at all: 0,4952 kg is pushed to
  // 0,50 and out of a band ending at 0,49 — into the more expensive tier.
  it('pushes a weight into the next band up', () => {
    const bandas = comFaixas([
      { pesoMinKg: 0, pesoMaxKg: 0.49, taxaFixa: 5 },
      { pesoMinKg: 0.5, pesoMaxKg: 2, taxaFixa: 15 },
    ]);
    expect(taxaFixaPorPeso(bandas, 0.4952)).toBe(15);
    expect(taxaFixaPorPeso(bandas, 0.485)).toBe(5);
  });
});
