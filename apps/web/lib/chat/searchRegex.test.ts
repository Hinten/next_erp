import { describe, expect, it } from 'vitest';
import { TIPO_MENSAGEM } from '@delfrance/schemas';

import {
  buildSearchRegex,
  foldSearchText,
  searchableText,
  searchRegexMatches,
} from './searchRegex';

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
    expect(searchRegexMatches(regex!, 'bem, OLÁ mundo')).toBe(true);
  });

  it('supports unicode / accented regex patterns', () => {
    const { regex } = buildSearchRegex('reação');
    expect(searchRegexMatches(regex!, 'ação e reação')).toBe(true);
  });

  it('matches accents in either direction while preserving regex syntax', () => {
    const plain = buildSearchRegex('^a(c|ç)ao$').regex!;
    const accented = buildSearchRegex('^ação$').regex!;

    expect(searchRegexMatches(plain, 'AÇÃO')).toBe(true);
    expect(searchRegexMatches(accented, 'acao')).toBe(true);
    expect(searchRegexMatches(/^\p{L}+(cao|ção)$/iu, 'reação')).toBe(true);
    // The exact pass remains active, so a specialized regex that targets the
    // decomposed mark itself keeps its pre-fold semantics.
    expect(searchRegexMatches(/\p{M}/u, 'a\u0301')).toBe(true);
  });

  it('folds accents only and keeps near-miss punctuation and letters distinct', () => {
    const { regex } = buildSearchRegex('^acao$');

    expect(searchRegexMatches(regex!, 'ação')).toBe(true);
    expect(searchRegexMatches(regex!, 'a-ção')).toBe(false);
    expect(searchRegexMatches(regex!, 'acaso')).toBe(false);
  });

  it('falls back to a LITERAL search on an invalid (SyntaxError) pattern', () => {
    const { regex, isLiteral } = buildSearchRegex('(');
    expect(isLiteral).toBe(true);
    // The literal '(' is escaped, so it matches a real paren and nothing else.
    expect(searchRegexMatches(regex!, 'a(b')).toBe(true);
    expect(searchRegexMatches(regex!, 'abc')).toBe(false);
  });

  it('falls back to LITERAL for a zero-width pattern that would match empty', () => {
    const { regex, isLiteral } = buildSearchRegex('.*');
    expect(isLiteral).toBe(true);
    // Literal '.*' matches the exact substring only — never the empty string.
    expect(searchRegexMatches(regex!, 'a.*b')).toBe(true);
    expect(searchRegexMatches(regex!, 'anything')).toBe(false);
  });

  it('caps the term length so a pathological pattern still compiles', () => {
    const { regex } = buildSearchRegex('a'.repeat(500));
    expect(regex).not.toBeNull();
  });
});

describe('searchRegexMatches', () => {
  it('is stateless when repeated with a global regex', () => {
    const g = /a/giu;
    // A global regex's stateful lastIndex would make the 2nd test miss.
    expect(searchRegexMatches(g, 'á')).toBe(true);
    expect(searchRegexMatches(g, 'á')).toBe(true);
  });

  it('preserves a specialized original-regex match while adding the fold', () => {
    // The original pass still sees a separately encoded combining mark.
    expect(searchRegexMatches(/\p{M}/u, 'a\u0303')).toBe(true);
    // The folded pass adds the ordinary unaccented search.
    expect(searchRegexMatches(/^a$/u, 'a\u0303')).toBe(true);
  });
});

describe('foldSearchText', () => {
  it('treats precomposed and decomposed accents alike without folding punctuation', () => {
    expect(foldSearchText('AÇÃO')).toBe('ACAO');
    expect(foldSearchText('ac\u0327a\u0303o')).toBe('acao');
    expect(foldSearchText('a-ção')).toBe('a-cao');
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
