import { describe, expect, it } from 'vitest';
import { stripKitForSave } from './KitManager';

describe('stripKitForSave', () => {
  it('drops _delete entries and the transient marker, keeping a clean record', () => {
    const out = stripKitForSave({
      a: { quantidade: 2, limitarEstoque: true, timestamp: null },
      b: { quantidade: 1, limitarEstoque: false, timestamp: null, _delete: true },
    });
    expect(out).toEqual({ a: { quantidade: 2, limitarEstoque: true, timestamp: null } });
  });

  it('returns null for an empty or fully-deleted map', () => {
    expect(stripKitForSave(null)).toBeNull();
    expect(stripKitForSave({})).toBeNull();
    expect(
      stripKitForSave({
        a: { quantidade: 1, limitarEstoque: true, timestamp: null, _delete: true },
      }),
    ).toBeNull();
  });
});
