import { describe, expect, it } from 'vitest';

import { type CacheKey, cacheKeyOf, queryCacheKey } from './cacheKey';

describe('cacheKeyOf', () => {
  it('type-tags every leaf', () => {
    expect(cacheKeyOf('abc')).toBe('s:abc');
    expect(cacheKeyOf(42)).toBe('n:42');
    expect(cacheKeyOf(true)).toBe('b:true');
    expect(cacheKeyOf(null)).toBe('z:null');
    expect(cacheKeyOf(undefined)).toBe('z:undefined');
    expect(cacheKeyOf(['integracao', 7])).toBe('[s:integracao|n:7]');
    expect(cacheKeyOf([])).toBe('[]');
  });

  it('is deterministic', () => {
    expect(cacheKeyOf(['a', ['b', 1], null])).toBe(cacheKeyOf(['a', ['b', 1], null]));
  });

  /**
   * A collision is a silently WRONG cached value, not a miss, so this is the
   * property that matters most. Each pair below collides under a naive
   * `join('|')` or under `JSON.stringify`.
   */
  const COLLISION_PAIRS: Array<[string, CacheKey, CacheKey]> = [
    ['number vs its string', 1, '1'],
    ['boolean vs its string', true, 'true'],
    ['null vs its string', null, 'null'],
    ['undefined vs null', undefined, null],
    ['separator inside a leaf vs two leaves', ['a|b'], ['a', 'b']],
    ['tagged separator inside a leaf vs two leaves', ['s:a|s:b'], ['s:a', 'b']],
    ['nested tuple vs its rendering', [['a']], ['[s:a]']],
    ['tuple vs its single element', ['a'], 'a'],
    ['escape character is not a free pass', ['a\\|b'], ['a\\', 'b']],
    ['empty tuple vs empty string', [], ''],
    ['arity matters', ['a', ''], ['a']],
  ];

  it.each(COLLISION_PAIRS)('distinguishes %s', (_label, left, right) => {
    expect(cacheKeyOf(left)).not.toBe(cacheKeyOf(right));
  });

  it('escapes the four structural characters inside a leaf', () => {
    expect(cacheKeyOf('a|b')).toBe('s:a\\|b');
    expect(cacheKeyOf('a\\b')).toBe('s:a\\\\b');
    expect(cacheKeyOf('[a]')).toBe('s:\\[a\\]');
  });

  it('folds -0 into 0 and every NaN together (documented, harmless for Firestore keys)', () => {
    expect(cacheKeyOf(-0)).toBe(cacheKeyOf(0));
    expect(cacheKeyOf(Number.NaN)).toBe('n:NaN');
  });
});

describe('queryCacheKey', () => {
  it('namespaces by collection path so two queries cannot share a key', () => {
    expect(queryCacheKey('integracao', 'mercadoLivre', 123, true)).toBe(
      '[s:integracao|s:mercadoLivre|n:123|b:true]',
    );
    expect(queryCacheKey('integracao', 123)).not.toBe(queryCacheKey('metodo_pgto', 123));
  });

  it('separates the path from the first predicate value', () => {
    // Without the tuple wrapper these two would both read `integracao/x`.
    expect(queryCacheKey('integracao', 'x')).not.toBe(queryCacheKey('integracao/x'));
  });
});
