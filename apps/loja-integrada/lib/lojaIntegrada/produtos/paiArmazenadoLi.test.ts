import { describe, expect, it } from 'vitest';

import { paiArmazenadoLi } from './paiArmazenadoLi';

describe('paiArmazenadoLi — a stored paiId as a parent id', () => {
  it('a non-empty string is the parent id, verbatim', () => {
    expect(paiArmazenadoLi({ paiId: 'pai-1' })).toBe('pai-1');
    // Verbatim: nothing is trimmed or folded.
    expect(paiArmazenadoLi({ paiId: ' pai-1' })).toBe(' pai-1');
  });

  it.each([
    ['absent', {}],
    ['null', { paiId: null }],
    ["'' (a legacy root's spelling)", { paiId: '' }],
    ['a number', { paiId: 7 }],
    ['an object', { paiId: { id: 'pai-1' } }],
  ])('⚠️ NEAR-MISS: %s is no parent', (_caso, dados) => {
    expect(paiArmazenadoLi(dados)).toBeNull();
  });
});
