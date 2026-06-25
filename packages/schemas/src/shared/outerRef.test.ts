import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  docIdSchema,
  idFromRef,
  idRefSchema,
  outerRefLooseSchema,
  outerRefSchema,
  parseRef,
  toOuterRef,
} from './outerRef';

// [input, loose, canonical, idRef, docId]
const MATRIX: Array<[string, boolean, boolean, boolean, boolean]> = [
  ['documents/col/id', true, true, false, false],
  ['col/id', true, false, true, false],
  ['documents/col/id/sub/subid', true, true, false, false],
  ['bareId', false, false, false, true],
  ['', false, false, false, false],
];

describe('outerRef schemas', () => {
  for (const [input, loose, canonical, idRef, docId] of MATRIX) {
    it(`"${input}" → loose:${loose} canonical:${canonical} idRef:${idRef} docId:${docId}`, () => {
      expect(outerRefLooseSchema.safeParse(input).success).toBe(loose);
      expect(outerRefSchema.safeParse(input).success).toBe(canonical);
      expect(idRefSchema.safeParse(input).success).toBe(idRef);
      expect(docIdSchema.safeParse(input).success).toBe(docId);
    });
  }

  it('idRefSchema rejects a documents/-prefixed two-segment path', () => {
    expect(idRefSchema.safeParse('documents/col').success).toBe(false);
  });

  it('outerRefSchema rejects an odd-segment path that ends on a collection', () => {
    // `documents/clientes/C1/enderecos` is not a dereferenceable document path.
    expect(outerRefSchema.safeParse('documents/clientes/C1/enderecos').success).toBe(false);
    expect(outerRefSchema.safeParse('documents/clientes/C1/enderecos/E1').success).toBe(true);
  });

  it('stays .pick()-able when embedded as a field (no Zod 4 refinement crash)', () => {
    const obj = z.object({ ref: outerRefSchema, other: z.string() });
    expect(() => obj.pick({ ref: true })).not.toThrow();
  });
});

describe('outerRef helpers', () => {
  it('toOuterRef normalizes every accepted form to documents/<col>/<id>', () => {
    expect(toOuterRef('documents/col/id')).toBe('documents/col/id');
    expect(toOuterRef('col/id')).toBe('documents/col/id');
    expect(toOuterRef('documents/col/id/sub/subid')).toBe('documents/col/id/sub/subid');
  });

  it('toOuterRef throws when the input cannot form a valid document path', () => {
    expect(() => toOuterRef('bareId')).toThrow();
  });

  it('idFromRef returns the last path segment', () => {
    expect(idFromRef('documents/clientes/C1')).toBe('C1');
    expect(idFromRef('clientes/C1')).toBe('C1');
    expect(idFromRef('documents/clientes/C1/enderecos/E1')).toBe('E1');
  });

  it('parseRef returns the owning collection and id', () => {
    expect(parseRef('documents/clientes/C1')).toEqual({ collection: 'clientes', id: 'C1' });
    expect(parseRef('operacao/op1')).toEqual({ collection: 'operacao', id: 'op1' });
    expect(parseRef('documents/clientes/C1/enderecos/E1')).toEqual({
      collection: 'enderecos',
      id: 'E1',
    });
  });
});
