import { describe, it, expect } from 'vitest';
import {
  removerAcentos,
  removerCharRestrito,
  sanitizeNFeText,
  temTextoCorrompido,
} from '../../src/sanitize/index';

/* ------------------------- corruption fixture builders ---------------------- */
//
// Every corrupted fixture below is BUILT FROM BYTES rather than pasted as a
// literal. That documents which mis-decode produced it, and keeps this file (and
// the repo) free of the very characters the detector exists to find — a
// repo-wide U+FFFD or digraph scan stays meaningful.

/** The legacy defect: a UTF-8 body read back as latin1 (Dart `Response.body`). */
const comoLatin1 = (s: string): string => Buffer.from(s, 'utf8').toString('latin1');

/** The same mis-read under cp1252, which remaps the bytes 0x80..0x9F. */
const comoCp1252 = (s: string): string =>
  new TextDecoder('windows-1252').decode(Buffer.from(s, 'utf8'));

/** A genuine latin1 body run through a lenient UTF-8 decode → U+FFFD. */
const comFffd = (s: string): string => new TextDecoder('utf-8').decode(Buffer.from(s, 'latin1'));

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
    expect(removerCharRestrito('EMPRESA & CIA. LTDA — ME')).toBe('EMPRESA & CIA. LTDA ME');
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
      expect(sanitizeNFeText('Avenida Paulista 1500', 60)).toBe('Avenida Paulista 1500');
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

describe('temTextoCorrompido', () => {
  describe('detects a UTF-8 payload read back as a single-byte encoding', () => {
    it.each([
      'São Paulo',
      'Aclimação',
      'José',
      'PARANÁ',
      'Rua Sete de Setembro, Térreo',
      'MARANHÃO',
    ])('latin1 mis-read of %j', (limpo) => {
      expect(temTextoCorrompido(comoLatin1(limpo))).toBe(true);
    });

    it.each(['São Paulo', 'Aclimação', 'PARANÁ'])('cp1252 mis-read of %j', (limpo) => {
      expect(temTextoCorrompido(comoCp1252(limpo))).toBe(true);
    });

    it('catches smart typography, whose UTF-8 lead is E2 rather than C2/C3', () => {
      // Marketplace exports ship these routinely. Note the latin1 and cp1252
      // reads DIFFER here (E2 80 99 → `â`+U+0080+U+0099 vs `â`+U+20AC+U+2122),
      // so the detector must key on the lead + continuation class, not on one
      // rendered digraph.
      expect(temTextoCorrompido(comoLatin1('Rua D’Oeste'))).toBe(true);
      expect(temTextoCorrompido(comoCp1252('Rua D’Oeste'))).toBe(true);
      expect(temTextoCorrompido(comoLatin1('Bloco A — fundos'))).toBe(true);
      expect(temTextoCorrompido(comoCp1252('Bloco A — fundos'))).toBe(true);
    });

    it('a lead character alone is not evidence — Portuguese uses all three', () => {
      // `Ã`, `Â` and `â` are ordinary letters; only a lead followed by a
      // continuation-class character (which holds no letters) is the signature.
      expect(temTextoCorrompido('CÂMARA')).toBe(false);
      expect(temTextoCorrompido('câmara municipal')).toBe(false);
      expect(temTextoCorrompido('ângulo')).toBe(false);
      expect(temTextoCorrompido('SÃO JOÃO')).toBe(false);
    });
  });

  describe('detects the unrecoverable U+FFFD class', () => {
    it.each(['São Paulo', 'Aclimação', 'PARANÁ'])(
      'a latin1 body leniently decoded as UTF-8: %j',
      (limpo) => {
        expect(temTextoCorrompido(comFffd(limpo))).toBe(true);
      },
    );

    it('reproduces the legacy workaround key pinned in constantes.dart (issue #788)', () => {
      // The Dart source carried `PARAN` + TWO U+FFFD. Two is the fingerprint of
      // a UTF-8 body read as latin1 (2 chars, both lost in a later re-encode);
      // a genuine latin1 body read as UTF-8 yields exactly ONE. That count is
      // what identifies the legacy fallback as the CAUSE, not the cure.
      const FFFD = String.fromCharCode(0xfffd);
      const doisFffd = 'PARAN' + FFFD.repeat(2);
      expect([...comoLatin1('PARANÁ')].length - 'PARAN'.length).toBe(2);
      expect([...comFffd('PARANÁ')].filter((c) => c === FFFD).length).toBe(1);
      expect(temTextoCorrompido(doisFffd)).toBe(true);
    });
  });

  describe('does not fire on legitimate Portuguese', () => {
    it.each([
      // `Ã`/`Â` next to a LETTER is ordinary uppercase Portuguese.
      'SÃO PAULO',
      'MARANHÃO',
      'CÂMARA MUNICIPAL',
      'JOÃO PESSOA',
      // The ordinals Brazilian addresses are full of — they follow a digit.
      'Rua Sete, 1º andar',
      'Av. Paulista, 2ª sobreloja',
      // Correctly-encoded accented text, the overwhelmingly common case.
      'Rua Aclimação',
      'São Paulo',
      'José Bonifácio',
      'Conceição da Barra',
      // Plain ASCII and the restricted characters the sanitiser handles.
      'RUA DAS FLORES 123',
      'DIAS & DIAS LTDA',
      'Produto XYZ 100% algodao | Tam. G',
    ])('%j', (limpo) => {
      expect(temTextoCorrompido(limpo)).toBe(false);
    });

    it('treats absent and blank input as clean', () => {
      expect(temTextoCorrompido(null)).toBe(false);
      expect(temTextoCorrompido(undefined)).toBe(false);
      expect(temTextoCorrompido('')).toBe(false);
      expect(temTextoCorrompido('   ')).toBe(false);
    });
  });

  describe('why the check must run BEFORE the sanitiser', () => {
    // This is the whole reason the gate exists: sanitisation does not merely
    // fail to detect corruption, it ERASES the evidence and emits text that
    // looks like a legitimate spelling.
    it.each([
      ['São Paulo', 'SAo Paulo'],
      ['Aclimação', 'AclimaAAo'],
      ['José', 'JosA'],
    ])('the latin1 mis-read of %j sanitises to the plausible ASCII %j', (limpo, laundered) => {
      const corrompido = comoLatin1(limpo);
      expect(temTextoCorrompido(corrompido)).toBe(true);
      expect(sanitizeNFeText(corrompido)).toBe(laundered);
      // …and after sanitising, the detector can no longer see anything wrong.
      expect(temTextoCorrompido(sanitizeNFeText(corrompido))).toBe(false);
    });

    it('U+FFFD is dropped as > 0xFF, leaving a legitimate-looking spelling', () => {
      const corrompido = comFffd('São Paulo');
      expect(temTextoCorrompido(corrompido)).toBe(true);
      expect(sanitizeNFeText(corrompido)).toBe('So Paulo');
      expect(temTextoCorrompido(sanitizeNFeText(corrompido))).toBe(false);
    });
  });
});
