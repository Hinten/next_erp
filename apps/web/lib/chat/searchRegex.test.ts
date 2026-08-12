import { describe, expect, it } from 'vitest';
import { TIPO_MENSAGEM } from '@delfrance/schemas';

import { buildSearchRegex, searchableText, testRegex } from './searchRegex';

type SearchableInput = Parameters<typeof searchableText>[0];

/** Minimal message shape for `searchableText` — only the haystack fields. */
function m(partial: Partial<SearchableInput>): SearchableInput {
  return {
    tipo: TIPO_MENSAGEM.comum,
    conteudo: null,
    transcription: null,
    anexoDescription: null,
    image: null,
    video: null,
    sticker: null,
    genericDocument: null,
    ...partial,
  } as SearchableInput;
}

describe('buildSearchRegex', () => {
  it('returns a null regex for an empty / whitespace term', () => {
    expect(buildSearchRegex('')).toEqual({ regex: null, isLiteral: false });
    expect(buildSearchRegex('   ')).toEqual({ regex: null, isLiteral: false });
  });

  it('compiles a valid pattern with the case-insensitive unicode flags', () => {
    const { regex, isLiteral } = buildSearchRegex('Olá');
    expect(isLiteral).toBe(false);
    expect(regex).not.toBeNull();
    expect(regex!.flags).toContain('i');
    expect(regex!.flags).toContain('u');
    // Case-insensitive match.
    expect(testRegex(regex!).test('bem, OLÁ mundo')).toBe(true);
  });

  it('supports unicode / accented regex patterns', () => {
    const { regex } = buildSearchRegex('reação');
    expect(testRegex(regex!).test('ação e reação')).toBe(true);
  });

  it('falls back to a LITERAL search on an invalid (SyntaxError) pattern', () => {
    const { regex, isLiteral } = buildSearchRegex('(');
    expect(isLiteral).toBe(true);
    // The literal '(' is escaped, so it matches a real paren and nothing else.
    expect(testRegex(regex!).test('a(b')).toBe(true);
    expect(testRegex(regex!).test('abc')).toBe(false);
  });

  it('falls back to LITERAL for a zero-width pattern that would match empty', () => {
    const { regex, isLiteral } = buildSearchRegex('.*');
    expect(isLiteral).toBe(true);
    // Literal '.*' matches the exact substring only — never the empty string.
    expect(testRegex(regex!).test('a.*b')).toBe(true);
    expect(testRegex(regex!).test('anything')).toBe(false);
  });

  it('caps the term length so a pathological pattern still compiles', () => {
    const { regex } = buildSearchRegex('a'.repeat(500));
    expect(regex).not.toBeNull();
  });
});

describe('testRegex', () => {
  it('strips the global flag so repeated .test() calls do not skip', () => {
    const g = /a/giu;
    const stateless = testRegex(g);
    expect(stateless.flags).not.toContain('g');
    // A global regex's stateful lastIndex would make the 2nd test miss.
    expect(stateless.test('a')).toBe(true);
    expect(stateless.test('a')).toBe(true);
  });
});

describe('searchableText', () => {
  it('never searches event bubbles (tipo "e")', () => {
    expect(
      searchableText(m({ tipo: TIPO_MENSAGEM.evento, conteudo: 'Nova conversa iniciada' })),
    ).toBeNull();
  });

  it('prefers conteudo, then transcription, then a media caption', () => {
    expect(searchableText(m({ conteudo: 'texto' }))).toBe('texto');
    expect(searchableText(m({ conteudo: null, transcription: 'áudio transcrito' }))).toBe(
      'áudio transcrito',
    );
    expect(
      searchableText(
        m({ conteudo: null, image: { image: 'documents/arquivos/x', caption: 'foto da nota' } }),
      ),
    ).toBe('foto da nota');
    expect(
      searchableText(
        m({ conteudo: null, video: { video: 'documents/arquivos/v', caption: 'clipe' } }),
      ),
    ).toBe('clipe');
    expect(
      searchableText(
        m({
          conteudo: null,
          genericDocument: { genericDocument: 'documents/arquivos/d', caption: 'boleto.pdf' },
        }),
      ),
    ).toBe('boleto.pdf');
    expect(searchableText(m({ conteudo: null, anexoDescription: 'anexo desc' }))).toBe(
      'anexo desc',
    );
  });

  it('returns null when there is nothing to match', () => {
    expect(searchableText(m({ conteudo: '   ' }))).toBeNull();
    expect(searchableText(m({}))).toBeNull();
  });
});
