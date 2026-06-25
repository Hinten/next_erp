import { describe, expect, it } from 'vitest';
import { resolveParentIds } from './useSubcollectionIdLookup';

describe('resolveParentIds', () => {
  it('dedupes parent ids preserving first-seen order', () => {
    expect(resolveParentIds(['a', 'a', 'b', 'a', 'c'], 30)).toEqual({
      ids: ['a', 'b', 'c'],
      truncated: false,
    });
  });

  it('drops blank/undefined parent ids', () => {
    expect(resolveParentIds(['a', undefined, '', 'b'], 30)).toEqual({
      ids: ['a', 'b'],
      truncated: false,
    });
  });

  it('caps at the limit and flags truncation', () => {
    // 31 distinct ids (one over the cap of 30) → 30 kept, truncated.
    const many = Array.from({ length: 31 }, (_, i) => `p${i}`);
    const { ids, truncated } = resolveParentIds(many, 30);
    expect(ids).toHaveLength(30);
    expect(truncated).toBe(true);
    expect(ids[0]).toBe('p0');
    expect(ids[29]).toBe('p29');
  });

  it('is not truncated when the count equals the cap', () => {
    const exactly = Array.from({ length: 30 }, (_, i) => `p${i}`);
    expect(resolveParentIds(exactly, 30).truncated).toBe(false);
  });

  it('returns no ids for an empty match set', () => {
    expect(resolveParentIds([], 30)).toEqual({ ids: [], truncated: false });
  });
});
