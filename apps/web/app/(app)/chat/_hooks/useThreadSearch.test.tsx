import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Mensagem } from '@delfrance/schemas';
import { TIPO_MENSAGEM } from '@delfrance/schemas';
import { useThreadSearch } from './useThreadSearch';
import type { ServerMensagem } from './useMensagensWindow';

function msg(id: string, partial: Partial<Mensagem>): ServerMensagem {
  return {
    _id: id,
    estadoEnvio: 7,
    tipo: TIPO_MENSAGEM.comum,
    conteudo: null,
    resposta: null,
    canal: 0,
    usarioMensagemOuterRef: null,
    user_id: null,
    urlAvatar: null,
    mid: null,
    midGroup: null,
    error: null,
    visualizado: null,
    transcription: null,
    anexo: null,
    anexo_url: null,
    timestamp: 1,
    ...partial,
  } as ServerMensagem;
}

const messages: ServerMensagem[] = [
  msg('m1', { conteudo: 'Olá, tudo bem?' }),
  msg('m2', { conteudo: 'ação e reação' }),
  msg('m3', { tipo: TIPO_MENSAGEM.evento, conteudo: 'Nova conversa iniciada' }), // event — never matched
  msg('m4', { conteudo: null, transcription: 'áudio transcrito aqui' }),
  msg('m5', { conteudo: null, image: { image: 'documents/arquivos/x', caption: 'foto da nota' } }),
];

describe('useThreadSearch', () => {
  it('returns no regex and no matches for an empty term', () => {
    const { result } = renderHook(() => useThreadSearch('', messages));
    expect(result.current.regex).toBeNull();
    expect(result.current.total).toBe(0);
    expect(result.current.currentId).toBeNull();
  });

  it('matches conteudo case-insensitively', () => {
    const { result } = renderHook(() => useThreadSearch('OLÁ', messages));
    expect(result.current.isLiteral).toBe(false);
    expect(result.current.matches).toEqual(['m1']);
  });

  it('matches over transcription and media caption, skipping event messages', () => {
    const { result } = renderHook(() => useThreadSearch('a', messages));
    // 'a' (regex 'iu', NOT accent-folded) hits m2 (ação), m4 (transcrito/aqui),
    // m5 (foto da nota). Event m3 is skipped even though it contains 'a';
    // m1 ("Olá, tudo bem?") has only an accented 'á', so it does NOT match.
    expect(result.current.matches).not.toContain('m3');
    expect(result.current.matches).not.toContain('m1');
    expect(result.current.matches).toContain('m4'); // transcription
    expect(result.current.matches).toContain('m5'); // caption
  });

  it('supports unicode/accented regex patterns', () => {
    const { result } = renderHook(() => useThreadSearch('reação', messages));
    expect(result.current.matches).toEqual(['m2']);
  });

  it('falls back to a literal search on an invalid regex', () => {
    // An unclosed group is a SyntaxError → literal fallback.
    const { result } = renderHook(() => useThreadSearch('(', messages));
    expect(result.current.isLiteral).toBe(true);
    // The literal '(' matches nothing in the fixtures → 0 hits, no throw.
    expect(result.current.total).toBe(0);
  });

  it('falls back to literal for a zero-width pattern that would match empty', () => {
    const { result } = renderHook(() => useThreadSearch('.*', messages));
    expect(result.current.isLiteral).toBe(true);
    // Literal '.*' matches nothing → 0 hits (guard prevented an empty-match storm).
    expect(result.current.total).toBe(0);
  });

  it('navigates next/prev with wraparound and tracks currentId', () => {
    const { result } = renderHook(() => useThreadSearch('a', messages));
    const total = result.current.total;
    expect(total).toBeGreaterThan(1);
    expect(result.current.currentIndex).toBe(0);
    const first = result.current.currentId;

    act(() => result.current.next());
    expect(result.current.currentIndex).toBe(1);

    // Wrap back to the start from the last item.
    act(() => result.current.prev());
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.currentId).toBe(first);

    act(() => result.current.prev());
    expect(result.current.currentIndex).toBe(total - 1);
  });

  it('keeps the active match on the SAME message when an older page prepends', () => {
    const withText = (id: string, text: string) => msg(id, { conteudo: text });
    const initial = [withText('b1', 'match one'), withText('b2', 'match two')];
    const { result, rerender } = renderHook(
      ({ msgs }: { msgs: ServerMensagem[] }) => useThreadSearch('match', msgs),
      { initialProps: { msgs: initial } },
    );
    expect(result.current.matches).toEqual(['b1', 'b2']);
    expect(result.current.currentId).toBe('b1');

    // Navigate to the second match, then prepend an OLDER matching message.
    act(() => result.current.next());
    expect(result.current.currentId).toBe('b2');
    expect(result.current.currentIndex).toBe(1);

    rerender({ msgs: [withText('b0', 'match zero'), ...initial] });

    // The active match is still b2 (tracked by stable key), now shifted to index
    // 2 — a positional index would have wrongly kept b1 selected.
    expect(result.current.matches).toEqual(['b0', 'b1', 'b2']);
    expect(result.current.currentId).toBe('b2');
    expect(result.current.currentIndex).toBe(2);
  });

  it('falls back to the nearest match when the active message ages out', () => {
    const withText = (id: string, text: string) => msg(id, { conteudo: text });
    const initial = [withText('c1', 'hit a'), withText('c2', 'hit b'), withText('c3', 'hit c')];
    const { result, rerender } = renderHook(
      ({ msgs }: { msgs: ServerMensagem[] }) => useThreadSearch('hit', msgs),
      { initialProps: { msgs: initial } },
    );
    act(() => result.current.next());
    act(() => result.current.next());
    expect(result.current.currentId).toBe('c3'); // index 2

    // c3 ages out of the window → fall back to the nearest prior index (clamped),
    // not a jump back to the top.
    rerender({ msgs: [withText('c1', 'hit a'), withText('c2', 'hit b')] });
    expect(result.current.currentId).toBe('c2');
    expect(result.current.currentIndex).toBe(1);
  });

  it('caps the search-term length so a pathological pattern never hangs', () => {
    // A 500-char term is truncated to 200 before compiling; it still yields a
    // usable (compiled) regex and returns without throwing/hanging.
    const { result } = renderHook(() => useThreadSearch('a'.repeat(500), messages));
    expect(result.current.regex).not.toBeNull();
    expect(typeof result.current.total).toBe('number');
  });
});
