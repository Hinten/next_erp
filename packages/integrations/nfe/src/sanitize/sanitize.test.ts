import { describe, it, expect } from 'vitest';
import { removerAcentos, removerCharRestrito, sanitizeNFeText } from './index';

describe('removerAcentos', () => {
  it('strips diacritics', () => {
    expect(removerAcentos('João Conceição Açaí Über')).toBe('Joao Conceicao Acai Uber');
  });
  it('leaves unaccented text untouched', () => {
    expect(removerAcentos('RUA DAS FLORES 123')).toBe('RUA DAS FLORES 123');
  });
});

describe('removerCharRestrito', () => {
  it('drops characters SEFAZ rejects', () => {
    expect(removerCharRestrito('Produto XYZ 100% algodao | Tam. G')).toBe(
      'Produto XYZ 100 algodao Tam. G',
    );
  });
  it('keeps XML-significant characters raw — the serializer escapes them', () => {
    expect(removerCharRestrito('DIAS & DIAS LTDA')).toBe('DIAS & DIAS LTDA');
  });
  it('converts line breaks and tabs to spaces and collapses runs', () => {
    expect(removerCharRestrito('Rua A\n\n\tApto 1')).toBe('Rua A Apto 1');
  });
  it('preserves basic punctuation', () => {
    expect(removerCharRestrito('Apto. 45-B, sala 2/3 (fundos)')).toBe(
      'Apto. 45-B, sala 2/3 (fundos)',
    );
  });
});

describe('sanitizeNFeText', () => {
  it('returns null for blank or nullish input', () => {
    expect(sanitizeNFeText('   ')).toBeNull();
    expect(sanitizeNFeText(null)).toBeNull();
    expect(sanitizeNFeText(undefined)).toBeNull();
  });
  it('strips accents then restricted characters and trims', () => {
    expect(sanitizeNFeText('  Endereço #42  ')).toBe('Endereco 42');
  });
});
