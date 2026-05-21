import { describe, it, expect } from 'vitest';
import { removerAcentos, removerCharRestrito, sanitizeNFeText } from '../../src/sanitize/index';

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
  it('drops smart typography (em/en dash, curly quotes, ellipsis) above U+00FF', () => {
    // XSD TString pattern is `[!-ÿ]` — anything above U+00FF fails the
    // facet at the pre-send gate. Drop them here so the XML never carries
    // them across the boundary. Adjacent spaces are then collapsed.
    expect(removerCharRestrito('EMPRESA & CIA. LTDA — ME')).toBe(
      'EMPRESA & CIA. LTDA ME',
    );
    expect(removerCharRestrito('Rua A – Bloco B')).toBe('Rua A Bloco B');
    expect(removerCharRestrito('“aspas” e ‘curvas’')).toBe('aspas e curvas');
    expect(removerCharRestrito('Tres pontos…')).toBe('Tres pontos');
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

  describe('maxLen — XSD facet truncation', () => {
    it('passes through inputs shorter than maxLen unchanged', () => {
      expect(sanitizeNFeText('Avenida Paulista 1500', 60)).toBe(
        'Avenida Paulista 1500',
      );
    });
    it('truncates to maxLen and trims a trailing partial space', () => {
      // 70-char input; after slice(0, 60) → 60 chars; in this fixture the
      // 60th char is a space, so trimEnd brings the result to 59 chars.
      const input = 'Rua das Acucenas numero 1234 Bloco A apto 101 segundo andar quadra X';
      const out = sanitizeNFeText(input, 60);
      expect(out).not.toBeNull();
      expect(out!.length).toBeLessThanOrEqual(60);
      expect(out!.endsWith(' ')).toBe(false);
      expect(input).toContain(out!); // truncation is a prefix
    });
    it('still returns null when input is blank even with maxLen set', () => {
      expect(sanitizeNFeText('   ', 60)).toBeNull();
      expect(sanitizeNFeText(null, 60)).toBeNull();
    });
    it('applies sanitization before truncation (length is post-sanitize)', () => {
      // The `@` is restricted, so it's dropped before measuring length.
      // Raw input is 8 chars, post-sanitize is 7, maxLen=10 → passthrough.
      expect(sanitizeNFeText('A@B@C@D@', 10)).toBe('ABCD');
    });
  });
});
