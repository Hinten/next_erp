import { afterEach, describe, expect, it } from 'vitest';
import { preserveAliasedDraft, clearDraft, draftKey, getDraft, hasDraft, setDraft } from './draft';

afterEach(() => {
  window.localStorage.clear();
});

describe('draft store', () => {
  it('keys drafts under chat:draft:<conversaId>', () => {
    expect(draftKey('c1')).toBe('chat:draft:c1');
  });

  it('round-trips set → get', () => {
    setDraft('c1', 'rascunho');
    expect(getDraft('c1')).toBe('rascunho');
    expect(hasDraft('c1')).toBe(true);
  });

  it('setDraft with empty text removes the entry (no lingering blank draft)', () => {
    setDraft('c1', 'algo');
    setDraft('c1', '');
    expect(getDraft('c1')).toBe('');
    expect(hasDraft('c1')).toBe(false);
    expect(window.localStorage.getItem(draftKey('c1'))).toBeNull();
  });

  it('clearDraft removes the entry (post-send)', () => {
    setDraft('c1', 'a enviar');
    clearDraft('c1');
    expect(hasDraft('c1')).toBe(false);
  });

  it('hasDraft is false for whitespace-only drafts', () => {
    setDraft('c1', '   ');
    expect(hasDraft('c1')).toBe(false);
  });

  it('isolates drafts per conversa', () => {
    setDraft('c1', 'um');
    setDraft('c2', 'dois');
    expect(getDraft('c1')).toBe('um');
    expect(getDraft('c2')).toBe('dois');
  });
});

describe('conversation alias draft continuity', () => {
  it('moves a draft to an empty canonical conversation', () => {
    setDraft('old', 'texto antigo');
    expect(preserveAliasedDraft('old', 'canonical')).toBe('moved');
    expect(getDraft('canonical')).toBe('texto antigo');
    expect(getDraft('old')).toBe('');
  });
  it('preserves both different drafts instead of replacing either', () => {
    setDraft('old', 'texto antigo');
    setDraft('canonical', 'texto atual');
    expect(preserveAliasedDraft('old', 'canonical')).toBe('conflict');
    expect(getDraft('old')).toBe('texto antigo');
    expect(getDraft('canonical')).toBe('texto atual');
  });
});
