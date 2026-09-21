import { describe, expect, it } from 'vitest';
import {
  formatCNPJ,
  formatCPF,
  formatCpfCnpj,
  normalizeDocumento,
  validateCNPJ,
  validateCPF,
  validateCpfCnpj,
} from './br';

// Valid samples generated with public algorithms; use widely-known
// test fixtures so failures are easy to reason about.
const VALID_CPF = '52998224725';
const VALID_CPF_FORMATTED = '529.982.247-25';
const VALID_CNPJ = '11222333000181';
const VALID_CNPJ_FORMATTED = '11.222.333/0001-81';
// SERPRO's published alphanumeric example (IN RFB 2.229/2024); DVs 3 and 5.
const VALID_CNPJ_ALPHA = '12ABC34501DE35';
const VALID_CNPJ_ALPHA_FORMATTED = '12.ABC.345/01DE-35';

describe('validateCPF', () => {
  it('accepts a valid CPF with no formatting', () => {
    expect(validateCPF(VALID_CPF)).toBe(true);
  });

  it('accepts a valid CPF with punctuation', () => {
    expect(validateCPF(VALID_CPF_FORMATTED)).toBe(true);
  });

  it('rejects all-same-digit inputs (degenerate)', () => {
    expect(validateCPF('00000000000')).toBe(false);
    expect(validateCPF('11111111111')).toBe(false);
  });

  it('rejects CPFs with wrong checksum', () => {
    // Flip the last digit
    expect(validateCPF('52998224726')).toBe(false);
  });

  it('rejects strings of incorrect length', () => {
    expect(validateCPF('123')).toBe(false);
    expect(validateCPF('1234567890')).toBe(false); // 10 digits
    expect(validateCPF('123456789012')).toBe(false); // 12 digits
  });
});

describe('validateCNPJ', () => {
  it('accepts a valid CNPJ with no formatting', () => {
    expect(validateCNPJ(VALID_CNPJ)).toBe(true);
  });

  it('accepts a valid CNPJ with punctuation', () => {
    expect(validateCNPJ(VALID_CNPJ_FORMATTED)).toBe(true);
  });

  it('rejects all-same-digit inputs', () => {
    expect(validateCNPJ('00000000000000')).toBe(false);
    expect(validateCNPJ('99999999999999')).toBe(false);
  });

  it('rejects CNPJs with wrong checksum', () => {
    expect(validateCNPJ('11222333000182')).toBe(false);
  });

  it('rejects strings of incorrect length', () => {
    expect(validateCNPJ('11222333')).toBe(false);
    expect(validateCNPJ('112223330001811')).toBe(false);
  });

  it('accepts a valid alphanumeric CNPJ (IN RFB 2.229/2024)', () => {
    expect(validateCNPJ(VALID_CNPJ_ALPHA)).toBe(true);
    expect(validateCNPJ(VALID_CNPJ_ALPHA_FORMATTED)).toBe(true);
  });

  it('accepts lowercase alphanumeric input via uppercase cleaning', () => {
    expect(validateCNPJ('12abc34501de35')).toBe(true);
  });

  it('rejects an alphanumeric CNPJ with wrong checksum', () => {
    expect(validateCNPJ('12ABC34501DE36')).toBe(false);
    expect(validateCNPJ('12ABC34501DE45')).toBe(false);
  });

  it('rejects letters in the check-digit positions', () => {
    expect(validateCNPJ('12ABC34501DEA5')).toBe(false);
    expect(validateCNPJ('12ABC34501DE3A')).toBe(false);
  });
});

describe('validateCpfCnpj', () => {
  it('routes 11 chars to CPF validation', () => {
    expect(validateCpfCnpj(VALID_CPF)).toBe(true);
    expect(validateCpfCnpj('12345678901')).toBe(false);
  });

  it('routes 14 chars to CNPJ validation (numeric and alphanumeric)', () => {
    expect(validateCpfCnpj(VALID_CNPJ)).toBe(true);
    expect(validateCpfCnpj(VALID_CNPJ_ALPHA)).toBe(true);
    expect(validateCpfCnpj('11222333000182')).toBe(false);
  });

  it('rejects any other length', () => {
    expect(validateCpfCnpj('')).toBe(false);
    expect(validateCpfCnpj('123')).toBe(false);
    expect(validateCpfCnpj('1234567890123')).toBe(false);
  });

  it('cleans punctuation before routing by length', () => {
    expect(validateCpfCnpj(VALID_CPF_FORMATTED)).toBe(true);
    expect(validateCpfCnpj(VALID_CNPJ_ALPHA_FORMATTED)).toBe(true);
  });
});

