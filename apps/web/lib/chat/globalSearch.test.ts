import { describe, expect, it } from 'vitest';
import type { Mensagem } from '@delfrance/schemas';
import {
  type FetchedMensagem,
  type GlobalMatchRow,
  buildSnippet,
  groupMatches,
  matchFetched,
} from './globalSearch';

function fetched(
  conversaId: string,
  mensagemId: string,
  timestamp: number,
  mensagem: Partial<Mensagem>,
): FetchedMensagem {
  return {
    conversaId,
    mensagemId,
    timestamp,
    mensagem: { tipo: 'c', conteudo: null, ...mensagem } as Mensagem,
  };
}

describe('matchFetched', () => {
  const docs: FetchedMensagem[] = [
    fetched('c1', 'm1', 30, { conteudo: 'preciso do orçamento hoje' }),
    fetched('c1', 'm2', 20, { conteudo: 'sem relação' }),
    fetched('c2', 'm3', 25, { tipo: 'e', conteudo: 'orçamento aberto' }), // event → skipped
    fetched('c2', 'm4', 10, { conteudo: null, transcription: 'segue o orçamento gravado' }),
  ];

  it('keeps only docs whose searchable text matches, preserving order', () => {
    const rows = matchFetched(docs, /orçamento/iu);
    expect(rows.map((r) => r.mensagemId)).toEqual(['m1', 'm4']); // m3 event skipped
    expect(rows[0]).toMatchObject({ conversaId: 'c1', timestamp: 30 });
    expect(rows[1]).toMatchObject({ conversaId: 'c2', text: 'segue o orçamento gravado' });
  });

  it('is case-insensitive via the supplied regex flags', () => {
    expect(matchFetched(docs, /ORÇAMENTO/iu)).toHaveLength(2);
  });

  it('does not skip on a repeated match (global regex lastIndex reset)', () => {
    // Two consecutive matching docs must both survive even with a 'g' regex.
    const rows = matchFetched(
      [fetched('c1', 'a', 2, { conteudo: 'foo' }), fetched('c1', 'b', 1, { conteudo: 'foo' })],
      /foo/giu,
    );
    expect(rows.map((r) => r.mensagemId)).toEqual(['a', 'b']);
  });
});

describe('groupMatches', () => {
  it('groups by conversa, newest-match first, matches newest-first within', () => {
    // Rows arrive newest-first (the group query is orderBy timestamp desc).
    const rows: GlobalMatchRow[] = [
      { conversaId: 'c1', mensagemId: 'm1', timestamp: 50, text: 'a' },
      { conversaId: 'c2', mensagemId: 'm2', timestamp: 40, text: 'b' },
      { conversaId: 'c1', mensagemId: 'm3', timestamp: 30, text: 'c' },
    ];
    const groups = groupMatches(rows);
    expect(groups.map((g) => g.conversaId)).toEqual(['c1', 'c2']);
    expect(groups[0]!.matches.map((r) => r.mensagemId)).toEqual(['m1', 'm3']);
    expect(groups[0]!.newestTimestamp).toBe(50);
    expect(groups[1]!.newestTimestamp).toBe(40);
  });

  it('does not let a null timestamp clobber a real newestTimestamp', () => {
    const rows: GlobalMatchRow[] = [
      { conversaId: 'c1', mensagemId: 'm1', timestamp: null, text: 'a' },
      { conversaId: 'c1', mensagemId: 'm2', timestamp: 42, text: 'b' },
    ];
    expect(groupMatches(rows)[0]!.newestTimestamp).toBe(42);
  });

  it('returns [] for no rows', () => {
    expect(groupMatches([])).toEqual([]);
  });
});

describe('buildSnippet', () => {
  it('truncates ±radius around the first match and flags both ellipses', () => {
    const text = `${'x'.repeat(100)}ALVO${'y'.repeat(100)}`;
    const snippet = buildSnippet(text, /ALVO/iu, 10);
    expect(snippet.prefixEllipsis).toBe(true);
    expect(snippet.suffixEllipsis).toBe(true);
    expect(snippet.text).toContain('ALVO');
    // 10 chars each side + the 4-char match.
    expect(snippet.text).toBe(`${'x'.repeat(10)}ALVO${'y'.repeat(10)}`);
  });

  it('does not flag an ellipsis when the match sits at an edge', () => {
    const snippet = buildSnippet('ALVO aqui', /ALVO/iu, 60);
    expect(snippet.prefixEllipsis).toBe(false);
    expect(snippet.suffixEllipsis).toBe(false);
    expect(snippet.text).toBe('ALVO aqui');
  });

  it('centres on the FIRST match when several exist', () => {
    const snippet = buildSnippet('aaa TARGET bbb TARGET ccc', /TARGET/iu, 3);
    // Window is around the first TARGET (index 4): 3 chars before + match + 3 after.
    expect(snippet.text).toBe('aa TARGET bb');
    expect(snippet.prefixEllipsis).toBe(true);
    expect(snippet.suffixEllipsis).toBe(true);
  });
});
