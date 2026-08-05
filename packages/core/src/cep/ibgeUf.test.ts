import { describe, expect, it } from 'vitest';
import { IBGE_UF_CODES, codigoMunicipioMatchesUf, ufFromCodigoMunicipio } from './ibgeUf';

describe('IBGE_UF_CODES', () => {
  it('covers the 26 states + DF + the NF-e pseudo-UF EX', () => {
    expect(Object.keys(IBGE_UF_CODES)).toHaveLength(28);
    expect(IBGE_UF_CODES.SP).toBe('35');
    expect(IBGE_UF_CODES.EX).toBe('99');
  });

  it('maps every UF to a distinct 2-digit code', () => {
    const codes = Object.values(IBGE_UF_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^\d{2}$/);
  });
});

describe('ufFromCodigoMunicipio', () => {
  it('reads the UF off a 7-digit cMun prefix', () => {
    expect(ufFromCodigoMunicipio('3550308')).toBe('SP'); // São Paulo
    expect(ufFromCodigoMunicipio('3304557')).toBe('RJ'); // Rio de Janeiro
    expect(ufFromCodigoMunicipio('5300108')).toBe('DF'); // Brasília
  });

  it('returns null for anything that is not a 7-digit code', () => {
    expect(ufFromCodigoMunicipio('355030')).toBeNull();
    expect(ufFromCodigoMunicipio('35503080')).toBeNull();
    expect(ufFromCodigoMunicipio('')).toBeNull();
    expect(ufFromCodigoMunicipio(null)).toBeNull();
    expect(ufFromCodigoMunicipio(undefined)).toBeNull();
  });

  it('returns null for a prefix that is not a real state code', () => {
    expect(ufFromCodigoMunicipio('0050308')).toBeNull(); // 00 belongs to no UF
    expect(ufFromCodigoMunicipio('6650308')).toBeNull(); // 66 belongs to no UF
  });

  it('maps the 99 prefix to the NF-e pseudo-UF EX', () => {
    // SEFAZ uses cUF=99 / cMun=9999999 for the exterior; the map is the NF-e
    // one, so the round trip has to hold there too.
    expect(ufFromCodigoMunicipio('9999999')).toBe('EX');
  });
});

describe('codigoMunicipioMatchesUf', () => {
  it('accepts a matching pair, case-insensitively on the UF', () => {
    expect(codigoMunicipioMatchesUf('3550308', 'SP')).toBe(true);
    expect(codigoMunicipioMatchesUf('3550308', 'sp')).toBe(true);
  });

  it('rejects a mismatch — the SEFAZ-rejection-273 guard', () => {
    expect(codigoMunicipioMatchesUf('3550308', 'AC')).toBe(false);
  });

  it('rejects rather than passing when either side is missing', () => {
    expect(codigoMunicipioMatchesUf('3550308', null)).toBe(false);
    expect(codigoMunicipioMatchesUf('3550308', '')).toBe(false);
    expect(codigoMunicipioMatchesUf(null, 'SP')).toBe(false);
  });
});
