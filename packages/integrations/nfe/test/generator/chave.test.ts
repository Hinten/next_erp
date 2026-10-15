import { describe, it, expect } from 'vitest';
import { CHAVE_NFE_REGEX } from '@delfrance/schemas';
import { validateCNPJ } from '@delfrance/core/documents';
import {
  aammFromDate,
  composeChave,
  composeChave43,
  computeCDV,
  extractCNFFromChave,
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

  it('rejects wrong-length input, and lowercase at any position', () => {
    expect(() => computeCDV('123')).toThrow(NFeChaveError);
    // Lowercase is rejected even at 43 chars: the chave's alfa window is
    // `[0-9A-Z]`, so a lowercase value is not merely invalid, it is
    // non-canonical — see the note on `filialSchema.cnpj`.
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
    expect(() => composeChave43({ ...BASE, nNF: '000000001', cNF: '00000001' })).toThrow(
      NFeChaveError,
    );
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
    expect(() => composeChave43({ ...BASE, [field]: badValue } as never)).toThrow(NFeChaveError);
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
  // Explicit instants + explicit offset: the result must be identical on any
  // runner TZ (the whole point of #395). -180 = Brasília/SP legal time.
  const SP = -180;

  it('extracts AA and MM from an instant in the issuer offset', () => {
    expect(aammFromDate(new Date('2026-05-20T10:30:00-03:00'), SP)).toBe('2605');
  });

  it('zero-pads single-digit months', () => {
    expect(aammFromDate(new Date('2026-01-01T00:00:00-03:00'), SP)).toBe('2601');
  });

  it('wraps year on the century boundary', () => {
    expect(aammFromDate(new Date('2100-12-31T12:00:00-03:00'), SP)).toBe('0012');
  });

  it('uses the ISSUER-offset date, not UTC: 00:30Z on Jan 1 is still December in Brazil', () => {
    // The #395 bug: on a UTC deploy, a sale at 21:30 BRT on Dec 31 got the
    // NEXT year/month in the chave. The instant below IS Jan 1 in UTC but
    // Dec 31 21:30 in SP legal time — AAMM must say 2512.
    expect(aammFromDate(new Date('2026-01-01T00:30:00Z'), SP)).toBe('2512');
  });

  it('respects the per-UF offset: 03:30Z is still the previous day in Acre (-05:00)', () => {
    expect(aammFromDate(new Date('2026-06-01T03:30:00Z'), -300)).toBe('2605');
    expect(aammFromDate(new Date('2026-06-01T03:30:00Z'), SP)).toBe('2606');
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

describe('extractCNFFromChave', () => {
  it('recovers the cNF baked into a composeChave output', () => {
    const { chave } = composeChave({
      cUF: '35',
      aamm: '2007',
      cnpjOrCpf: '14200166000187',
      mod: '55',
      serie: '001',
      nNF: '000000007',
      tpEmis: '1',
      cNF: '00000001',
    });
    expect(extractCNFFromChave(chave)).toBe('00000001');
  });

  it('reads cNF from a fixed 44-digit chave at offsets [35, 43)', () => {
    // Same fixture as composeChave43's golden test, plus DV=8 → 44 digits.
    expect(extractCNFFromChave('35200714200166000187550010000000071000000018')).toBe('00000001');
  });

  it('rejects wrong-length input', () => {
    expect(() => extractCNFFromChave('123')).toThrow(NFeChaveError);
    expect(() => extractCNFFromChave('1'.repeat(43))).toThrow(NFeChaveError);
    expect(() => extractCNFFromChave('1'.repeat(45))).toThrow(NFeChaveError);
  });

  it('rejects lowercase, and a letter outside the alfa window', () => {
    expect(() => extractCNFFromChave('a'.repeat(44))).toThrow(NFeChaveError);
    // A letter at position 20 (the `mod` field) is outside positions 6–17.
    expect(() => extractCNFFromChave(`432601PC3D315K000193A5001000000007100000001` + '2')).toThrow(
      NFeChaveError,
    );
  });
});

/**
 * CNPJ alfanumérico (RFB IN 2.229/2024 · NF-e NT 2026.004) on the EMITENTE.
 *
 * The chave's alphanumeric window is **exactly positions 6–17** — the CNPJ's
 * 12-character body. Its two check digits and every other field stay numeric,
 * which is what `CHAVE_NFE_REGEX` spells out.
 *
 * ⚠️ The DV rule is `ASCII − 48` per character, NOT `Number(c)`. `Number('A')`
 * is `NaN`, which propagated through the whole sum and made `cDV.toString()`
 * the literal string `'NaN'` — a 46-character chave carrying `<cDV>NaN</cDV>`
 * with nothing throwing. Every expectation below is pinned against
 * `dvOracle`, a deliberately DIFFERENT formulation of the same rule (left to
 * right, with an explicit alphabet lookup instead of `charCodeAt`), so the two
 * agreeing means more than the implementation agreeing with itself.
 */
describe('chave with an ALPHANUMERIC emitente CNPJ', () => {
  /** `index === ASCII − 48`, so '0'→0 … '9'→9 and 'A'→17 … 'Z'→42. */
  const ALPHA = '0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  function dvOracle(chave43: string): number {
    const n = chave43.length;
    let soma = 0;
    for (let i = 0; i < n; i++) {
      const valor = ALPHA.indexOf(chave43[i]!);
      expect(valor).toBeGreaterThanOrEqual(0);
      soma += valor * (((n - 1 - i) % 8) + 2);
    }
    const resto = soma % 11;
    return resto <= 1 ? 0 : 11 - resto;
  }

  // Real rows from SEFAZ's published alfa-CNPJ table, the same values
  // `test/xsd/cnpj-alfanumerico.test.ts` pins. `MMH9SKDL539Y64` is the sharp
  // one — a letter at body position 11, immediately before the check digits.
  const RS = { cUF: '43', cnpj: 'PC3D315K000193' } as const;
  const MG = { cUF: '31', cnpj: 'MMH9SKDL539Y64' } as const;

  const partsFor = (uf: string, cnpj: string) =>
    ({
      cUF: uf,
      aamm: '2601',
      cnpjOrCpf: cnpj,
      mod: '55' as const,
      serie: '001',
      nNF: '000000007',
      tpEmis: '1',
      cNF: '00000001',
    }) as const;

  it('the independent oracle reproduces the known-good NUMERIC DV', () => {
    // Validates the oracle itself before anything below leans on it: this is
    // the same 43-digit fixture the `computeCDV` golden test uses, DV = 8.
    expect(dvOracle('3520071420016600018755001000000007100000001')).toBe(8);
  });

  it.each([
    [RS.cUF, RS.cnpj, 2],
    [MG.cUF, MG.cnpj, 4],
  ])('composeChave(%s, %s) yields a 44-char chave with cDV %i', (uf, cnpj, expectedDV) => {
    const { chave, cDV } = composeChave(partsFor(uf, cnpj));

    expect(chave).toHaveLength(44);
    expect(cDV).toBe(expectedDV);
    expect(dvOracle(chave.slice(0, 43))).toBe(expectedDV);
    expect(CHAVE_NFE_REGEX.test(chave)).toBe(true);
    // The CNPJ lands in positions 6–17 plus its two numeric DVs — the window
    // every `chave.slice(6, 20)` consumer reads back out.
    expect(chave.slice(6, 20)).toBe(cnpj);
    expect(validateCNPJ(cnpj)).toBe(true);
  });

  it('the letters PARTICIPATE in the DV — the near-miss', () => {
    // Same chave, one letter changed. If the alfa positions were being
    // dropped, coerced to NaN or otherwise ignored, these would collide.
    const a = composeChave(partsFor(RS.cUF, 'PC3D315K000193')).cDV;
    const b = composeChave(partsFor(RS.cUF, 'QC3D315K000193')).cDV;
    expect(a).not.toBe(b);
  });

  it('survives the re-emission round trip', () => {
    // `extractCNFFromChave` is on the retry path in `orchestrator/emitir.ts`;
    // a numeric-only guard there threw AFTER a successful first emit.
    const { chave } = composeChave(partsFor(RS.cUF, RS.cnpj));
    expect(extractCNFFromChave(chave)).toBe('00000001');
  });

  it('rejects a lowercase CNPJ — the canonical form is uppercase', () => {
    expect(() => composeChave(partsFor(RS.cUF, 'pc3d315k000193'))).toThrow(NFeChaveError);
  });

  it('rejects a letter in either CNPJ check-digit position', () => {
    // `[0-9A-Z]{12}[0-9]{2}`, never `[0-9A-Z]{14}`.
    expect(() => composeChave(partsFor(RS.cUF, 'PC3D315K0001A3'))).toThrow(NFeChaveError);
    expect(() => composeChave(partsFor(RS.cUF, 'PC3D315K00019A'))).toThrow(NFeChaveError);
  });

  it('rejects a letter in a field that is NOT the CNPJ', () => {
    expect(() => composeChave({ ...partsFor(RS.cUF, RS.cnpj), cUF: '4A' })).toThrow(NFeChaveError);
    expect(() => composeChave({ ...partsFor(RS.cUF, RS.cnpj), serie: '0A1' })).toThrow(
      NFeChaveError,
    );
    expect(() => composeChave({ ...partsFor(RS.cUF, RS.cnpj), cNF: '0000000A' })).toThrow(
      NFeChaveError,
    );
  });

  it('a CPF emitente zero-padded to 14 still composes', () => {
    // Produtor Rural: `generator/index.ts` pads an 11-digit CPF to 14, which is
    // a subset of `[0-9A-Z]{12}[0-9]{2}` — no separate arm needed.
    const { chave } = composeChave(partsFor('35', '00052998224725'));
    expect(chave).toHaveLength(44);
    expect(CHAVE_NFE_REGEX.test(chave)).toBe(true);
  });
});
