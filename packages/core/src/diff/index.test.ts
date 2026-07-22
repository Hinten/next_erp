import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_VALUE_BYTES, TRUNCATED_VALUE_KEY, diffDocumentFields } from './index';

describe('diffDocumentFields', () => {
  it('returns null when both sides are undefined', () => {
    expect(diffDocumentFields(undefined, undefined)).toBeNull();
  });

  it('returns null when nothing changed', () => {
    expect(diffDocumentFields({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toBeNull();
  });

  it('derives kind "create" when before is undefined', () => {
    const diff = diffDocumentFields(undefined, { a: 1 });
    expect(diff?.kind).toBe('create');
    expect(diff?.campos).toEqual(['a']);
    expect(diff?.changes.a).toEqual({ old: null, new: 1 });
  });

  it('derives kind "delete" when after is undefined', () => {
    const diff = diffDocumentFields({ a: 1 }, undefined);
    expect(diff?.kind).toBe('delete');
    expect(diff?.campos).toEqual(['a']);
    expect(diff?.changes.a).toEqual({ old: 1, new: null });
  });

  it('derives kind "update" when both sides are defined', () => {
    const diff = diffDocumentFields({ a: 1 }, { a: 2 });
    expect(diff?.kind).toBe('update');
  });

  it('skips fields listed in opts.ignore', () => {
    const diff = diffDocumentFields({ a: 1, b: 2 }, { a: 1, b: 3 }, { ignore: ['b'] });
    expect(diff).toBeNull();
  });

  it('skips fields that are structurally (deep) equal via valuesEqual', () => {
    const diff = diffDocumentFields(
      { a: { nested: [1, 2, { c: 3 }] }, b: 1 },
      { a: { nested: [1, 2, { c: 3 }] }, b: 2 },
    );
    expect(diff?.campos).toEqual(['b']);
  });

  it('sorts campos ascending regardless of key insertion order', () => {
    const diff = diffDocumentFields({ z: 1, a: 1, m: 1 }, { z: 2, a: 2, m: 2 });
    expect(diff?.campos).toEqual(['a', 'm', 'z']);
  });

  it('coerces undefined to null on both sides', () => {
    const added = diffDocumentFields({}, { a: 1 });
    expect(added?.changes.a).toEqual({ old: null, new: 1 });

    const removed = diffDocumentFields({ a: 1 }, {});
    expect(removed?.changes.a).toEqual({ old: 1, new: null });
  });

  it('records an added field within an update (old absent)', () => {
    const diff = diffDocumentFields({ a: 1 }, { a: 1, b: 2 });
    expect(diff?.kind).toBe('update');
    expect(diff?.campos).toEqual(['b']);
    expect(diff?.changes.b).toEqual({ old: null, new: 2 });
  });

  it('records a removed field within an update (new absent)', () => {
    const diff = diffDocumentFields({ a: 1, b: 2 }, { a: 1 });
    expect(diff?.kind).toBe('update');
    expect(diff?.campos).toEqual(['b']);
    expect(diff?.changes.b).toEqual({ old: 2, new: null });
  });

  it('handles bigint values without throwing, reporting changes and stable values', () => {
    expect(diffDocumentFields({ a: 1n }, { a: 1n })).toBeNull();

    const diff = diffDocumentFields({ a: 1n }, { a: 2n });
    expect(diff?.changes.a).toEqual({ old: 1n, new: 2n });
  });

  it('truncates a value whose JSON encoding exceeds maxValueBytes', () => {
    const before = { a: 'short' };
    const after = { a: 'x'.repeat(100) };
    const diff = diffDocumentFields(before, after, { maxValueBytes: 20 });

    expect(diff?.changes.a?.old).toBe('short');
    expect(diff?.changes.a?.new).toMatchObject({ [TRUNCATED_VALUE_KEY]: true });
    const truncated = diff?.changes.a?.new as { _bytes: number };
    expect(truncated._bytes).toBeGreaterThan(20);
  });

  it('uses DEFAULT_MAX_VALUE_BYTES when no override is given', () => {
    const huge = 'x'.repeat(DEFAULT_MAX_VALUE_BYTES + 1);
    const diff = diffDocumentFields({ a: 'small' }, { a: huge });
    expect(diff?.changes.a?.new).toMatchObject({ [TRUNCATED_VALUE_KEY]: true });
  });

  it('truncates with _bytes: -1 when the value cannot be JSON-serialized (circular)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const diff = diffDocumentFields({ a: null }, { a: circular });
    expect(diff?.changes.a?.new).toEqual({ [TRUNCATED_VALUE_KEY]: true, _bytes: -1 });
  });

  it('returns null when the only differing fields are all ignored', () => {
    const diff = diffDocumentFields(
      { keep: 1, drop1: 'x', drop2: 'y' },
      { keep: 1, drop1: 'z', drop2: 'w' },
      { ignore: ['drop1', 'drop2'] },
    );
    expect(diff).toBeNull();
  });
});
