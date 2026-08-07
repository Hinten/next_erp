import { describe, expect, it } from 'vitest';

import { formatCep, formatCpfCnpj, formatReais, formatTelefone, obscure } from './format';

describe('formatCpfCnpj', () => {
  it('formats an 11-digit CPF', () => {
    expect(formatCpfCnpj('12345678900')).toBe('123.456.789-00');
  });
  it('formats a 14-digit CNPJ', () => {
    expect(formatCpfCnpj('12345678000190')).toBe('12.345.678/0001-90');
  });
  it('masks an alphanumeric CNPJ positionally (IN RFB 2.229/2024)', () => {
    expect(formatCpfCnpj('12ABC678000190')).toBe('12.ABC.678/0001-90');
  });
  it('returns wrong-length input unchanged', () => {
    expect(formatCpfCnpj('123')).toBe('123');
  });
});

describe('formatCep', () => {
  it('formats an 8-digit CEP', () => {
    expect(formatCep('01310100')).toBe('01310-100');
  });
  it('returns non-8-digit input unchanged', () => {
    expect(formatCep('123')).toBe('123');
  });
});

describe('formatTelefone', () => {
  it('formats an 11-digit mobile', () => {
    expect(formatTelefone('11987654321')).toBe('(11) 98765-4321');
  });
  it('formats a 10-digit landline', () => {
    expect(formatTelefone('1133334444')).toBe('(11) 3333-4444');
  });
  it('returns other lengths unchanged', () => {
    expect(formatTelefone('999')).toBe('999');
  });
  it('formats a value stored in this repo’s wire format', () => {
    // The re-export from @delfrance/core/phone strips the `55` before masking.
    // Every print sheet importing this used to render the raw 13 digits.
    expect(formatTelefone('5511987654321')).toBe('(11) 98765-4321');
  });
});

describe('obscure', () => {
  it('masks all but the last 3 chars', () => {
    expect(obscure('123.456.789-00')).toBe('***********-00');
  });
  it('honours a custom showLast', () => {
    expect(obscure('ABCDEF', 2)).toBe('****EF');
  });
  it('returns short values unchanged', () => {
    expect(obscure('AB')).toBe('AB');
    expect(obscure('XYZ')).toBe('XYZ');
  });
});

describe('formatReais (re-exported)', () => {
  it('formats reais as BRL', () => {
    // pt-BR Intl puts a (narrow) no-break space between the symbol and the
    // number; `\s` matches it across ICU versions.
    expect(formatReais(1234.5)).toMatch(/^R\$\s1\.234,50$/);
  });
});