describe('formatCPF', () => {
  it('formats an 11-digit CPF', () => {
    expect(formatCPF(VALID_CPF)).toBe(VALID_CPF_FORMATTED);
  });

  it('returns digits-only for partial input', () => {
    expect(formatCPF('5299822')).toBe('5299822');
  });

  it('strips non-digits before formatting', () => {
    expect(formatCPF(VALID_CPF_FORMATTED)).toBe(VALID_CPF_FORMATTED);
  });
});

describe('formatCNPJ', () => {
  it('formats a 14-digit CNPJ', () => {
    expect(formatCNPJ(VALID_CNPJ)).toBe(VALID_CNPJ_FORMATTED);
  });

  it('returns digits-only for partial input', () => {
    expect(formatCNPJ('1122233')).toBe('1122233');
  });

  it('formats an alphanumeric CNPJ with the same mask', () => {
    expect(formatCNPJ(VALID_CNPJ_ALPHA)).toBe(VALID_CNPJ_ALPHA_FORMATTED);
    expect(formatCNPJ('12abc34501de35')).toBe(VALID_CNPJ_ALPHA_FORMATTED);
  });
});

describe('normalizeDocumento', () => {
  it('strips the usual punctuation and whitespace', () => {
    expect(normalizeDocumento(VALID_CPF_FORMATTED)).toBe(VALID_CPF);
    expect(normalizeDocumento(VALID_CNPJ_FORMATTED)).toBe(VALID_CNPJ);
    expect(normalizeDocumento(' 529.982.247-25 ')).toBe(VALID_CPF);
  });

  it('keeps letters and uppercases them — the alphanumeric CNPJ must survive', () => {
    expect(normalizeDocumento(VALID_CNPJ_ALPHA_FORMATTED)).toBe(VALID_CNPJ_ALPHA);
    expect(normalizeDocumento('12.abc.345/01de-35')).toBe(VALID_CNPJ_ALPHA);
  });

  it('is idempotent — an already-canonical value is returned unchanged', () => {
    expect(normalizeDocumento(VALID_CPF)).toBe(VALID_CPF);
    expect(normalizeDocumento(normalizeDocumento(VALID_CNPJ_ALPHA_FORMATTED))).toBe(
      VALID_CNPJ_ALPHA,
    );
  });

  it('maps an empty string to an empty string', () => {
    expect(normalizeDocumento('')).toBe('');
  });
});

describe('formatCpfCnpj', () => {
  it('formats a CPF and a CNPJ by length, punctuated or not', () => {
    expect(formatCpfCnpj(VALID_CPF)).toBe(VALID_CPF_FORMATTED);
    expect(formatCpfCnpj(VALID_CNPJ)).toBe(VALID_CNPJ_FORMATTED);
    expect(formatCpfCnpj(` ${VALID_CNPJ_FORMATTED} `)).toBe(VALID_CNPJ_FORMATTED);
  });

  it('masks an alphanumeric CNPJ POSITIONALLY — the bug the three copies had', () => {
    // Two of the copies this replaces stripped non-digits first, which leaves
    // `12ABC34501DE35` eleven digits long and renders it as a CPF:
    // `123.450.135` + `-??`. On a DANFE that is somebody else's document.
    expect(formatCpfCnpj(VALID_CNPJ_ALPHA)).toBe(VALID_CNPJ_ALPHA_FORMATTED);
    expect(formatCpfCnpj('12abc34501de35')).toBe(VALID_CNPJ_ALPHA_FORMATTED);
    expect(formatCpfCnpj(VALID_CNPJ_ALPHA_FORMATTED)).toBe(VALID_CNPJ_ALPHA_FORMATTED);
  });

  it('⚠️ NEAR-MISS: it FORMATS, it does not validate — a bad DV still masks', () => {
    // `formatCpfCnpj` answers "how is this written down" and `validateCpfCnpj`
    // answers "is this real". A formatter that blanked an invalid stored value
    // would make a bad row invisible on the very screen meant to show it.
    expect(validateCpfCnpj('12ABC34501DE99')).toBe(false);
    expect(formatCpfCnpj('12ABC34501DE99')).toBe('12.ABC.345/01DE-99');
  });

  it('⚠️ NEAR-MISS: the two check digits must be NUMERIC — 14 letters is not a CNPJ', () => {
    expect(formatCpfCnpj('ABCDEFGHIJKLMN')).toBe('ABCDEFGHIJKLMN');
  });

  it('returns anything of the wrong length exactly as given', () => {
    expect(formatCpfCnpj('123')).toBe('123');
    expect(formatCpfCnpj('')).toBe('');
    // Untouched, punctuation and all — never the normalised form.
    expect(formatCpfCnpj('(11) 3322-4455')).toBe('(11) 3322-4455');
  });
});
