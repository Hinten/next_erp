import { describe, it, expect } from 'vitest';
import {
  aammFromDate,
  composeChave,
  composeChave43,
  computeCDV,
  NFeChaveError,
  randomCNF,
} from '../../src/generator/chave';

describe('computeCDV', () => {
  // Hand-computed against the right-to-left weighted-sum algorithm on a
  // realistic SP-shaped 43-digit chave: sum = 399, 399 mod 11 = 3 → DV = 8.
  it('matches a realistic SP-shaped chave DV (DV = 8)', () => {
    const cdv = computeCDV('3520071420016600018755001000000007100000001');
    expect(cdv).toBe(8);
  });

  it('returns 0 when resto is 0 (all zeros)', () => {
    expect(computeCDV('0'.repeat(43))).toBe(0);
  });

  it('returns 0 when resto is 1', () => {
    // Hand-crafted: rightmost digit 6 × weight 2 = 12; 12 mod 11 = 1 → DV = 0.
    expect(computeCDV('0'.repeat(42) + '6')).toBe(0);
  });

  it('rejects non-43-digit input', () => {
    expect(() => computeCDV('123')).toThrow(NFeChaveError);
    expect(() => computeCDV('a'.repeat(43))).toThrow(NFeChaveError);
  });
});

describe('composeChave43', () => {
  const BASE = {
    cUF: '35',
    aamm: '2007',
    cnpjOrCpf: '14200166000187',
    mod: '55' as const,
    serie: '001',
    nNF: '000000007',
    tpEmis: '1',
    cNF: '00000001',
  };

  it('concatenates parts in the SEFAZ order', () => {
    expect(composeChave43(BASE)).toBe('3520071420016600018755001000000007100000001');
  });

  it('rejects cNF equal to nNF', () => {
    expect(() =>
      composeChave43({ ...BASE, nNF: '000000001', cNF: '00000001' }),
    ).toThrow(NFeChaveError);
  });

  it('rejects bad mod value', () => {
    expect(() => composeChave43({ ...BASE, mod: '42' as never })).toThrow(NFeChaveError);
  });

  it.each([
    ['cUF', '3'],
    ['aamm', '200'],
    ['cnpjOrCpf', '14200166'],
    ['serie', '01'],
    ['nNF', '7'],
    ['tpEmis', ''],
    ['cNF', '1'],
  ] as const)('rejects wrong-length %s', (field, badValue) => {
    expect(() =>
      composeChave43({ ...BASE, [field]: badValue } as never),
    ).toThrow(NFeChaveError);
  });
});

describe('composeChave', () => {
  it('returns chave + DV together', () => {
    const result = composeChave({
      cUF: '35',
      aamm: '2007',
      cnpjOrCpf: '14200166000187',
      mod: '55',
      serie: '001',
      nNF: '000000007',
      tpEmis: '1',
      cNF: '00000001',
    });
    expect(result.chave).toBe('35200714200166000187550010000000071000000018');
    expect(result.chave).toHaveLength(44);
    expect(result.cDV).toBe(8);
  });
});

describe('aammFromDate', () => {
  it('extracts AA and MM from a Date', () => {
    expect(aammFromDate(new Date(2026, 4, 20))).toBe('2605');
  });

  it('zero-pads single-digit months', () => {
    expect(aammFromDate(new Date(2026, 0, 1))).toBe('2601');
  });

  it('wraps year on the century boundary', () => {
    expect(aammFromDate(new Date(2100, 11, 31))).toBe('0012');
  });
});

describe('randomCNF', () => {
  it('always returns 8 digits', () => {
    for (let i = 0; i < 50; i++) {
      const cNF = randomCNF('000000123');
      expect(cNF).toMatch(/^\d{8}$/);
    }
  });

  it('never equals the last 8 digits of nNF', () => {
    for (let i = 0; i < 50; i++) {
      const cNF = randomCNF('000000123');
      expect(cNF).not.toBe('00000123');
    }
  });

  it('rejects malformed nNF', () => {
    expect(() => randomCNF('123')).toThrow(NFeChaveError);
  });
});
