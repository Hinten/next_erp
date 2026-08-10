import { describe, expect, it } from 'vitest';
import { PREFIXO_CANONICO, planDepositoOuterRef } from './transform';

describe('planDepositoOuterRef', () => {
  it('leaves the canonical form alone (idempotence)', () => {
    expect(planDepositoOuterRef('documents/depositos/dep1')).toEqual({ kind: 'ja-canonico' });
  });

  it('normalizes the bare form the outerRef invariant tolerates', () => {
    expect(planDepositoOuterRef('depositos/dep1')).toEqual({
      kind: 'normalizado',
      de: 'depositos/dep1',
      para: 'documents/depositos/dep1',
    });
  });

  it('preserves a depósito id containing hyphens and dots', () => {
    // Ids are opaque: nothing may be split, trimmed or re-cased on the way
    // through. Only the prefix changes.
    const id = 'dep-2026.01_A';
    expect(planDepositoOuterRef(`depositos/${id}`)).toMatchObject({
      para: `${PREFIXO_CANONICO}${id}`,
    });
  });

  it('treats absent and null as nothing to do (both nullable collections)', () => {
    expect(planDepositoOuterRef(undefined)).toEqual({ kind: 'ausente' });
    expect(planDepositoOuterRef(null)).toEqual({ kind: 'ausente' });
  });

  describe('reports rather than guesses', () => {
    // The whole point of the verdict type: an unrecognized ref stays untouched.
    // Rewriting one would turn a visible data problem into a plausible-looking
    // wrong pointer.
    it.each([
      ['a non-string', 42],
      ['an empty string', ''],
      ['a ref to another collection', 'documents/filiais/f1'],
      ['a bare ref to another collection', 'filiais/f1'],
      ['the canonical prefix with no id', 'documents/depositos/'],
      ['the bare prefix with no id', 'depositos/'],
      ['a bare ref with a nested path', 'depositos/dep1/sub/x'],
    ])('%s', (_label, valor) => {
      expect(planDepositoOuterRef(valor)).toMatchObject({ kind: 'desconhecido', valor });
    });
  });

  it('a canonical ref with a nested path is left as canonical, not rewritten', () => {
    // Only the BARE branch rejects a nested path — there it would be ambiguous
    // which segment is the id. A canonical value is already in the target form,
    // so this pass has nothing to say about its tail.
    expect(planDepositoOuterRef('documents/depositos/dep1/sub')).toEqual({ kind: 'ja-canonico' });
  });

  it('is a fixed point: normalizing twice changes nothing', () => {
    const primeiro = planDepositoOuterRef('depositos/dep1');
    if (primeiro.kind !== 'normalizado') throw new Error('esperava normalizado');
    expect(planDepositoOuterRef(primeiro.para)).toEqual({ kind: 'ja-canonico' });
  });
});
