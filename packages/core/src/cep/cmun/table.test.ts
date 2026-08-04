import { describe, expect, it } from 'vitest';
import { type CMunRange, decodeCMunTable, encodeCMunTable } from './codec';
import { lookupCodigoMunicipioIn, searchRanges } from './table';

/**
 * Two faixas with a deliberate GAP between them (1_200_000 … 1_999_999) and a
 * deliberate void above the last one. Small enough to reason about exactly.
 */
const RANGES: readonly CMunRange[] = [
  { cepInicial: 1_000_000, cepFinal: 1_099_999, cMun: 3_550_308 }, // São Paulo
  { cepInicial: 1_100_000, cepFinal: 1_199_999, cMun: 3_550_308 }, // adjacent, same município
  { cepInicial: 2_000_000, cepFinal: 2_099_999, cMun: 3_304_557 }, // Rio de Janeiro
];

const TABLE = decodeCMunTable(encodeCMunTable(RANGES));

describe('searchRanges', () => {
  it('finds the faixa containing a CEP', () => {
    expect(searchRanges(TABLE, 1_050_000)).toBe(0);
    expect(searchRanges(TABLE, 1_150_000)).toBe(1);
    expect(searchRanges(TABLE, 2_050_000)).toBe(2);
  });

  it('treats both faixa bounds as inclusive', () => {
    expect(searchRanges(TABLE, 1_000_000)).toBe(0); // exactly cepInicial
    expect(searchRanges(TABLE, 1_099_999)).toBe(0); // exactly cepFinal
    expect(searchRanges(TABLE, 1_100_000)).toBe(1); // cepFinal + 1 → next faixa
  });

  it('returns -1 for a CEP below the first faixa', () => {
    expect(searchRanges(TABLE, 999_999)).toBe(-1);
    expect(searchRanges(TABLE, 0)).toBe(-1);
  });

  it('returns -1 for a CEP above the last faixa', () => {
    expect(searchRanges(TABLE, 2_100_000)).toBe(-1);
    expect(searchRanges(TABLE, 99_999_999)).toBe(-1);
  });

  /**
   * THE regression this port exists to prevent.
   *
   * The legacy Flutter query (`.old/packages/clientes/lib/src/models.dart:1069-1075`)
   * filtered on `cepFinal >= cep` with an inert `startAt` cursor and NO
   * `cepInicial <= cep` predicate. For a CEP in a gap it therefore returned
   * the NEXT faixa above — here, Rio de Janeiro's 3304557 for a CEP that
   * belongs to no faixa at all — and that wrong código went straight into the
   * signed NF-e XML with nothing to flag it. We return -1 and let the caller
   * fall through to ViaCEP. See #785.
   */
  it('returns -1 for a CEP in a GAP between faixas (the legacy bug)', () => {
    expect(searchRanges(TABLE, 1_200_000)).toBe(-1); // first CEP after faixa 1
    expect(searchRanges(TABLE, 1_500_000)).toBe(-1); // mid-gap
    expect(searchRanges(TABLE, 1_999_999)).toBe(-1); // last CEP before faixa 2
  });

  it('returns -1 on an empty table', () => {
    expect(searchRanges(decodeCMunTable(encodeCMunTable([])), 1_050_000)).toBe(-1);
  });
});

describe('lookupCodigoMunicipioIn', () => {
  it('resolves a clean or formatted CEP', () => {
    expect(lookupCodigoMunicipioIn(TABLE, '01050000')).toBe('3550308');
    expect(lookupCodigoMunicipioIn(TABLE, '01050-000')).toBe('3550308');
  });

  it('handles the leading zero the legacy int.parse dropped', () => {
    // `cepInicial`/`cepFinal` are stored as INTEGERS (the legacy CSV import ran
    // `int.parse`), so '01000000' must compare as 1_000_000, not fail to parse.
    expect(lookupCodigoMunicipioIn(TABLE, '01000000')).toBe('3550308');
  });

  it('returns null for a CEP in a gap', () => {
    expect(lookupCodigoMunicipioIn(TABLE, '01500000')).toBeNull();
  });

  it('returns null for a malformed CEP without throwing', () => {
    expect(lookupCodigoMunicipioIn(TABLE, '0105000')).toBeNull(); // 7 digits
    expect(lookupCodigoMunicipioIn(TABLE, '')).toBeNull();
    expect(lookupCodigoMunicipioIn(TABLE, 'abcdefgh')).toBeNull();
  });

  it('never zero-pads — every real cMun is 7 digits', () => {
    // IBGE state prefixes run 11..53, so the first digit is 1-5 and the decimal
    // string is always 7 chars.
    const resolved = lookupCodigoMunicipioIn(TABLE, '02050000');
    expect(resolved).toBe('3304557');
    expect(resolved).toHaveLength(7);
  });
});
