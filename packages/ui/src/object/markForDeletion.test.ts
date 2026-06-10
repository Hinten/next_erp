import { describe, expect, it } from 'vitest';
import { DELETE_MARK, stripMarkedForDeletion } from './markForDeletion';

describe('stripMarkedForDeletion', () => {
  it('drops items flagged for deletion', () => {
    const input = [{ id: 'a' }, { id: 'b', [DELETE_MARK]: true }, { id: 'c' }];
    expect(stripMarkedForDeletion(input)).toEqual([{ id: 'a' }, { id: 'c' }]);
  });

  it('strips the transient marker from surviving items (deep-equality has no marker key)', () => {
    const input = [{ id: 'a', [DELETE_MARK]: false }];
    expect(stripMarkedForDeletion(input)).toEqual([{ id: 'a' }]);
  });

  it('returns non-array values untouched', () => {
    expect(stripMarkedForDeletion(null)).toBeNull();
    expect(stripMarkedForDeletion('x')).toBe('x');
  });
});
