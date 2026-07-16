import { describe, expect, it } from 'vitest';
import { MAX_MATCHES_PER_MESSAGE, escapeRegExp, splitHighlight } from './highlight';

function marked(segments: { text: string; match: boolean }[]): string[] {
  return segments.filter((s) => s.match).map((s) => s.text);
}

describe('splitHighlight', () => {
  it('splits a single match into literal + match + literal', () => {
    const segs = splitHighlight('hello world', /world/g);
    expect(segs).toEqual([
      { text: 'hello ', match: false },
      { text: 'world', match: true },
    ]);
  });

  it('is case-insensitive when the regex is', () => {
    const segs = splitHighlight('Olá OLÁ olá', /olá/giu);
    expect(marked(segs)).toEqual(['Olá', 'OLÁ', 'olá']);
  });

  it('handles unicode / accented matches', () => {
    const segs = splitHighlight('ação e reação', /ação/giu);
    expect(marked(segs)).toEqual(['ação', 'ação']);
  });

  it('marks adjacent matches without empty gaps', () => {
    const segs = splitHighlight('aaa', /a/g);
    expect(segs).toEqual([
      { text: 'a', match: true },
      { text: 'a', match: true },
      { text: 'a', match: true },
    ]);
  });

  it('guards a zero-width pattern (empty match) instead of looping forever', () => {
    // `a*` can match the empty string between characters — must not hang.
    const segs = splitHighlight('xbx', /a*/g);
    // No non-empty matches → the whole text is a single literal segment.
    expect(marked(segs)).toEqual([]);
    expect(segs.map((s) => s.text).join('')).toBe('xbx');
  });

  it('caps the number of marks and keeps the tail as one literal', () => {
    const text = 'a'.repeat(MAX_MATCHES_PER_MESSAGE + 10);
    const segs = splitHighlight(text, /a/g);
    expect(marked(segs)).toHaveLength(MAX_MATCHES_PER_MESSAGE);
    // The reconstructed text is unchanged (matches + literal tail).
    expect(segs.map((s) => s.text).join('')).toBe(text);
    const tail = segs[segs.length - 1]!;
    expect(tail.match).toBe(false);
  });

  it('returns [] for empty text', () => {
    expect(splitHighlight('', /a/g)).toEqual([]);
  });

  it('adds the global flag when the caller omitted it', () => {
    // A non-global regex would only match once via exec; splitHighlight forces 'g'.
    const segs = splitHighlight('a a a', /a/iu);
    expect(marked(segs)).toEqual(['a', 'a', 'a']);
  });
});

describe('escapeRegExp', () => {
  it('escapes regex metacharacters so a literal search is safe', () => {
    const escaped = escapeRegExp('a.b(c)*');
    const re = new RegExp(escaped, 'g');
    expect('a.b(c)*'.match(re)).toEqual(['a.b(c)*']);
    // The dot must be literal, not "any char".
    expect('axb(c)*'.match(re)).toBeNull();
  });
});
